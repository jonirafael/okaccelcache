#!/usr/bin/env bash
# Runs the Prisma ORM 7 suite in test/prisma7 against a freshly built tarball.
# The suite stays out of the published package (`files` does not include test/).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
app="$root/test/prisma7"

cd "$root"
npm run build
rm -f "$app"/okaccelcache-*.tgz
npm pack --pack-destination "$app" >/dev/null

cd "$app"
if [[ ! -d node_modules/@prisma/adapter-better-sqlite3 ]]; then
  npm ci
fi

rm -rf node_modules/okaccelcache
mkdir -p node_modules/okaccelcache
tar -xzf okaccelcache-0.1.0.tgz -C node_modules/okaccelcache --strip-components=1
rm -f okaccelcache-0.1.0.tgz

npx prisma generate
npx vitest run
