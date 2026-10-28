import { MAX_CACHE_SECONDS, MAX_TAG_LENGTH, MAX_TAGS, STRATEGY_KEYS, TAG_PATTERN } from './constants'
import { OkAccelCacheError } from './errors'
import type { NormalizedStrategy } from './types'

export function validateStrategy(value: unknown): NormalizedStrategy {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new OkAccelCacheError(
      'INVALID_CACHE_STRATEGY',
      'cacheStrategy must be an object with optional ttl, swr, and tags.',
    )
  }

  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!STRATEGY_KEYS.has(key)) {
      throw new OkAccelCacheError(
        'INVALID_CACHE_STRATEGY',
        `Unknown cacheStrategy field "${key}". Expected ttl, swr, and tags.`,
      )
    }
  }

  const ttl = readSeconds(record.ttl, 'ttl')
  const swr = readSeconds(record.swr, 'swr')
  const tags = validateTagList(record.tags ?? [], { min: 0, max: MAX_TAGS, label: 'cacheStrategy.tags' })
  return { ttlMs: ttl * 1000, swrMs: swr * 1000, tags }
}

export function validateInvalidateTags(value: unknown): string[] {
  return validateTagList(value, { min: 1, max: MAX_TAGS, label: '$accelerate.invalidate tags' })
}

export function assertKeyPrefix(prefix: string): string {
  if (!/^[A-Za-z0-9:_-]{1,64}$/.test(prefix)) {
    throw new OkAccelCacheError(
      'INVALID_STORE',
      'Cache key prefix must be 1–64 characters and contain only letters, numbers, colon, underscore, or hyphen.',
    )
  }
  return prefix
}

function readSeconds(value: unknown, field: 'ttl' | 'swr'): number {
  if (value === undefined) return 0
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_CACHE_SECONDS) {
    throw new OkAccelCacheError(
      'INVALID_CACHE_STRATEGY',
      `${field} must be an integer number of seconds from 0 through ${MAX_CACHE_SECONDS} (one year).`,
    )
  }
  return value
}

function validateTagList(value: unknown, limits: { min: number; max: number; label: string }): string[] {
  if (!Array.isArray(value)) {
    throw new OkAccelCacheError('INVALID_TAGS', `${limits.label} must be an array of strings.`)
  }

  const unique: string[] = []
  const seen = new Set<string>()
  for (const tag of value) {
    if (typeof tag !== 'string' || !TAG_PATTERN.test(tag) || tag.length > MAX_TAG_LENGTH) {
      throw new OkAccelCacheError(
        'INVALID_TAGS',
        `Tag "${String(tag)}" is invalid. Tags are 1–${MAX_TAG_LENGTH} characters and may contain only letters, numbers, and underscores.`,
      )
    }
    if (!seen.has(tag)) {
      seen.add(tag)
      unique.push(tag)
    }
  }

  if (unique.length < limits.min) {
    throw new OkAccelCacheError('INVALID_TAGS', `${limits.label} requires at least ${limits.min} tag.`)
  }
  if (unique.length > limits.max) {
    throw new OkAccelCacheError('INVALID_TAGS', `${limits.label} accepts at most ${limits.max} tags per call.`)
  }
  return unique
}
