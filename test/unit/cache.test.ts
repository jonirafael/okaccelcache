import { Prisma } from '@prisma/client'
import { describe, expect, it } from 'vitest'

import { deserializeResult, serializeResult } from '../../src/codec'
import { OkAccelCacheError } from '../../src/errors'
import { canonicalArgs, createCacheKey } from '../../src/key'
import { classifyAge, generationsMatch, isInvalidated } from '../../src/policy'
import { createMemoryStore } from '../../src/stores/memory'
import type { StoredEntry } from '../../src/types'
import { validateInvalidateTags, validateStrategy } from '../../src/validate'

const entry = (overrides: Partial<StoredEntry> = {}): StoredEntry => ({
  payload: '[]',
  storedAt: 1_000,
  ttlMs: 10_000,
  swrMs: 5_000,
  hardExpireAt: 16_000,
  tags: ['posts'],
  tagGenerations: { posts: 1 },
  allGeneration: 2,
  ...overrides,
})

describe('cache policy', () => {
  it('serves fresh data inside ttl and stale data inside the following swr window', () => {
    const stored = entry()
    expect(classifyAge(stored, 1_000)).toBe('fresh')
    expect(classifyAge(stored, 10_999)).toBe('fresh')
    expect(classifyAge(stored, 11_000)).toBe('stale')
    expect(classifyAge(stored, 15_999)).toBe('stale')
    expect(classifyAge(stored, 16_000)).toBe('expired')
  })

  it('treats ttl 0 as immediately stale until swr ends', () => {
    const stored = entry({ ttlMs: 0, swrMs: 5_000, hardExpireAt: 6_000 })
    expect(classifyAge(stored, 1_000)).toBe('stale')
    expect(classifyAge(stored, 6_000)).toBe('expired')
  })

  it('notices tag and global invalidation generations', () => {
    const stored = entry()
    expect(isInvalidated(stored, { allGeneration: 2, tagGenerations: { posts: 1 } })).toBe(false)
    expect(isInvalidated(stored, { allGeneration: 2, tagGenerations: { posts: 2 } })).toBe(true)
    expect(isInvalidated(stored, { allGeneration: 3, tagGenerations: { posts: 1 } })).toBe(true)
  })

  it('refuses to store a result when generations moved during the query', () => {
    const before = { entry: null, allGeneration: 1, tagGenerations: { posts: 4 } }
    const after = { entry: null, allGeneration: 1, tagGenerations: { posts: 5 } }
    expect(generationsMatch(before, after, ['posts'])).toBe(false)
    expect(generationsMatch(before, before, ['posts'])).toBe(true)
  })
})

describe('cache keys', () => {
  it('ignores object key order and keeps array order', () => {
    const left = canonicalArgs({ where: { email: 'a@b.c', age: 3 }, orderBy: [{ age: 'asc' }, { id: 'desc' }] })
    const right = canonicalArgs({ orderBy: [{ age: 'asc' }, { id: 'desc' }], where: { age: 3, email: 'a@b.c' } })
    const differentArray = canonicalArgs({ where: { email: 'a@b.c', age: 3 }, orderBy: [{ id: 'desc' }, { age: 'asc' }] })
    expect(left).toBe(right)
    expect(left).not.toBe(differentArray)
  })

  it('distinguishes dates, bigints, bytes, decimals, and prisma null sentinels', () => {
    const first = canonicalArgs({
      where: { createdAt: new Date('2024-01-02T03:04:05.000Z'), visits: 3n, score: new Prisma.Decimal('1.50') },
    })
    const second = canonicalArgs({
      where: { visits: 3n, score: new Prisma.Decimal('1.50'), createdAt: new Date('2024-01-02T03:04:05.000Z') },
    })
    expect(first).toBe(second)
    expect(canonicalArgs({ where: { visits: 4n } })).not.toBe(canonicalArgs({ where: { visits: 3n } }))
    expect(canonicalArgs(Prisma.DbNull)).not.toBe(canonicalArgs(Prisma.JsonNull))
    expect(canonicalArgs(Prisma.JsonNull)).not.toBe(canonicalArgs(Prisma.AnyNull))
  })

  it('builds a stable key from the model, operation, and args', () => {
    const key = createCacheKey('okaccelcache', 'User', 'findMany', { where: { id: 1 } })
    expect(key).toBe(createCacheKey('okaccelcache', 'User', 'findMany', { where: { id: 1 } }))
    expect(key).not.toBe(createCacheKey('okaccelcache', 'User', 'findFirst', { where: { id: 1 } }))
    expect(key).not.toBe(createCacheKey('okaccelcache', 'Post', 'findMany', { where: { id: 1 } }))
  })
})

