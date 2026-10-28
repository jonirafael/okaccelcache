import path from 'node:path'
import { defineConfig } from 'prisma/config'

const databaseFile = path.join(import.meta.dirname, 'dev.db')

export default defineConfig({
  schema: path.join(import.meta.dirname, 'prisma/schema.prisma'),
  datasource: {
    url: `file:${databaseFile}`,
  },
})
