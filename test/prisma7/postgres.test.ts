import { createClient } from 'redis'
import Redis from 'ioredis'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { OkAccelCacheError, createIoredisStore, createMemoryStore, createNodeRedisStore, withOkAccelCache } from 'okaccelcache'

import { Prisma } from './generated/postgres/client'
import { applySchema, canConnect, createBaseClient, postgresUrl, selectCount, waitFor } from './postgres-client'

const clock = { now: 1_700_000_000_000 }
const storeErrors: unknown[] = []
const backgroundErrors: unknown[] = []
const url = postgresUrl()
let postgresReady = false

const { base, queries } = createBaseClient(url)
const store = createMemoryStore({ maxEntries: 50, now: () => clock.now })
const prisma = base.$extends(
  withOkAccelCache({
    store,
    now: () => clock.now,
    onBackgroundError: (error) => {
      backgroundErrors.push(error)
    },
    onStoreError: (error) => {
      storeErrors.push(error)
    },
  }),
)

describe('prisma 7 postgres', () => {
  beforeAll(async () => {
    postgresReady = await canConnect(url)
    if (!postgresReady) {
      console.warn(`PostgreSQL is not reachable at ${url}; skipping the Prisma 7 adapter-pg suite.`)
      return
    }
    await applySchema(url)
  })

  beforeEach(async (ctx) => {
    if (!postgresReady) {
      ctx.skip()
      return
    }
    clock.now = 1_700_000_000_000
    storeErrors.length = 0
    backgroundErrors.length = 0
    await base.post.deleteMany()
    await base.user.deleteMany()
    await prisma.$accelerate.invalidateAll()
    queries.length = 0
  })

  afterAll(async () => {
    await base.$disconnect()
  })

  it('does not cache reads that omit cacheStrategy', async () => {
    await base.user.create({ data: { email: 'ada@example.com', name: 'Ada' } })
    queries.length = 0
    await prisma.user.findMany()
    await prisma.user.findMany()
    expect(selectCount(queries)).toBe(2)
  })

  it('serves a second read from the ttl window and keeps special field types', async () => {
    const createdAt = new Date('2024-01-02T03:04:05.000Z')
    await base.user.create({
      data: {
        email: 'ada@example.com',
        name: 'Ada',
        age: 36,
        createdAt,
        bio: Uint8Array.from([1, 2, 3]),
        visits: 3n,
        score: new Prisma.Decimal('1.50'),
        meta: { role: 'admin' },
      },
    })
    queries.length = 0

    const first = await prisma.user.findMany({ cacheStrategy: { ttl: 30, tags: ['users'] } })
    expect(selectCount(queries)).toBe(1)
    const again = await prisma.user.findMany({ cacheStrategy: { ttl: 30, tags: ['users'] } })
    expect(selectCount(queries)).toBe(1)
    expect(again[0]?.name).toBe('Ada')
    expect(again[0]?.createdAt).toBeInstanceOf(Date)
    expect(again[0]?.createdAt.toISOString()).toBe(createdAt.toISOString())
    expect(again[0]?.visits).toBe(3n)
    expect(Array.from(again[0]?.bio ?? [])).toEqual([1, 2, 3])
    expect(again[0]?.score).toBeInstanceOf(Prisma.Decimal)
    expect(again[0]?.score?.equals(new Prisma.Decimal('1.50'))).toBe(true)
    expect(again[0]?.meta).toEqual({ role: 'admin' })

    const row = first[0]
    if (!row) throw new Error('expected a user')
    row.name = 'mutated'
    const untouched = await prisma.user.findMany({ cacheStrategy: { ttl: 30, tags: ['users'] } })
    expect(untouched[0]?.name).toBe('Ada')
    expect(selectCount(queries)).toBe(1)
  })

  it('reorders object keys into the same cache entry', async () => {
    await base.user.create({ data: { email: 'ada@example.com', name: 'Ada', age: 36 } })
    queries.length = 0
    await prisma.user.findMany({
      where: { email: 'ada@example.com', age: 36 },
      cacheStrategy: { ttl: 30 },
    })
    await prisma.user.findMany({
      where: { age: 36, email: 'ada@example.com' },
      cacheStrategy: { ttl: 30 },
    })
    expect(selectCount(queries)).toBe(1)
  })

  it('expires a ttl entry and queries again', async () => {
    await base.user.create({ data: { email: 'ada@example.com', name: 'Ada' } })
    queries.length = 0
    await prisma.user.findUnique({ where: { email: 'ada@example.com' }, cacheStrategy: { ttl: 10 } })
    clock.now += 10_000
    await prisma.user.findUnique({ where: { email: 'ada@example.com' }, cacheStrategy: { ttl: 10 } })
    expect(selectCount(queries)).toBe(2)
  })

  it('returns stale data during swr and then serves the refreshed row', async () => {
    await base.user.create({ data: { email: 'ada@example.com', name: 'Ada' } })
    const primed = await prisma.user
      .findMany({ cacheStrategy: { ttl: 10, swr: 10, tags: ['users'] } })
      .withAccelerateInfo()
    expect(primed.info.cacheStatus).toBe('miss')
    expect(primed.info.region).toBe('local')
    expect(primed.info.lastModified).toBeInstanceOf(Date)
    expect(primed.info.signature).toMatch(/^[a-f0-9]{64}$/)

    const fresh = await prisma.user
      .findMany({ cacheStrategy: { ttl: 10, swr: 10, tags: ['users'] } })
      .withAccelerateInfo()
    expect(fresh.info.cacheStatus).toBe('ttl')
    expect(fresh.data[0]?.name).toBe('Ada')

    await base.user.update({ where: { email: 'ada@example.com' }, data: { name: 'Grace' } })
    clock.now += 10_000
    const stale = await prisma.user
      .findMany({ cacheStrategy: { ttl: 10, swr: 10, tags: ['users'] } })
      .withAccelerateInfo()
    expect(stale.info.cacheStatus).toBe('swr')
    expect(stale.data[0]?.name).toBe('Ada')

    await waitFor(async () => {
      const next = await prisma.user
        .findMany({ cacheStrategy: { ttl: 10, swr: 10, tags: ['users'] } })
        .withAccelerateInfo()
      return next.data[0]?.name === 'Grace' && next.info.cacheStatus === 'ttl'
    })
  })

  it('keeps the stale response when the background refresh throws', async () => {
    await base.user.create({ data: { email: 'ada@example.com', name: 'Ada' } })
    await prisma.user.findUniqueOrThrow({
      where: { email: 'ada@example.com' },
      cacheStrategy: { ttl: 10, swr: 10 },
    })
    await base.user.delete({ where: { email: 'ada@example.com' } })
    clock.now += 10_000
    const stale = await prisma.user.findUniqueOrThrow({
      where: { email: 'ada@example.com' },
      cacheStrategy: { ttl: 10, swr: 10 },
    })
    expect(stale.name).toBe('Ada')
    await waitFor(() => backgroundErrors.length > 0)
    backgroundErrors.length = 0
  })

  it('does not let ttl 0 erase an existing entry', async () => {
    await base.user.create({ data: { email: 'ada@example.com', name: 'Ada' } })
    await prisma.user.findMany({ cacheStrategy: { ttl: 100, tags: ['users'] } })
    await base.user.update({ where: { email: 'ada@example.com' }, data: { name: 'Grace' } })
    queries.length = 0
    const bypass = await prisma.user.findMany({ cacheStrategy: { ttl: 0 } })
    expect(bypass[0]?.name).toBe('Grace')
    expect(selectCount(queries)).toBe(1)
    const cached = await prisma.user.findMany({ cacheStrategy: { ttl: 100, tags: ['users'] } })
    expect(cached[0]?.name).toBe('Ada')
    expect(selectCount(queries)).toBe(1)
  })

  it('invalidates by tag and leaves other tags in place', async () => {
    await base.user.create({ data: { email: 'ada@example.com', name: 'Ada' } })
    await prisma.user.findMany({ cacheStrategy: { ttl: 60, tags: ['users'] } })
    await prisma.user.count({ cacheStrategy: { ttl: 60, tags: ['counts'] } })
    await base.user.update({ where: { email: 'ada@example.com' }, data: { name: 'Grace' } })
    queries.length = 0

    const ignored = await prisma.$accelerate.invalidate({ tags: ['other'] })
    expect(ignored.requestId).toEqual(expect.any(String))
    const stillCached = await prisma.user.findMany({ cacheStrategy: { ttl: 60, tags: ['users'] } })
    expect(stillCached[0]?.name).toBe('Ada')
    expect(selectCount(queries)).toBe(0)

    await prisma.$accelerate.invalidate({ tags: ['users'] })
    const refreshed = await prisma.user.findMany({ cacheStrategy: { ttl: 60, tags: ['users'] } })
    expect(refreshed[0]?.name).toBe('Grace')
    const countInfo = await prisma.user.count({ cacheStrategy: { ttl: 60, tags: ['counts'] } }).withAccelerateInfo()
    expect(countInfo.info.cacheStatus).toBe('ttl')
    expect(countInfo.data).toBe(1)
  })

  it('clears every entry on invalidateAll', async () => {
    await base.user.create({ data: { email: 'ada@example.com', name: 'Ada' } })
    await prisma.user.findMany({ cacheStrategy: { ttl: 60, tags: ['users'] } })
    await base.user.update({ where: { email: 'ada@example.com' }, data: { name: 'Grace' } })
    queries.length = 0
    await prisma.$accelerate.invalidateAll()
    const rows = await prisma.user.findMany({ cacheStrategy: { ttl: 60, tags: ['users'] } })
    expect(rows[0]?.name).toBe('Grace')
    expect(selectCount(queries)).toBe(1)
  })

  it('caches findFirst, count, aggregate, and groupBy', async () => {
    await base.user.create({ data: { email: 'ada@example.com', name: 'Ada', age: 36, active: true } })
    await base.user.create({ data: { email: 'grace@example.com', name: 'Grace', age: 30, active: true } })
    queries.length = 0

    await prisma.user.findFirst({ where: { active: true }, orderBy: { age: 'desc' }, cacheStrategy: { ttl: 20 } })
    await prisma.user.findFirst({ where: { active: true }, orderBy: { age: 'desc' }, cacheStrategy: { ttl: 20 } })
    const counted = await prisma.user.count({ where: { active: true }, cacheStrategy: { ttl: 20 } })
    await prisma.user.count({ where: { active: true }, cacheStrategy: { ttl: 20 } })
    const aggregated = await prisma.user.aggregate({ _avg: { age: true }, _count: true, cacheStrategy: { ttl: 20 } })
    await prisma.user.aggregate({ _avg: { age: true }, _count: true, cacheStrategy: { ttl: 20 } })
    const grouped = await prisma.user.groupBy({ by: ['active'], _count: { _all: true }, cacheStrategy: { ttl: 20 } })
    await prisma.user.groupBy({ by: ['active'], _count: { _all: true }, cacheStrategy: { ttl: 20 } })

    expect(counted).toBe(2)
    expect(aggregated._count).toBe(2)
    expect(Number(aggregated._avg.age)).toBe(33)
    expect(grouped).toEqual([{ active: true, _count: { _all: 2 } }])
    expect(selectCount(queries)).toBe(4)
  })

  it('caches a null findUnique and does not cache a thrown miss', async () => {
    queries.length = 0
    const missing = await prisma.user.findUnique({ where: { id: 999 }, cacheStrategy: { ttl: 30 } })
    const missingAgain = await prisma.user.findUnique({ where: { id: 999 }, cacheStrategy: { ttl: 30 } })
    expect(missing).toBeNull()
    expect(missingAgain).toBeNull()
    expect(selectCount(queries)).toBe(1)

    await expect(prisma.user.findFirstOrThrow({ where: { id: 999 }, cacheStrategy: { ttl: 30 } })).rejects.toThrow()
    await expect(prisma.user.findFirstOrThrow({ where: { id: 999 }, cacheStrategy: { ttl: 30 } })).rejects.toThrow()
    expect(selectCount(queries)).toBe(3)
  })

  it('rejects cacheStrategy on writes before they reach the database', async () => {
    await expect(
      prisma.user.create({
        data: { email: 'nope@example.com', name: 'Nope' },
        cacheStrategy: { ttl: 10 },
      } as never),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' })
    expect(await base.user.count()).toBe(0)
    expect(storeErrors).toEqual([])
  })

  it('rejects an invalid tag before querying', async () => {
    queries.length = 0
    await expect(prisma.user.findMany({ cacheStrategy: { ttl: 10, tags: ['not-a-tag'] } })).rejects.toBeInstanceOf(
      OkAccelCacheError,
    )
    expect(selectCount(queries)).toBe(0)
  })

  it('does not cache a read inside an interactive transaction', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.user.create({ data: { email: 'tx@example.com', name: 'Tx' } })
        const seen = await tx.user.findMany({ cacheStrategy: { ttl: 60, tags: ['users'] } })
        expect(seen.map((user) => user.name)).toContain('Tx')
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')

    const after = await prisma.user.findMany({ cacheStrategy: { ttl: 60, tags: ['users'] } })
    expect(after.map((user) => user.name)).not.toContain('Tx')
    expect(await base.user.count()).toBe(0)
  })

  it('runs a batch transaction but does not cache those reads', async () => {
    await base.user.create({ data: { email: 'ada@example.com', name: 'Ada' } })
    queries.length = 0
    const [rows] = await prisma.$transaction([prisma.user.findMany({ cacheStrategy: { ttl: 15, tags: ['users'] } })])
    expect(rows[0]?.name).toBe('Ada')
    const [again] = await prisma.$transaction([prisma.user.findMany({ cacheStrategy: { ttl: 15, tags: ['users'] } })])
    expect(again[0]?.name).toBe('Ada')
    expect(selectCount(queries)).toBe(2)
  })

  it('still exposes the relation fluent api', async () => {
    const user = await base.user.create({
      data: { email: 'ada@example.com', name: 'Ada', posts: { create: { title: 'Hello' } } },
    })
    const found = prisma.user.findUnique({ where: { id: user.id }, cacheStrategy: { ttl: 15 } })
    const posts = await (found as unknown as { posts(): Promise<Array<{ title: string }>> }).posts()
    expect(posts.map((post) => post.title)).toEqual(['Hello'])
  })
})

