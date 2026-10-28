import type { CacheRead, StoredEntry } from './types'

export type CacheAge = 'fresh' | 'stale' | 'expired'

/**
 * Fresh: age is inside the stored ttl, so the database is not touched.
 * Stale: ttl has passed but ttl + swr has not. Serve the payload and refresh.
 * Expired: past ttl + swr, or the clock is at hardExpireAt.
 *
 * A stored ttl of 0 means the entry is never fresh. The next read is stale
 * until swr elapses, which matches Accelerate's note that swr without ttl
 * still revalidates in the background.
 */
export function classifyAge(entry: StoredEntry, now: number): CacheAge {
  if (now >= entry.hardExpireAt) return 'expired'
  const age = now - entry.storedAt
  if (age < entry.ttlMs) return 'fresh'
  if (age < entry.ttlMs + entry.swrMs) return 'stale'
  return 'expired'
}

/** True when a tag or global invalidation happened after the entry was written. */
export function isInvalidated(entry: StoredEntry, snapshot: Pick<CacheRead, 'allGeneration' | 'tagGenerations'>): boolean {
  if (snapshot.allGeneration > entry.allGeneration) return true
  for (const tag of entry.tags) {
    const current = snapshot.tagGenerations[tag] ?? 0
    const stored = entry.tagGenerations[tag] ?? 0
    if (current > stored) return true
  }
  return false
}

/**
 * Generations captured before a database read must still match afterwards.
 * If they moved, an invalidate landed while the query was in flight and the
 * result must not be stored as fresh.
 */
export function generationsMatch(before: CacheRead, after: CacheRead, tags: readonly string[]): boolean {
  if (before.allGeneration !== after.allGeneration) return false
  for (const tag of tags) {
    if ((before.tagGenerations[tag] ?? 0) !== (after.tagGenerations[tag] ?? 0)) return false
  }
  return true
}
