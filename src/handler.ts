import { randomUUID } from 'node:crypto'

import { CACHEABLE_OPERATIONS, INFO_FLAG, REDIS_LOCK_TTL_MS } from './constants'
import { deserializeResult, serializeResult } from './codec'
import { OkAccelCacheError } from './errors'
import { createCacheKey, createSignature } from './key'
import { classifyAge, generationsMatch, isInvalidated } from './policy'
import type {
  AccelerateInfo,
  BackgroundErrorInfo,
  CacheRead,
  CacheStore,
  NormalizedStrategy,
  StoreErrorInfo,
  StoredEntry,
} from './types'
import { validateStrategy } from './validate'

const REGION = 'local'

export interface HandlerOptions {
  store: CacheStore
  now: () => number
  keyPrefix: string
  onBackgroundError: (error: unknown, info: BackgroundErrorInfo) => void
  onStoreError: (error: unknown, info: StoreErrorInfo) => void
}

interface OperationParams {
  model?: string
  operation: string
  args: unknown
  query: (args: unknown) => Promise<unknown>
  __internalParams?: { transaction?: unknown }
}

/**
 * Query-extension callback. Prisma calls this inside the real operation,
 * after the model method has delegated here, so aggregate desugaring,
 * fluent calls, and interactive transactions still belong to Prisma.
 */
export function createOperationHandler(options: HandlerOptions) {
  const inflight = new Map<string, Promise<unknown>>()

  return async function onOperation(params: OperationParams): Promise<unknown> {
    const split = splitArgs(params.args)
    const inTransaction = params.__internalParams?.transaction != null
    const strategy = split.strategy === undefined ? undefined : validateStrategy(split.strategy)

    if (!CACHEABLE_OPERATIONS.has(params.operation)) {
      if (strategy) {
        throw new OkAccelCacheError(
          'UNSUPPORTED_OPERATION',
          `cacheStrategy is only supported on findUnique, findUniqueOrThrow, findFirst, findFirstOrThrow, findMany, count, aggregate, and groupBy. Received ${params.operation}.`,
        )
      }
      return finish(params, split.queryArgs, split.wantsInfo, 'none', options.now(), undefined)
    }

    if (inTransaction || !strategy) {
      return finish(params, split.queryArgs, split.wantsInfo, 'none', options.now(), undefined)
    }

    if (strategy.ttlMs === 0 && strategy.swrMs === 0) {
      return finish(params, split.queryArgs, split.wantsInfo, 'miss', options.now(), undefined)
    }

    const key = createCacheKey(options.keyPrefix, params.model ?? '', params.operation, split.queryArgs)
    const signature = safeSignature(params.model, params.operation, split.queryArgs)

    let snapshot: CacheRead
    try {
      snapshot = await options.store.read(key, strategy.tags)
    } catch (error) {
      options.onStoreError(error, { model: params.model, operation: params.operation, key, op: 'read' })
      return finish(params, split.queryArgs, split.wantsInfo, 'miss', options.now(), signature)
    }

    const entry = snapshot.entry
        if (entry && !isInvalidated(entry, snapshot)) {
      const age = classifyAge(entry, options.now())
      if (age === 'fresh' || age === 'stale') {
        const data = decode(entry, options, params, key)
        if (data !== DECODE_FAILED) {
          if (age === 'stale') {
            scheduleRefresh(options, inflight, params, key, strategy, split.queryArgs)
          }
          const status = age === 'fresh' ? 'ttl' : 'swr'
          return pack(data, split.wantsInfo, status, entry.storedAt, signature)
        }
      }
    }

    const data = await loadShared(inflight, key, () =>
      loadAndStore(options, params, key, strategy, split.queryArgs),
    )
    return pack(data, split.wantsInfo, 'miss', options.now(), signature)
  }
}

const DECODE_FAILED = Symbol('decode-failed')

function decode(
  entry: StoredEntry,
  options: HandlerOptions,
  params: OperationParams,
  key: string,
): unknown {
  try {
    return deserializeResult(entry.payload)
  } catch (error) {
    options.onStoreError(error, { model: params.model, operation: params.operation, key, op: 'read' })
    return DECODE_FAILED
  }
}

async function finish(
  params: OperationParams,
  queryArgs: unknown,
  wantsInfo: boolean,
  status: AccelerateInfo['cacheStatus'],
  now: number,
  signature: string | undefined,
): Promise<unknown> {
  const data = await params.query(queryArgs)
  if (!wantsInfo) return data
  return {
    data,
    info: buildInfo(status, now, signature ?? safeSignature(params.model, params.operation, queryArgs)),
  }
}

