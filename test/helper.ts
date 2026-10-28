import { execSync } from 'node:child_process'
import path from 'node:path'

import { PrismaClient } from '@prisma/client'

export const databaseUrl = `file:${path.resolve('test/prisma/test.db')}`

export function pushSchema(): void {
  execSync('npx prisma db push --schema test/prisma/schema.prisma --skip-generate --accept-data-loss', {
    stdio: 'pipe',
  })
}

export function createBaseClient(): { base: PrismaClient; queries: string[] } {
  const queries: string[] = []
  const base = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
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
