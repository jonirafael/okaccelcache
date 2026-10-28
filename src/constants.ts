/** Accelerate's FAQ allows `ttl` up to one year. OkAccelCache uses the same ceiling for `swr`. */
export const MAX_CACHE_SECONDS = 365 * 24 * 60 * 60

/** Official Accelerate typings allow at most five tags on a query and on invalidate. */
export const MAX_TAGS = 5

export const MAX_TAG_LENGTH = 64

/** Tags are alphanumeric plus underscore, matching the Accelerate API reference. */
export const TAG_PATTERN = /^[A-Za-z0-9_]+$/

export const DEFAULT_MAX_ENTRIES = 1000

export const DEFAULT_PREFIX = 'okaccelcache'

/** Internal flag so `.withAccelerateInfo()` can ask for cache metadata. */
export const INFO_FLAG = '__okaccelInfo'

export const STRATEGY_KEYS = new Set(['ttl', 'swr', 'tags'])

export const CACHEABLE_OPERATIONS: ReadonlySet<string> = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
])

/** Extra Redis key lifetime so a process can apply logical expiry before Redis drops the key. */
export const REDIS_TTL_BUFFER_MS = 60_000

export const REDIS_LOCK_TTL_MS = 10_000
