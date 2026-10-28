import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { PrismaPg } from '@prisma/adapter-pg'
import type { SqlDriverAdapter, Transaction } from '@prisma/driver-adapter-utils'
import pg from 'pg'

import { PrismaClient } from './generated/postgres/client'

const here = path.dirname(fileURLToPath(import.meta.url))

/** Local default used when DATABASE_URL is unset. Connection failure skips the suite. */
export const defaultPostgresUrl = 'postgresql://postgres:postgres@127.0.0.1:5432/okaccelcache7'

export function postgresUrl(): string {
  const fromEnv = process.env.DATABASE_URL
  if (fromEnv && /^postgres(ql)?:/i.test(fromEnv)) return fromEnv
  return defaultPostgresUrl
}

const schemaSql = readFileSync(path.join(here, '../postgres/schema.sql'), 'utf8')

export async function canConnect(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1000 })
  try {
    await client.connect()
    await client.query('SELECT 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => undefined)
  }
}

export async function applySchema(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    await client.query(schemaSql)
  } finally {
    await client.end()
  }
}

type SqlParams = Parameters<SqlDriverAdapter['queryRaw']>[0]

export function createBaseClient(url: string): { base: PrismaClient; queries: string[] } {
  const queries: string[] = []
  const factory = new PrismaPg({ connectionString: url })
  const connect = factory.connect.bind(factory)
  factory.connect = async () => instrument(await connect(), queries)
  const base = new PrismaClient({ adapter: factory })
  return { base, queries }
}

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
