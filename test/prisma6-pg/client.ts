import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import { PrismaClient } from '@prisma/client'

/** Local default used when DATABASE_URL is unset. Connection failure skips the suite. */
export const defaultPostgresUrl = 'postgresql://postgres:postgres@127.0.0.1:5432/okaccelcache6'

export function postgresUrl(): string {
  const fromEnv = process.env.DATABASE_URL
  if (fromEnv && /^postgres(ql)?:/i.test(fromEnv)) return fromEnv
  return defaultPostgresUrl
}

const schemaSql = readFileSync(new URL('../postgres/schema.sql', import.meta.url), 'utf8')

export function canConnect(url: string): boolean {
  try {
    execFileSync('psql', [url, '-c', 'SELECT 1'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

export function applySchema(url: string): void {
  execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1'], {
    input: schemaSql,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

export function createBaseClient(url: string): { base: PrismaClient; queries: string[] } {
  const queries: string[] = []
  const base = new PrismaClient({
    datasources: { db: { url } },
    log: [{ emit: 'event', level: 'query' }],
  })
  base.$on('query', (event) => {
    queries.push(event.query)
  })
  return { base, queries }
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
