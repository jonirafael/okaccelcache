import { PrismaClient } from '@prisma/client'

import { withOkAccelCache } from '../src/index'

/**
 * Compiled by `tsc -p tsconfig.typecheck.json`. It is not executed.
 * These assertions lock the public call shape for Prisma Client 6.
 */
async function acceptsAccelerateStyleCalls(): Promise<void> {
  const prisma = new PrismaClient().$extends(withOkAccelCache())

  const rows = await prisma.user.findMany({
    where: { email: { contains: 'a' } },
    cacheStrategy: { ttl: 60, swr: 10, tags: ['users'] },
  })
  rows[0]?.email

  const picked = await prisma.user.findMany({
    select: { id: true, email: true },
    cacheStrategy: { ttl: 5 },
  })
  picked[0]?.email
  // @ts-expect-error name was not selected
  picked[0]?.name

  const one = await prisma.user.findUnique({
    where: { id: 1 },
    cacheStrategy: { ttl: 1 },
  })
  one?.id

  const info = await prisma.user
    .count({
      cacheStrategy: { swr: 5, tags: ['users'] },
    })
    .withAccelerateInfo()
  info.data
  info.info.cacheStatus

  await prisma.user.findFirst({ cacheStrategy: { ttl: 1 } })
  await prisma.user.findFirstOrThrow({ cacheStrategy: { ttl: 1 } })
  await prisma.user.findUniqueOrThrow({ where: { id: 1 }, cacheStrategy: { ttl: 1 } })
  await prisma.user.aggregate({ _count: true, cacheStrategy: { ttl: 1, tags: ['users'] } })
  await prisma.user.groupBy({ by: ['active'], cacheStrategy: { ttl: 1 } })

  await prisma.$accelerate.invalidate({ tags: ['users'] })
  await prisma.$accelerate.invalidateAll()

  await prisma.user.findMany({
    // @ts-expect-error ttl is a number of seconds
    cacheStrategy: { ttl: '60' },
  })

  await prisma.user.findMany({
    // @ts-expect-error tags are strings
    cacheStrategy: { tags: [1] },
  })

  // @ts-expect-error tags are required
  await prisma.$accelerate.invalidate({})

  await prisma.user.create({
    data: { email: 'a@b.c' },
    // @ts-expect-error cacheStrategy is not part of write operations
    cacheStrategy: { ttl: 1 },
  })
}

void acceptsAccelerateStyleCalls
