import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import Database from 'better-sqlite3'
import type { SqlDriverAdapter, Transaction } from '@prisma/driver-adapter-utils'
import { PrismaClient } from './generated/prisma/client'

const here = path.dirname(fileURLToPath(import.meta.url))

/** Absolute file URL so the adapter does not depend on the process cwd. */
export const databaseUrl = `file:${path.join(here, 'dev.db')}`

/**
 * DDL from `npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script`
 * for this folder's schema on Prisma 7.10.1. Applied with better-sqlite3 so the
 * suite does not run `prisma db push`.
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS "User" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "age" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bio" BLOB,
    "visits" BIGINT NOT NULL DEFAULT 0,
    "score" DECIMAL,
    "meta" JSONB
);
CREATE TABLE IF NOT EXISTS "Post" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "title" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    CONSTRAINT "Post_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key" ON "User"("email");
`

export function pushSchema(): void {
  const file = databaseUrl.slice('file:'.length)
  const db = new Database(file)
  db.exec(SCHEMA_SQL)
  db.close()
}

type SqlParams = Parameters<SqlDriverAdapter['queryRaw']>[0]

/**
 * Counts SQL that Prisma actually sends through the better-sqlite3 adapter.
 * Prisma 7 driver adapters do not emit the old client `query` log for this.
 */
export function createBaseClient(): { base: PrismaClient; queries: string[] } {
  const queries: string[] = []
  const factory = new PrismaBetterSqlite3({ url: databaseUrl })
  const connect = factory.connect.bind(factory)
  factory.connect = async () => instrument(await connect(), queries)
  const base = new PrismaClient({ adapter: factory })
  return { base, queries }
}

/**
 * Record SQL without wrapping the driver in a Proxy. The adapter stores
 * private fields on the connection and transaction objects; a Proxy makes
 * `commit` throw.
 */
function instrument(adapter: SqlDriverAdapter, queries: string[]): SqlDriverAdapter {
  const queryRaw = adapter.queryRaw.bind(adapter)
  adapter.queryRaw = ((params: SqlParams) => {
    record(queries, params)
    return queryRaw(params)
  }) as SqlDriverAdapter['queryRaw']

  const startTransaction = adapter.startTransaction.bind(adapter)
  adapter.startTransaction = async (isolationLevel) => {
    const transaction = await startTransaction(isolationLevel)
    const transactionQuery = transaction.queryRaw.bind(transaction)
    transaction.queryRaw = ((params: SqlParams) => {
      record(queries, params)
      return transactionQuery(params)
    }) as Transaction['queryRaw']
    return transaction
  }
  return adapter
}

function record(queries: string[], params: SqlParams): void {
  if (typeof params?.sql === 'string') queries.push(params.sql)
}

export function selectCount(queries: readonly string[]): number {
  return queries.filter((sql) => sql.trimStart().toUpperCase().startsWith('SELECT')).length
}

export async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for a cache refresh.')
}