describe('result codec', () => {
  it('round-trips dates, bigints, bytes, decimals, and nested json', () => {
    const original = {
      createdAt: new Date('2024-01-02T03:04:05.000Z'),
      visits: 3n,
      bio: Uint8Array.from([1, 2, 3]),
      score: new Prisma.Decimal('1.50'),
      meta: { role: 'admin', nested: [null, true] },
      empty: null,
    }
    const revived = deserializeResult(serializeResult(original)) as typeof original
    expect(revived.createdAt).toBeInstanceOf(Date)
    expect(revived.createdAt.toISOString()).toBe('2024-01-02T03:04:05.000Z')
    expect(revived.visits).toBe(3n)
    expect(Array.from(revived.bio)).toEqual([1, 2, 3])
    expect(revived.score).toBeInstanceOf(Prisma.Decimal)
    expect(revived.score.equals(original.score)).toBe(true)
    expect(revived.meta).toEqual(original.meta)
    expect(revived.empty).toBeNull()
  })

  it('round-trips prisma null sentinels by identity', () => {
    expect(deserializeResult(serializeResult(Prisma.DbNull))).toBe(Prisma.DbNull)
    expect(deserializeResult(serializeResult(Prisma.JsonNull))).toBe(Prisma.JsonNull)
    expect(deserializeResult(serializeResult(Prisma.AnyNull))).toBe(Prisma.AnyNull)
  })
})

describe('strategy validation', () => {
  it('defaults omitted ttl and swr to zero and dedupes tags', () => {
    expect(validateStrategy({ tags: ['posts', 'posts'] })).toEqual({ ttlMs: 0, swrMs: 0, tags: ['posts'] })
    expect(validateStrategy({ ttl: 60, swr: 10 })).toEqual({ ttlMs: 60_000, swrMs: 10_000, tags: [] })
  })

  it('rejects fractions, a ttl past one year, bad tags, and a sixth tag', () => {
    expect(() => validateStrategy({ ttl: 1.5 })).toThrow(OkAccelCacheError)
    expect(() => validateStrategy({ ttl: -1 })).toThrow(OkAccelCacheError)
    expect(() => validateStrategy({ swr: 365 * 24 * 60 * 60 + 1 })).toThrow(OkAccelCacheError)
    expect(() => validateStrategy({ tags: ['has-hyphen'] })).toThrow(OkAccelCacheError)
    expect(() => validateStrategy({ tags: ['a', 'b', 'c', 'd', 'e', 'f'] })).toThrow(OkAccelCacheError)
    expect(() => validateStrategy({ TTL: 1 })).toThrow(OkAccelCacheError)
    expect(() => validateInvalidateTags([])).toThrow(OkAccelCacheError)
    expect(() => validateInvalidateTags(['ok'])).not.toThrow()
  })
})

describe('memory store', () => {
  it('evicts the least recently used entry past maxEntries', async () => {
    const now = { t: 0 }
    const store = createMemoryStore({ maxEntries: 2, now: () => now.t })
    await store.write('a', entry({ hardExpireAt: 100 }))
    await store.write('b', entry({ hardExpireAt: 100 }))
    await store.read('a', [])
    await store.write('c', entry({ hardExpireAt: 100 }))
    const [first, second, third] = await Promise.all([store.read('a', []), store.read('b', []), store.read('c', [])])
    expect(first.entry).not.toBeNull()
    expect(second.entry).toBeNull()
    expect(third.entry).not.toBeNull()
  })

  it('bumps tag generations and drops tagged entries', async () => {
    const store = createMemoryStore({ now: () => 0 })
    await store.write('posts', entry({ tags: ['posts'], tagGenerations: { posts: 0 }, hardExpireAt: 50 }))
    await store.write('users', entry({ tags: ['users'], tagGenerations: { users: 0 }, hardExpireAt: 50 }))
    await store.invalidateTags(['posts'])
    const posts = await store.read('posts', ['posts'])
    const users = await store.read('users', ['users'])
    expect(posts.entry).toBeNull()
    expect(posts.tagGenerations.posts).toBe(1)
    expect(users.entry).not.toBeNull()
    await store.invalidateAll()
    expect((await store.read('users', [])).entry).toBeNull()
    expect((await store.read('users', [])).allGeneration).toBe(1)
  })
})