const prefix = `okac-p7-${process.pid}`

async function redisIsUp(): Promise<boolean> {
  const probe = new Redis({
    host: '127.0.0.1',
    port: 6379,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 500,
    lazyConnect: true,
    retryStrategy: () => null,
  })
  try {
    await probe.connect()
    return (await probe.ping()) === 'PONG'
  } catch {
    return false
  } finally {
    probe.disconnect()
  }
}

describe('prisma 7 postgres redis', () => {
  const left = createBaseClient(url)
  const right = createBaseClient(url)
  let ioredisA: Redis | undefined
  let ioredisB: Redis | undefined
  let nodeA: ReturnType<typeof createClient> | undefined
  let nodeB: ReturnType<typeof createClient> | undefined
  let available = false

  beforeAll(async () => {
    if (!postgresReady) postgresReady = await canConnect(url)
    available = postgresReady && (await redisIsUp())
    if (!available) return
    await applySchema(url)
    ioredisA = new Redis({ host: '127.0.0.1', port: 6379, maxRetriesPerRequest: 2 })
    ioredisB = new Redis({ host: '127.0.0.1', port: 6379, maxRetriesPerRequest: 2 })
    nodeA = createClient({ url: 'redis://127.0.0.1:6379' })
    nodeB = createClient({ url: 'redis://127.0.0.1:6379' })
    nodeA.on('error', () => undefined)
    nodeB.on('error', () => undefined)
    await Promise.all([nodeA.connect(), nodeB.connect()])
  })

  afterAll(async () => {
    await Promise.all([left.base.$disconnect(), right.base.$disconnect()])
    if (ioredisA && ioredisB) {
      await createIoredisStore(ioredisA, { prefix }).invalidateAll()
      ioredisA.disconnect()
      ioredisB.disconnect()
    }
    if (nodeA && nodeB) {
      await createNodeRedisStore(nodeA, { prefix: `${prefix}-node` }).invalidateAll()
      await Promise.all([nodeA.quit(), nodeB.quit()])
    }
  })

  it('shares ttl hits and tag invalidation across ioredis connections', async (ctx) => {
    if (!available || !ioredisA || !ioredisB) {
      ctx.skip()
      return
    }
    const prismaA = left.base.$extends(
      withOkAccelCache({
        store: createIoredisStore(ioredisA, { prefix }),
        keyPrefix: prefix,
        onBackgroundError: () => undefined,
        onStoreError: (error) => {
          throw error
        },
      }),
    )
    const prismaB = right.base.$extends(
      withOkAccelCache({
        store: createIoredisStore(ioredisB, { prefix }),
        keyPrefix: prefix,
        onBackgroundError: () => undefined,
        onStoreError: (error) => {
          throw error
        },
      }),
    )

    await left.base.post.deleteMany()
    await left.base.user.deleteMany()
    await left.base.user.create({ data: { email: 'ada@example.com', name: 'Ada' } })
    left.queries.length = 0
    right.queries.length = 0

    const miss = await prismaA.user.findMany({ cacheStrategy: { ttl: 30, tags: ['users'] } }).withAccelerateInfo()
    expect(miss.info.cacheStatus).toBe('miss')
    expect(miss.data[0]?.name).toBe('Ada')

    const hit = await prismaB.user.findMany({ cacheStrategy: { ttl: 30, tags: ['users'] } }).withAccelerateInfo()
    expect(hit.info.cacheStatus).toBe('ttl')
    expect(hit.data[0]?.name).toBe('Ada')
    expect(selectCount(right.queries)).toBe(0)

    await left.base.user.update({ where: { email: 'ada@example.com' }, data: { name: 'Grace' } })
    await prismaB.$accelerate.invalidate({ tags: ['users'] })
    left.queries.length = 0
    const refreshed = await prismaA.user.findMany({ cacheStrategy: { ttl: 30, tags: ['users'] } })
    expect(refreshed[0]?.name).toBe('Grace')
    expect(selectCount(left.queries)).toBe(1)

    await prismaA.$accelerate.invalidateAll()
  })

  it('shares invalidation across node-redis connections', async (ctx) => {
    if (!available || !nodeA || !nodeB) {
      ctx.skip()
      return
    }
    const nodePrefix = `${prefix}-node`
    const prismaA = left.base.$extends(
      withOkAccelCache({
        store: createNodeRedisStore(nodeA, { prefix: nodePrefix }),
        keyPrefix: nodePrefix,
        onBackgroundError: () => undefined,
        onStoreError: (error) => {
          throw error
        },
      }),
    )
    const prismaB = right.base.$extends(
      withOkAccelCache({
        store: createNodeRedisStore(nodeB, { prefix: nodePrefix }),
        keyPrefix: nodePrefix,
        onBackgroundError: () => undefined,
        onStoreError: (error) => {
          throw error
        },
      }),
    )

    await left.base.post.deleteMany()
    await left.base.user.deleteMany()
    await left.base.user.create({ data: { email: 'grace@example.com', name: 'Grace' } })
    right.queries.length = 0
    await prismaA.user.findFirst({
      where: { email: 'grace@example.com' },
      cacheStrategy: { ttl: 30, tags: ['users'] },
    })
    const hit = await prismaB.user.findFirst({
      where: { email: 'grace@example.com' },
      cacheStrategy: { ttl: 30, tags: ['users'] },
    })
    expect(hit?.name).toBe('Grace')
    expect(selectCount(right.queries)).toBe(0)

    await prismaA.$accelerate.invalidate({ tags: ['users'] })
    await left.base.user.update({ where: { email: 'grace@example.com' }, data: { name: 'Ada' } })
    const refreshed = await prismaB.user.findFirst({
      where: { email: 'grace@example.com' },
      cacheStrategy: { ttl: 30, tags: ['users'] },
    })
    expect(refreshed?.name).toBe('Ada')
  })
})
