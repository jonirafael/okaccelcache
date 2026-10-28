-- Shared PostgreSQL DDL for the OkAccelCache suites.
-- Produced by `prisma migrate diff --from-empty` against the User/Post schema
-- on Prisma 6.19.3 and 7.10.1 (the scripts matched). Applied with psql or `pg`,
-- not `prisma db push`.
DROP TABLE IF EXISTS "Post" CASCADE;
DROP TABLE IF EXISTS "User" CASCADE;

CREATE SCHEMA IF NOT EXISTS "public";

CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "age" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bio" BYTEA,
    "visits" BIGINT NOT NULL DEFAULT 0,
    "score" DECIMAL(65,30),
    "meta" JSONB,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Post" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    CONSTRAINT "Post_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

ALTER TABLE "Post" ADD CONSTRAINT "Post_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