function pack(
  data: unknown,
  wantsInfo: boolean,
  status: AccelerateInfo['cacheStatus'],
  modifiedAt: number,
  signature: string,
): unknown {
  if (!wantsInfo) return data
  return { data, info: buildInfo(status, modifiedAt, signature) }
}

function buildInfo(status: AccelerateInfo['cacheStatus'], modifiedAt: number, signature: string): AccelerateInfo {
  return {
    cacheStatus: status,
    lastModified: new Date(modifiedAt),
    region: REGION,
    requestId: randomUUID(),
    signature,
  }
}

function scheduleRefresh(
  options: HandlerOptions,
  inflight: Map<string, Promise<unknown>>,
  params: OperationParams,
  key: string,
  strategy: NormalizedStrategy,
  queryArgs: unknown,
): void {
  // A refresh already in flight satisfies later stale reads. The caller already
  // has the stale payload and does not wait.
  if (inflight.has(key)) return
  const run = async () => {
    if (strategy.ttlMs > 0 && options.store.tryLock) {
      const locked = await options.store.tryLock(key, REDIS_LOCK_TTL_MS).catch(() => true)
      if (!locked) return
    }
    await loadShared(inflight, key, () => loadAndStore(options, params, key, strategy, queryArgs))
  }
  void run().catch((error: unknown) => {
    options.onBackgroundError(error, { model: params.model, operation: params.operation, key })
  })
}

function loadShared(
  inflight: Map<string, Promise<unknown>>,
  key: string,
  load: () => Promise<unknown>,
): Promise<unknown> {
  const existing = inflight.get(key)
  if (existing) return existing
  const task = load().finally(() => {
    if (inflight.get(key) === task) inflight.delete(key)
  })
  inflight.set(key, task)
  return task
}

async function loadAndStore(
  options: HandlerOptions,
  params: OperationParams,
  key: string,
  strategy: NormalizedStrategy,
  queryArgs: unknown,
): Promise<unknown> {
  const started = await readOrEmpty(options, params, key, strategy.tags)
  const data = await params.query(queryArgs)
  let payload: string
  try {
    payload = serializeResult(data)
  } catch (error) {
    options.onStoreError(error, { model: params.model, operation: params.operation, key, op: 'write' })
    return data
  }

  const finished = await readOrEmpty(options, params, key, strategy.tags)
  if (!generationsMatch(started, finished, strategy.tags)) return data

  const storedAt = options.now()
  const entry: StoredEntry = {
    payload,
    storedAt,
    ttlMs: strategy.ttlMs,
    swrMs: strategy.swrMs,
    hardExpireAt: storedAt + strategy.ttlMs + strategy.swrMs,
    tags: strategy.tags,
    tagGenerations: Object.fromEntries(strategy.tags.map((tag) => [tag, finished.tagGenerations[tag] ?? 0])),
    allGeneration: finished.allGeneration,
  }
  try {
    await options.store.write(key, entry)
  } catch (error) {
    options.onStoreError(error, { model: params.model, operation: params.operation, key, op: 'write' })
  }
  return data
}

async function readOrEmpty(
  options: HandlerOptions,
  params: OperationParams,
  key: string,
  tags: readonly string[],
): Promise<CacheRead> {
  try {
    return await options.store.read(key, tags)
  } catch (error) {
    options.onStoreError(error, { model: params.model, operation: params.operation, key, op: 'read' })
    return { entry: null, allGeneration: 0, tagGenerations: {} }
  }
}

function splitArgs(args: unknown): { strategy: unknown; wantsInfo: boolean; queryArgs: unknown } {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { strategy: undefined, wantsInfo: false, queryArgs: args }
  }
  const record = args as Record<string, unknown>
  if (!('cacheStrategy' in record) && !(INFO_FLAG in record)) {
    return { strategy: undefined, wantsInfo: false, queryArgs: args }
  }
  const queryArgs: Record<string, unknown> = { ...record }
  const strategy = queryArgs.cacheStrategy
  const wantsInfo = queryArgs[INFO_FLAG] === true
  delete queryArgs.cacheStrategy
  delete queryArgs[INFO_FLAG]
  return { strategy, wantsInfo, queryArgs }
}

function safeSignature(model: string | undefined, operation: string, args: unknown): string {
  try {
    return createSignature(model, operation, args)
  } catch {
    return 'unavailable'
  }
}
