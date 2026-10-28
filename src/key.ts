import { createHash } from 'node:crypto'

import { OkAccelCacheError } from './errors'
import { getPrismaRuntime } from './prisma-runtime'

/**
 * Canonical JSON for cache keys.
 * Object keys are sorted so `{ a, b }` and `{ b, a }` share an entry.
 * Array order is preserved. `cacheStrategy` must already have been removed.
 */
export function canonicalArgs(value: unknown): string {
  return stringify(value, new Set())
}

export function createCacheKey(prefix: string, model: string, operation: string, args: unknown): string {
  const hash = createHash('sha256').update(canonicalArgs(args)).digest('hex')
  return `${prefix}:v1:${model}:${operation}:${hash}`
}

export function createSignature(model: string | undefined, operation: string, args: unknown): string {
  return createHash('sha256').update(`${model ?? ''}:${operation}:${canonicalArgs(args)}`).digest('hex')
}

function stringify(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null'
  if (value === undefined) return '"undefined"'

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) fail('Cache keys cannot include NaN or Infinity.')
      return Object.is(value, -0) ? '"-0"' : JSON.stringify(value)
    case 'bigint':
      return JSON.stringify({ $bigint: value.toString() })
    case 'object':
      return stringifyObject(value, seen)
    default:
      fail(`Cache keys cannot include ${typeof value}.`)
  }
}

function stringifyObject(value: object, seen: Set<object>): string {
  if (seen.has(value)) fail('Cache keys cannot include circular query arguments.')
  seen.add(value)
  try {
    const sentinel = sentinelName(value)
    if (sentinel) return JSON.stringify({ $prisma: sentinel })
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) fail('Cache keys cannot include an invalid Date.')
      return JSON.stringify({ $date: value.toISOString() })
    }
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
      return JSON.stringify({ $bytes: value.toString('base64') })
    }
    if (value instanceof Uint8Array) {
      return JSON.stringify({ $bytes: Buffer.from(value).toString('base64') })
    }
    if (value instanceof getPrismaRuntime().Decimal) {
      return JSON.stringify({ $decimal: value.toString() })
    }
    if (Array.isArray(value)) {
      return `[${value.map((item) => stringify(item, seen)).join(',')}]`
    }
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) {
      fail(`Cache keys cannot include ${value.constructor?.name ?? 'this object'}.`)
    }
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stringify(record[key], seen)}`).join(',')}}`
  } finally {
    seen.delete(value)
  }
}

function sentinelName(value: object): string | undefined {
  const prisma = getPrismaRuntime()
  if (value === prisma.DbNull) return 'DbNull'
  if (value === prisma.JsonNull) return 'JsonNull'
  if (value === prisma.AnyNull) return 'AnyNull'
  return undefined
}

function fail(message: string): never {
  throw new OkAccelCacheError('INVALID_CACHE_STRATEGY', message)
}
