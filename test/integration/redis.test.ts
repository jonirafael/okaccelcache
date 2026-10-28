import { createClient } from 'redis'
import Redis from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createIoredisStore, createNodeRedisStore } from '../../src/stores/redis'
import { withOkAccelCache } from '../../src/index'
import { createBaseClient, pushSchema, selectCount } from '../helper'

const prefix = `okac-test-${process.pid}`

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

describe('redis store', () => {
  const left = createBaseClient()
  const right = createBaseClient()
  let ioredisA: Redis | undefined
  let ioredisB: Redis | undefined
  let nodeA: ReturnType<typeof createClient> | undefined
  let nodeB: ReturnType<typeof createClient> | undefined
  let available = false

  beforeAll(async () => {
    available = await redisIsUp()
    if (!available) return
    pushSchema()
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
      const store = createIoredisStore(ioredisA, { prefix })
      await store.invalidateAll()
      ioredisA.disconnect()
      ioredisB.disconnect()
    }
    if (nodeA && nodeB) {
      const store = createNodeRedisStore(nodeA, { prefix: `${prefix}-node` })
      await store.invalidateAll()
      await Promise.all([nodeA.quit(), nodeB.quit()])
    }
  })

  it('shares ttl hits and tag invalidation across ioredis connections', async (ctx) => {
    if (!available || !ioredisA || !ioredisB) {
      ctx.skip()
      return
    }
    const redisA = ioredisA
    const redisB = ioredisB
    const prismaA = left.base.$extends(
      withOkAccelCache({
        store: createIoredisStore(redisA, { prefix }),
        keyPrefix: prefix,
        onBackgroundError: () => undefined,
        onStoreError: (error) => {
          throw error
        },
      }),
    )
    const prismaB = right.base.$extends(
      withOkAccelCache({
        store: createIoredisStore(redisB, { prefix }),
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
    await prismaA.user.findFirst({ where: { email: 'grace@example.com' }, cacheStrategy: { ttl: 30, tags: ['users'] } })
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
