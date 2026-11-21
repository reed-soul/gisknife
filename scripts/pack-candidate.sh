#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
destination=${1:-"$root/tmp/candidate"}
mkdir -p "$destination"
destination=$(cd "$destination" && pwd)
cd "$root"
if compgen -G "$destination/*.tgz" >/dev/null || compgen -G "$destination/*.whl" >/dev/null || compgen -G "$destination/*.tar.gz" >/dev/null; then
  echo 'Choose an empty package destination; do not mix different builds.' >&2
  exit 1
fi
pnpm build
for package in packages/*; do
  pnpm --dir "$package" pack --pack-destination "$destination"
done
uv build python/gisknife-engine --out-dir "$destination"
(cd "$destination" && shasum -a 256 ./*.tgz ./*.whl ./*.tar.gz > SHA256SUMS)
