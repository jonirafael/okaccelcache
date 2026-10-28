# okaccelcache

Preview **0.1.0**. A small Prisma Client extension that keeps the `cacheStrategy: { ttl, swr, tags }` call shape, plus `$accelerate.invalidate` / `$accelerate.invalidateAll`, after you stop sending queries through Prisma Accelerate.

Prisma Accelerate, including its cache, retires on 1 December 2026. Prisma's docs say query caching is not part of Prisma Postgres and is not on the immediate roadmap, and they tell Prisma ORM 6 and 7 apps to cache in their own process. This package is one way to do that. It is **not** an official replacement, and it is **not** affiliated with Prisma.

Prisma ORM 8 has its own cache middleware (`@prisma/orm-extension-middleware-cache`, `cacheAnnotation`, TTL in milliseconds, no stale-while-revalidate). That API does not use `cacheStrategy`. This package targets the `$extends` client in Prisma ORM 6 and 7.

## Install

```bash
npm install okaccelcache
```

`@prisma/client` 6 or 7 is a peer dependency. Redis is optional:

```bash
npm install ioredis
# or
npm install redis
```

The default store is an in-memory LRU of 1,000 entries. It lives in one process. Use Redis when more than one process must see the same tags.

## Migrate a cached call

Before, with `@prisma/extension-accelerate`:

```ts
import { PrismaClient } from '@prisma/client'
import { withAccelerate } from '@prisma/extension-accelerate'

const prisma = new PrismaClient({
  accelerateUrl: process.env.DATABASE_URL,
}).$extends(withAccelerate())

const posts = await prisma.post.findMany({
  cacheStrategy: { ttl: 60, swr: 10, tags: ['posts'] },
})

await prisma.$accelerate.invalidate({ tags: ['posts'] })
```

After, against your own database URL. Connection pooling is your problem now; this package does not pool connections. Prisma's guide is [Keep your existing database](https://www.prisma.io/docs/accelerate/keep-your-database).

```ts
import { PrismaClient } from '@prisma/client'
import { withOkAccelCache } from 'okaccelcache'

const prisma = new PrismaClient().$extends(withOkAccelCache())

const posts = await prisma.post.findMany({
  cacheStrategy: { ttl: 60, swr: 10, tags: ['posts'] },
})

await prisma.$accelerate.invalidate({ tags: ['posts'] })
```

Redis:

```ts
import { PrismaClient } from '@prisma/client'
import Redis from 'ioredis'
import { createIoredisStore, withOkAccelCache } from 'okaccelcache'

const redis = new Redis(process.env.REDIS_URL)

export const prisma = new PrismaClient().$extends(
  withOkAccelCache({
    store: createIoredisStore(redis, { prefix: 'myapp' }),
    keyPrefix: 'myapp',
  }),
)
```

`createNodeRedisStore` accepts a client from the `redis` package (`createClient`). Use the same `prefix` / `keyPrefix` so `invalidateAll` deletes that store's entry keys.

## What a strategy means

