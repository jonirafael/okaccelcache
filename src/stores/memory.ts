import { DEFAULT_MAX_ENTRIES } from '../constants'
import { OkAccelCacheError } from '../errors'
import type { CacheRead, CacheStore, StoredEntry } from '../types'

export interface MemoryStoreOptions {
  /** @default 1000 */
  maxEntries?: number
  /** Epoch milliseconds. Defaults to Date.now. */
  now?: () => number
}

/**
 * Process-local LRU. Invalidation is visible only to callers that share this store.
 * Use Redis when several processes must see the same tags.
 */
export function createMemoryStore(options: MemoryStoreOptions = {}): CacheStore {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new OkAccelCacheError('INVALID_STORE', 'maxEntries must be a positive integer.')
  }

  const now = options.now ?? Date.now
  const entries = new Map<string, StoredEntry>()
  const tagGenerations = new Map<string, number>()
  let allGeneration = 0

  function touch(key: string, entry: StoredEntry): void {
    entries.delete(key)
    entries.set(key, entry)
  }

  function evictOverflow(): void {
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value
      if (oldest === undefined) return
      entries.delete(oldest)
    }
  }

  return {
    async read(key, tags) {
      const existing = entries.get(key)
      let entry: StoredEntry | null = null
      if (existing) {
        if (now() >= existing.hardExpireAt) {
          entries.delete(key)
        } else {
          touch(key, existing)
          entry = existing
        }
      }

      const names = new Set<string>(tags)
      if (entry) {
        for (const tag of entry.tags) names.add(tag)
      }
      const tagMap: Record<string, number> = {}
      for (const tag of names) tagMap[tag] = tagGenerations.get(tag) ?? 0
      return { entry, allGeneration, tagGenerations: tagMap } satisfies CacheRead
    },

    async write(key, entry) {
      touch(key, entry)
      evictOverflow()
    },

    async invalidateTags(tags) {
      const unique = new Set(tags)
      for (const tag of unique) {
        tagGenerations.set(tag, (tagGenerations.get(tag) ?? 0) + 1)
      }
      for (const [key, entry] of entries) {
        if (entry.tags.some((tag) => unique.has(tag))) entries.delete(key)
      }
    },

    async invalidateAll() {
      allGeneration += 1
      entries.clear()
    },
  }
}
