import { randomUUID } from 'node:crypto'

import type { Prisma } from '@prisma/client'

import { DEFAULT_MAX_ENTRIES, DEFAULT_PREFIX } from './constants'
import { getPrismaRuntime } from './prisma-runtime'
import { cacheableModelMethods } from './delegate'
import { createOperationHandler } from './handler'
import { createMemoryStore } from './stores/memory'
import type { AccelerateInvalidateResult, CacheStore, OkAccelCacheOptions } from './types'
import { assertKeyPrefix, validateInvalidateTags } from './validate'

/**
 * Prisma Client extension that accepts Accelerate-style `cacheStrategy`
 * on the documented read operations, plus `$accelerate.invalidate` and
 * `$accelerate.invalidateAll`.
 *
 * Not affiliated with Prisma, and not an official replacement for Accelerate.
 */
export function withOkAccelCache(options: OkAccelCacheOptions = {}) {
  const now = options.now ?? Date.now
  const keyPrefix = assertKeyPrefix(options.keyPrefix ?? DEFAULT_PREFIX)
  const store = options.store ?? createMemoryStore({ maxEntries: options.maxEntries ?? DEFAULT_MAX_ENTRIES, now })
  const onBackgroundError =
    options.onBackgroundError ??
    ((error, info) => {
      console.error(`okaccelcache: background refresh failed for ${info.model ?? 'query'}.${info.operation}`, error)
    })
  const onStoreError =
    options.onStoreError ??
    ((error, info) => {
      console.error(`okaccelcache: cache store ${info.op} failed for ${info.model ?? 'query'}.${info.operation}`, error)
    })

  const handler = createOperationHandler({ store, now, keyPrefix, onBackgroundError, onStoreError })

  const defineExtension = getPrismaRuntime().defineExtension as typeof Prisma.defineExtension

  return defineExtension((client) => {
    const queried = client.$extends({
      name: 'okaccelcache',
      query: {
        $allModels: {
          $allOperations(params) {
            return handler(params)
          },
        },
      },
    })

    return queried.$extends({
      name: 'okaccelcache',
      client: {
        $accelerate: accelerateClient(store),
      },
      model: {
        $allModels: cacheableModelMethods(),
      },
    })
  })
}

function accelerateClient(store: CacheStore) {
  return {
    /**
     * Drop every cached result that carries one of these tags.
     * At most five tags per call, matching Accelerate's documented limit.
     * There is no daily rate limit.
     */
    async invalidate(input: { tags: readonly string[] }): Promise<AccelerateInvalidateResult> {
      const tags = validateInvalidateTags(input?.tags)
      await store.invalidateTags(tags)
      return { requestId: randomUUID() }
    },
    /** Drop every entry in this store. Other Redis keys outside the store prefix are left alone. */
    async invalidateAll(): Promise<AccelerateInvalidateResult> {
      await store.invalidateAll()
      return { requestId: randomUUID() }
    },
  }
}
