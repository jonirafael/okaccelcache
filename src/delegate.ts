import type { Prisma } from '@prisma/client'

import { INFO_FLAG } from './constants'
import { OkAccelCacheError } from './errors'
import { getPrismaRuntime } from './prisma-runtime'
import type { AccelerateInfo, AcceleratePromise, CacheStrategy } from './types'

type OperationArgs = { cacheStrategy?: CacheStrategy } | undefined

type SelectSubset<T, U> = {
  [K in keyof T]: K extends keyof U ? T[K] : never
} & (T extends { select: unknown; include: unknown }
  ? 'Please either choose `select` or `include`.'
  : T extends { select: unknown; omit: unknown }
    ? 'Please either choose `select` or `omit`.'
    : unknown)

type ReadOperation =
  | 'aggregate'
  | 'count'
  | 'findFirst'
  | 'findFirstOrThrow'
  | 'findMany'
  | 'findUnique'
  | 'findUniqueOrThrow'
  | 'groupBy'

type ArgsWithCache<Model, Operation extends ReadOperation> = Prisma.Args<Model, Operation> & {
  cacheStrategy?: CacheStrategy
}

/**
 * These methods exist so `cacheStrategy` type-checks.
 * At runtime each one calls the parent delegate, which is the client extended
 * with the query hook but not with these overrides. That keeps Prisma's own
 * operation (including transactions and aggregate argument shaping) in charge.
 * `.withAccelerateInfo()` issues that same parent call with an internal flag.
 */
export function cacheableModelMethods() {
  return {
    aggregate<This, FormalArgs extends ArgsWithCache<This, 'aggregate'>, const ActualArgs extends FormalArgs>(
      this: This,
      args: SelectSubset<ActualArgs, FormalArgs>,
    ): AcceleratePromise<Prisma.Result<This, ActualArgs, 'aggregate'>> {
      return forward(this as object, 'aggregate', args)
    },
    count<This, FormalArgs extends ArgsWithCache<This, 'count'>, const ActualArgs extends FormalArgs>(
      this: This,
      args?: SelectSubset<ActualArgs, FormalArgs>,
    ): AcceleratePromise<Prisma.Result<This, ActualArgs, 'count'>> {
      return forward(this as object, 'count', args)
    },
    findFirst<This, FormalArgs extends ArgsWithCache<This, 'findFirst'>, const ActualArgs extends FormalArgs>(
      this: This,
      args?: SelectSubset<ActualArgs, FormalArgs>,
    ): AcceleratePromise<Prisma.Result<This, ActualArgs, 'findFirst'> | null> {
      return forward(this as object, 'findFirst', args)
    },
    findFirstOrThrow<
      This,
      FormalArgs extends ArgsWithCache<This, 'findFirstOrThrow'>,
      const ActualArgs extends FormalArgs,
    >(
      this: This,
      args?: SelectSubset<ActualArgs, FormalArgs>,
    ): AcceleratePromise<Prisma.Result<This, ActualArgs, 'findFirstOrThrow'>> {
      return forward(this as object, 'findFirstOrThrow', args)
    },
    findMany<This, FormalArgs extends ArgsWithCache<This, 'findMany'>, const ActualArgs extends FormalArgs>(
      this: This,
      args?: SelectSubset<ActualArgs, FormalArgs>,
    ): AcceleratePromise<Prisma.Result<This, ActualArgs, 'findMany'>> {
      return forward(this as object, 'findMany', args)
    },
    findUnique<This, FormalArgs extends ArgsWithCache<This, 'findUnique'>, const ActualArgs extends FormalArgs>(
      this: This,
      args: SelectSubset<ActualArgs, FormalArgs>,
    ): AcceleratePromise<Prisma.Result<This, ActualArgs, 'findUnique'> | null> {
      return forward(this as object, 'findUnique', args)
    },
    findUniqueOrThrow<
      This,
      FormalArgs extends ArgsWithCache<This, 'findUniqueOrThrow'>,
      const ActualArgs extends FormalArgs,
    >(
      this: This,
      args: SelectSubset<ActualArgs, FormalArgs>,
    ): AcceleratePromise<Prisma.Result<This, ActualArgs, 'findUniqueOrThrow'>> {
      return forward(this as object, 'findUniqueOrThrow', args)
    },
    groupBy<This, FormalArgs extends ArgsWithCache<This, 'groupBy'>, const ActualArgs extends FormalArgs>(
      this: This,
      args: SelectSubset<ActualArgs, FormalArgs>,
    ): AcceleratePromise<Prisma.Result<This, ActualArgs, 'groupBy'>> {
      return forward(this as object, 'groupBy', args)
    },
  }
}

interface ParentContext {
  $name?: string
  $parent?: Record<string, Record<string, (args?: unknown) => Promise<unknown> & object>>
}

function forward<T>(context: object, operation: string, args: OperationArgs): AcceleratePromise<T> {
  const ctx = getPrismaRuntime().getExtensionContext(context) as ParentContext
  const modelName = ctx.$name
  const jsName = modelName ? modelName.charAt(0).toLowerCase() + modelName.slice(1) : undefined
  const delegate = modelName ? (ctx.$parent?.[modelName] ?? (jsName ? ctx.$parent?.[jsName] : undefined)) : undefined
  const run = delegate?.[operation]
  if (!modelName || typeof run !== 'function') {
    throw new OkAccelCacheError(
      'INVALID_STORE',
      `OkAccelCache could not reach the parent ${modelName ?? 'model'}.${operation} operation.`,
    )
  }

  const promise = run.call(delegate, args)
  const withAccelerateInfo = () => {
    const next =
      args != null && typeof args === 'object' ? { ...args, [INFO_FLAG]: true } : { [INFO_FLAG]: true }
    return run.call(delegate, next) as Prisma.PrismaPromise<{ data: T; info: AccelerateInfo }>
  }
  return Object.assign(promise, { withAccelerateInfo }) as AcceleratePromise<T>
}
