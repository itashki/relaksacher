#!/bin/sh
# Build the AOT executable using this project's pinned Nix Bun, from any directory.
set -eu

cd -- "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec nix shell path:.#bun-canary --command bun scripts/build.ts "$@"
