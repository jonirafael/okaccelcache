import { DEFAULT_PREFIX, REDIS_TTL_BUFFER_MS } from '../constants'
import { assertKeyPrefix } from '../validate'
import type { CacheRead, CacheStore, StoredEntry } from '../types'

/**
 * The Redis commands this package uses.
 * Adapters for ioredis and node-redis sit on top of this so neither package is imported here.
 */
export interface RedisCommands {
  get(key: string): Promise<string | null>
  setPx(key: string, value: string, px: number): Promise<void>
  /** SET key value PX px NX. True when this caller acquired the key. */
  setNxPx(key: string, value: string, px: number): Promise<boolean>
  mget(keys: string[]): Promise<Array<string | null>>
  incr(key: string): Promise<number>
  del(keys: string[]): Promise<void>
  scan(cursor: string, pattern: string, count: number): Promise<{ cursor: string; keys: string[] }>
}

export interface RedisStoreOptions {
  /**
   * Prefix for entry keys, generation counters, and locks in this Redis database.
   * Keep it aligned with `withOkAccelCache({ keyPrefix })` so `invalidateAll` deletes those entries.
   * @default "okaccelcache"
   */
  prefix?: string
}

/**
 * Minimal ioredis surface. A real `Redis` instance from the `ioredis` package satisfies it.
 * Declared here so `ioredis` stays an optional peer dependency.
 */
export interface IoredisLike {
  get(key: string): Promise<string | null>
  set(key: string, value: string, expiryMode: 'PX', time: number, setMode?: 'NX'): Promise<'OK' | null>
  mget(...keys: string[]): Promise<Array<string | null>>
  incr(key: string): Promise<number>
  del(...keys: string[]): Promise<number>
  scan(
    cursor: string | number,
    matchToken: 'MATCH',
    pattern: string,
    countToken: 'COUNT',
    count: number,
  ): Promise<[string, string[]]>
}

/**
 * Minimal node-redis v4 surface (`redis` on npm). A client from `createClient` satisfies it.
 */
export interface NodeRedisLike {
  get(key: string): Promise<string | null>
  set(key: string, value: string, options?: { PX?: number; NX?: boolean }): Promise<string | null>
  mGet(keys: string[]): Promise<Array<string | null>>
  incr(key: string): Promise<number>
  del(keys: string[]): Promise<number>
  scan(cursor: string, options: { MATCH: string; COUNT: number }): Promise<{ cursor: string | number; keys: string[] }>
}

export function createIoredisStore(client: IoredisLike, options?: RedisStoreOptions): CacheStore {
  return createRedisStore(adaptIoredis(client), options)
}

/**
 * `client` is a connected node-redis v4 client from `createClient`.
 * The parameter is any object because that package overloads `set`; the client
 * still needs `get`, `set` (with `{ PX, NX }`), `mGet`, `incr`, `del`, and `scan`.
 */
export function createNodeRedisStore(client: object, options?: RedisStoreOptions): CacheStore {
  return createRedisStore(adaptNodeRedis(client as NodeRedisLike), options)
}

export function createRedisStore(commands: RedisCommands, options: RedisStoreOptions = {}): CacheStore {
  const prefix = assertKeyPrefix(options.prefix ?? DEFAULT_PREFIX)
  const dataPrefix = `${prefix}:data:`
  const genAllKey = `${prefix}:gen:all`
  const tagKey = (tag: string) => `${prefix}:gen:tag:${tag}`
  const lockKey = (key: string) => `${prefix}:lock:${key}`

  return {
    async read(key, tags) {
      const [raw, allRaw] = await Promise.all([commands.get(dataPrefix + key), commands.get(genAllKey)])
      const entry = decodeEntry(raw)
      const names = new Set<string>(tags)
      if (entry) {
        for (const tag of entry.tags) names.add(tag)
      }
      const list = [...names]
      const values = list.length === 0 ? [] : await commands.mget(list.map((tag) => tagKey(tag)))
      const tagGenerations: Record<string, number> = {}
      list.forEach((tag, index) => {
        tagGenerations[tag] = parseGeneration(values[index])
      })
      return {
        entry,
        allGeneration: parseGeneration(allRaw),
        tagGenerations,
      } satisfies CacheRead
    },

    async write(key, entry) {
      const px = Math.max(1000, entry.ttlMs + entry.swrMs + REDIS_TTL_BUFFER_MS)
      await commands.setPx(dataPrefix + key, JSON.stringify({ v: 1, entry }), px)
    },

    async invalidateTags(tags) {
      await Promise.all(tags.map((tag) => commands.incr(tagKey(tag))))
    },

    async invalidateAll() {
      await commands.incr(genAllKey)
      let cursor = '0'
      do {
        const page = await commands.scan(cursor, `${dataPrefix}*`, 200)
        cursor = page.cursor
        if (page.keys.length > 0) await commands.del(page.keys)
      } while (cursor !== '0')
    },

    async tryLock(key, ttlMs) {
      return commands.setNxPx(lockKey(key), '1', Math.max(1, Math.floor(ttlMs)))
    },
  }
}

function adaptIoredis(client: IoredisLike): RedisCommands {
  return {
    get: (key) => client.get(key),
    async setPx(key, value, px) {
      await client.set(key, value, 'PX', px)
    },
    async setNxPx(key, value, px) {
      const result = await client.set(key, value, 'PX', px, 'NX')
      return result === 'OK'
    },
    mget: (keys) => client.mget(...keys),
    incr: (key) => client.incr(key),
    async del(keys) {
      if (keys.length === 0) return
      for (const chunk of chunks(keys, 500)) await client.del(...chunk)
    },
    async scan(cursor, pattern, count) {
      const [next, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', count)
      return { cursor: String(next), keys }
    },
  }
}

function adaptNodeRedis(client: NodeRedisLike): RedisCommands {
  return {
    get: (key) => client.get(key),
    async setPx(key, value, px) {
      await client.set(key, value, { PX: px })
    },
    async setNxPx(key, value, px) {
      const result = await client.set(key, value, { PX: px, NX: true })
      return result === 'OK'
    },
    mget: (keys) => client.mGet(keys),
    incr: (key) => client.incr(key),
    async del(keys) {
      if (keys.length === 0) return
      for (const chunk of chunks(keys, 500)) await client.del(chunk)
    },
    async scan(cursor, pattern, count) {
      const page = await client.scan(cursor, { MATCH: pattern, COUNT: count })
      return { cursor: String(page.cursor), keys: page.keys }
    },
  }
}

function decodeEntry(raw: string | null): StoredEntry | null {
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as { v?: unknown; entry?: StoredEntry }
    if (parsed.v !== 1 || !parsed.entry || typeof parsed.entry.payload !== 'string') return null
    return parsed.entry
  } catch {
    return null
  }
}

function parseGeneration(value: string | null | undefined): number {
  if (value == null) return 0
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const output: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size))
  }
  return output
}
