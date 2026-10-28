import { createRequire } from 'node:module'

/**
 * Runtime helpers loaded from the installed @prisma/client package.
 *
 * The package root (`@prisma/client`) points at the generated client. Prisma 7
 * projects that use the `prisma-client` generator never create that entry, and
 * a nested install can also resolve a parent folder's generated client. The
 * runtime entry points below ship inside the package itself.
 *
 * Prisma 6's generated client uses `runtime/library`. Prisma 7 uses `runtime/client`.
 */
export interface DecimalValue {
  toString(): string
  equals(other: DecimalValue): boolean
}

export interface PrismaRuntime {
  defineExtension: (extension: unknown) => (client: unknown) => unknown
  getExtensionContext: <T>(value: T) => T
  Decimal: new (value: string | number) => DecimalValue
  DbNull: object
  JsonNull: object
  AnyNull: object
}

interface RuntimeModule {
  Extensions?: {
    defineExtension?: PrismaRuntime['defineExtension']
    getExtensionContext?: PrismaRuntime['getExtensionContext']
  }
  Decimal?: PrismaRuntime['Decimal']
  DbNull?: object
  JsonNull?: object
  AnyNull?: object
  objectEnumValues?: {
    instances?: {
      DbNull?: object
      JsonNull?: object
      AnyNull?: object
    }
  }
}

let cached: PrismaRuntime | undefined

/**
 * CJS builds do not have a real `import.meta.url` (tsup leaves it empty).
 * ESM builds do not define `__filename`. Either path resolves `@prisma/client`
 * from this package file, not from a parent install.
 */
function modulePath(): string {
  if (typeof __filename === 'string' && __filename.length > 0) return __filename
  return import.meta.url
}

export function getPrismaRuntime(): PrismaRuntime {
  if (cached) return cached

  const require = createRequire(modulePath())
  const pkg = require('@prisma/client/package.json') as { version?: string }
  const major = Number((pkg.version ?? '0').split('.')[0])
  const specifier = major >= 7 ? '@prisma/client/runtime/client' : '@prisma/client/runtime/library'
  let runtime: RuntimeModule
  try {
    runtime = require(specifier) as RuntimeModule
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `okaccelcache could not load ${specifier} from @prisma/client ${pkg.version ?? 'unknown'}: ${reason}`,
    )
  }

  const instances = runtime.objectEnumValues?.instances
  const defineExtension = runtime.Extensions?.defineExtension
  const getExtensionContext = runtime.Extensions?.getExtensionContext
  const Decimal = runtime.Decimal
  const DbNull = runtime.DbNull ?? instances?.DbNull
  const JsonNull = runtime.JsonNull ?? instances?.JsonNull
  const AnyNull = runtime.AnyNull ?? instances?.AnyNull

  if (!defineExtension || !getExtensionContext || !Decimal || !DbNull || !JsonNull || !AnyNull) {
    throw new Error(
      `okaccelcache found @prisma/client ${pkg.version ?? 'unknown'} but ${specifier} is missing defineExtension or the JSON null sentinels.`,
    )
  }

  cached = { defineExtension, getExtensionContext, Decimal, DbNull, JsonNull, AnyNull }
  return cached
}
