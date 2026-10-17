#!/usr/bin/env bash
# Rebuilds vendor/anthropic-sdk-<version>.mjs: the Anthropic TypeScript SDK bundled into
# one browser ES module, so the page loads no third-party script at runtime.
# Usage: scripts/build-sdk.sh 0.131.0   (then update the import in llm.js and sw.js)
set -euo pipefail
v="${1:?SDK version}"
root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
cd "$tmp"
npm init -y >/dev/null
npm i --silent "@anthropic-ai/sdk@$v" esbuild@0.25.0
echo 'export { default } from "@anthropic-ai/sdk";' > entry.js
npx esbuild entry.js --bundle --format=esm --platform=browser --target=es2022 --minify \
  --outfile="$root/vendor/anthropic-sdk-$v.mjs"
rm -rf "$tmp"
