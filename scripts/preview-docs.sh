#!/usr/bin/env bash
# Local preview of the GitHub Pages docs site: builds the pages flavor,
# copies the coding-agent guides in, and serves the result.
#
# Usage: scripts/preview-docs.sh [port]   (default 8000)
#
# Storybook is assembled only in CI, so /storybook/ 404s here — expected.
set -euo pipefail
cd "$(dirname "$0")/.."

out=/tmp/agora-site
port="${1:-8000}"

rm -rf "$out"
node scripts/build-docs.mjs --out "$out" --flavor pages
cp -a web/public/docs/coding-agents "$out/coding-agents"
cp -a web/public/docs/agents/. "$out/agents/"

echo "Docs preview: http://localhost:$port/  (Ctrl-C to stop)"
python3 -m http.server "$port" --directory "$out"
