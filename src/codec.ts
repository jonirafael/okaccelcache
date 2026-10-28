import { Prisma } from '@prisma/client'

import { OkAccelCacheError } from './errors'

const MARK = '~okac'

type Marked =
  | { [MARK]: 'date'; v: string }
  | { [MARK]: 'bigint'; v: string }
  | { [MARK]: 'bytes'; v: string }
  | { [MARK]: 'decimal'; v: string }
  | { [MARK]: 'dbnull' }
  | { [MARK]: 'jsonnull' }
  | { [MARK]: 'anynull' }

/**
 * JSON codec for query results.
 * Dates, bigints, bytes, Prisma decimals, and the JSON null sentinels survive a round trip.
 * A stored object whose only key is `~okac` could be mistaken for a marker. That key is reserved.
 */
export function serializeResult(value: unknown): string {
  return JSON.stringify(tag(value))
}

export function deserializeResult(payload: string): unknown {
  return untag(JSON.parse(payload) as unknown)
}

function tag(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'bigint') return mark({ [MARK]: 'bigint', v: value.toString() })
  if (typeof value !== 'object') return value

  if (value === Prisma.DbNull) return mark({ [MARK]: 'dbnull' })
  if (value === Prisma.JsonNull) return mark({ [MARK]: 'jsonnull' })
  if (value === Prisma.AnyNull) return mark({ [MARK]: 'anynull' })
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new OkAccelCacheError('INVALID_CACHE_STRATEGY', 'Cannot cache an invalid Date.')
    }
    return mark({ [MARK]: 'date', v: value.toISOString() })
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    return mark({ [MARK]: 'bytes', v: value.toString('base64') })
  }
  if (value instanceof Uint8Array) {
    return mark({ [MARK]: 'bytes', v: Buffer.from(value).toString('base64') })
  }
  if (typeof Prisma.Decimal === 'function' && value instanceof Prisma.Decimal) {
    return mark({ [MARK]: 'decimal', v: value.toString() })
  }
  if (Array.isArray(value)) return value.map((item) => tag(item))

  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) {
    throw new OkAccelCacheError(
      'INVALID_CACHE_STRATEGY',
      `Cannot cache a ${value.constructor?.name ?? 'non-plain'} result value.`,
    )
  }

  const output: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (nested !== undefined) output[key] = tag(nested)
  }
  return output
}

function untag(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => untag(item))

  const record = value as Record<string, unknown>
  const marker = record[MARK]
  if (typeof marker === 'string' && Object.keys(record).length <= 2) {
    return revive(marker, record.v)
  }

  const output: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(record)) output[key] = untag(nested)
  return output
}

function revive(marker: string, raw: unknown): unknown {
  switch (marker) {
    case 'date':
      return new Date(String(raw))
    case 'bigint':
      return BigInt(String(raw))
    case 'bytes':
      return Uint8Array.from(Buffer.from(String(raw), 'base64'))
    case 'decimal':
      if (typeof Prisma.Decimal !== 'function') return String(raw)
      return new Prisma.Decimal(String(raw))
    case 'dbnull':
      return Prisma.DbNull
    case 'jsonnull':
      return Prisma.JsonNull
    case 'anynull':
      return Prisma.AnyNull
    default:
      return { [MARK]: marker, v: raw }
  }
}

function mark(value: Marked): Marked {
  return value
}