`ttl` and `swr` are seconds, matching the [Accelerate API reference](https://www.prisma.io/docs/accelerate/reference/api-reference) and the cache notes in the [Accelerate docs](https://www.prisma.io/docs/accelerate).

| Window | What a read does |
| --- | --- |
| `0` to `ttl` | Fresh hit. The database is not queried. |
| after `ttl`, until `ttl + swr` | Stale hit. The cached value is returned immediately and a refresh runs in the background. When that refresh finishes, later reads get the new value. |
| after `ttl + swr` | Miss. The read waits on the database and stores the result. |

An omitted `ttl` or `swr` is treated as `0`. That follows the published Accelerate typings: `swr` without `ttl` still stores a value but refreshes it in the background (it does not cut database load), and `ttl` without `swr` blocks on the first read after `ttl`. `cacheStrategy: { ttl: 0 }` or `{ ttl: 0, swr: 0 }` bypasses the cache and does **not** delete an entry that a longer `ttl` already stored. Prisma said the same about `ttl: 0` in [this discussion](https://github.com/prisma/prisma/discussions/25200).

Tags are optional. Each tag is 1–64 characters, letters, digits, and underscores only. A query may carry at most five tags. `$accelerate.invalidate({ tags })` accepts one to five tags and drops every entry that was stored with any of those tags. `$accelerate.invalidateAll()` drops every entry in the configured store. Both resolve to `{ requestId }`. There is no plan rate limit and no `P6003` error.

Reads that accept `cacheStrategy`:

`findUnique`, `findUniqueOrThrow`, `findFirst`, `findFirstOrThrow`, `findMany`, `count`, `aggregate`, `groupBy`.

`.withAccelerateInfo()` still returns `{ data, info }`. `info.cacheStatus` is `ttl`, `swr`, `miss`, or `none`. `info.region` is always `"local"`. `info.requestId` is a UUID from this process. `info.signature` is a sha256 of the model, operation, and canonical arguments. `info.lastModified` is when this package stored the payload, or the time of the database read on a miss.

## Cache identity

The key is `model + operation + canonical arguments`. `cacheStrategy` is not part of the key, so the same read with a different `ttl` or tag list shares one entry. Object key order does not matter. Array order does. Dates, bigints, byte arrays, `Prisma.Decimal`, and `Prisma.DbNull` / `JsonNull` / `AnyNull` have stable encodings.

The `ttl`, `swr`, and tags saved on an entry are the ones from the write that stored it (a miss or a stale refresh). A later fresh hit does not rewrite them. Changing tags means invalidating, or waiting until the entry is stored again.

Tag invalidation uses a generation counter in the store. Bumping that counter is visible to every process that shares the store, which is what the Redis backend is for. A result is not stored if an invalidation lands while the database query is in flight. There is still a small gap between that check and the write.

## Store interface

`CacheStore` is the extension point. `read` returns the entry plus the current global generation and the current generation of every requested tag and every tag already stored on the entry. Generation `0` means "never invalidated". `write` stores the entry. `invalidateTags` and `invalidateAll` must be visible to other processes before they resolve. `tryLock` is optional and only used to collapse stale refreshes when `ttl > 0`.

```ts
import type { CacheStore } from 'okaccelcache'

export function createMyStore(): CacheStore {
  return {
    async read(key, tags) {
      return { entry: null, allGeneration: 0, tagGenerations: Object.fromEntries(tags.map((tag) => [tag, 0])) }
    },
    async write() {},
    async invalidateTags() {},
    async invalidateAll() {},
  }
}
```

See `src/stores/memory.ts` and `src/stores/redis.ts` for complete backends. Redis values are JSON. Treat that Redis database like the application database.

If a store read or write throws, the query still hits the database (`onStoreError`, default `console.error`). If a background refresh throws, the caller already has the stale value (`onBackgroundError`).

`withOkAccelCache({ now, maxEntries, keyPrefix })` is there for tests and for sharing a prefix. `now` is epoch milliseconds. Redis key eviction still uses the wall clock as a backstop (`ttl + swr + 60s`).

## Supported

- The eight read operations above, with `cacheStrategy` typed on the extended client for Prisma ORM 6 and 7.
- `ttl`, `swr`, and `tags`, including serving a stale row and refreshing it.
- `$accelerate.invalidate` and `$accelerate.invalidateAll`.
- `.withAccelerateInfo()`, with the local meanings above.
- In-memory LRU and Redis (ioredis or node-redis).
- Cached `null` from `findUnique` / `findFirst`. Thrown "not found" results are not cached.
- Dates, bigints, bytes, decimals, and JSON on the way in and out of the cache.
- A result is copied out of the cache, so mutating it does not change the stored value.

## Not supported

- Connection pooling, edge cache, `prisma://` URLs, or a custom Accelerate `fetch`.
- Prisma ORM 8. Use its cache middleware instead of this package.
- Caching raw queries.
- `cacheStrategy` on writes. The extension throws `OkAccelCacheError` with code `UNSUPPORTED_OPERATION` before the write runs.
- Caching inside `$transaction`, both the interactive callback and the sequential array form. Those reads run against the transaction and are not stored. That avoids keeping uncommitted rows, or rows that a later rollback removed.
- Relation fluent helpers in the TypeScript return type (`user.findUnique(...).posts()`). The call still runs, because the runtime value is Prisma's promise, but the type is `AcceleratePromise`. Select or include the relation if you want it in the type. Accelerate's published signatures do the same replacement.
- Accelerate plan limits. Nothing throws `P6003`. Invalid tags and out-of-range `ttl` / `swr` throw `OkAccelCacheError`, not `PrismaClientKnownRequestError`.
- A global network of cache nodes. Invalidation is as fast as the store acknowledges it. Accelerate's own FAQ describes multi-second propagation across points of presence; this package does not have those nodes.
- `info.region`, `requestId`, and `signature` as Cloudflare values. Do not send them to Prisma support as Accelerate request ids.

## Limits copied from Prisma's docs

- `ttl` up to one year (`365 * 24 * 60 * 60` seconds), from the [Accelerate FAQ](https://www.prisma.io/docs/accelerate/more/faq). This package uses that same ceiling for `swr`. Prisma's FAQ states the maximum for `ttl` only.
- At most five tags on a query, from the Accelerate client typings, and at most five tags per `invalidate` call, from the [API reference](https://www.prisma.io/docs/accelerate/reference/api-reference).
- Tag characters: alphanumeric or `_`, length 1–64, from that same reference.
- Unknown `cacheStrategy` fields are rejected so a typo such as `TTL` does not silently disable caching.

## Compatibility

Verified here against PostgreSQL 16.15 (`127.0.0.1`) and Redis (`127.0.0.1:6379`). Redis cases ran. Postgres cases ran against real servers, not a mock. If `DATABASE_URL` is a `postgres://` URL, both Postgres suites use it. If it is unset, Prisma 6 tries `postgresql://postgres:postgres@127.0.0.1:5432/okaccelcache6` and Prisma 7 tries `.../okaccelcache7`. If that connection fails, those tests skip and the process still exits 0.

| Suite | How it connects | Tests that ran |
| --- | --- | --- |
| Prisma ORM 6.19.3, SQLite | `prisma-client-js`, built-in driver | 31: 13 unit, 16 client, 2 Redis, plus `tsc` |
| Prisma ORM 6.19.3, PostgreSQL | `prisma-client-js`, built-in query engine (not `@prisma/adapter-pg`; that package is Prisma 7) | 18: 16 client, 2 Redis |
| Prisma ORM 7.10.1, SQLite | `prisma-client` generator, `@prisma/adapter-better-sqlite3` 7.10.1 | 18: 16 client, 2 Redis |
| Prisma ORM 7.10.1, PostgreSQL | `prisma-client` generator, `@prisma/adapter-pg` 7.10.1 and `pg` 8.16.3 | 18: 16 client, 2 Redis |

On every database suite above, these passed: passthrough without `cacheStrategy`, TTL expiry, SWR serving a stale row then refreshing, memory tag invalidation, `invalidateAll`, tag invalidation across two ioredis connections and two node-redis connections, and both interactive and batch `$transaction` reads staying uncached. The same suites also covered dates, bigints, bytes, decimals, JSON, a cached `null`, `ttl: 0` not deleting an existing entry, and a runtime fluent `findUnique().posts()` call.

Not run: `@prisma/adapter-libsql`, D1, MySQL, and Prisma ORM 8.

The extension loads `defineExtension` and the JSON null sentinels from `@prisma/client/runtime/library` on Prisma 6 and from `@prisma/client/runtime/client` on Prisma 7.

## Development

```bash
npm test
npm run test:prisma6
npm run test:prisma6-pg
npm run test:prisma7
npm run build
npm pack --dry-run
```

`npm test` runs the Prisma 6 SQLite suite, the typecheck, the Prisma 7 SQLite and Postgres suites, then the Prisma 6 Postgres suite. `test/prisma7` and `test/prisma6-pg` have their own `package.json` files and are not in the published tarball (`files` is `dist`, `README.md`, and `LICENSE`). A copy-paste CI workflow lives at `docs/ci-workflow.yml`.

## License

MIT. Copyright (c) 2026 jonirafael.
