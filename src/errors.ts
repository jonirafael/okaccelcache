export type OkAccelCacheErrorCode =
  | 'INVALID_CACHE_STRATEGY'
  | 'INVALID_TAGS'
  | 'UNSUPPORTED_OPERATION'
  | 'INVALID_STORE'

export class OkAccelCacheError extends Error {
  readonly code: OkAccelCacheErrorCode

  constructor(code: OkAccelCacheErrorCode, message: string) {
    super(message)
    this.name = 'OkAccelCacheError'
    this.code = code
  }
}
