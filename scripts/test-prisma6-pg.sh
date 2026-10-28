#!/usr/bin/env bash
# Prisma ORM 6 against PostgreSQL. Skips inside the suite when the server is down.
# Not part of the published package.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
app="$root/test/prisma6-pg"

cd "$root"
npm run build
rm -f "$app"/okaccelcache-*.tgz
npm pack --pack-destination "$app" >/dev/null

cd "$app"
if [[ ! -d node_modules/@prisma/client ]]; then
  npm ci
fi

rm -rf node_modules/okaccelcache
mkdir -p node_modules/okaccelcache
tar -xzf okaccelcache-0.1.0.tgz -C node_modules/okaccelcache --strip-components=1
rm -f okaccelcache-0.1.0.tgz

DATABASE_URL="${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:5432/okaccelcache6}" npx prisma generate
npx vitest run
