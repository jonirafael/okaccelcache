import { defineConfig } from 'prisma/config'

/**
 * CLI config for the PostgreSQL schema only.
 * Runtime tests pass the same URL to `@prisma/adapter-pg`.
 * `prisma db push` is not used; tests apply `migrate diff` SQL with `pg`.
 */
export default defineConfig({
  schema: 'prisma/postgres.prisma',
  datasource: {
    url: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/okaccelcache7',
  },
})
