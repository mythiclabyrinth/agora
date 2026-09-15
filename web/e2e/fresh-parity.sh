#!/usr/bin/env bash
# Run the parity regression suite against a server nobody has touched.
#
# parity.mjs seeds idempotently but its checks assume fresh-ish state — re-running
# it against a server that has already been driven produces failures that are
# about the data, not the code. This starts a throwaway server on a free port
# with its own data dir, runs the suite, and tears the server down again, so the
# fixtures are isolated and nobody has to own a long-lived process.
#
#   web/e2e/fresh-parity.sh              # the whole suite
#   web/e2e/fresh-parity.sh /threads     # against a different entry path
#
# Honours PW_WS (drive a shared Playwright server instead of launching Chromium)
# and AGORA_SERVER_BIN (defaults to the Cargo debug build).

set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$here/../.." && pwd)
bin=${AGORA_SERVER_BIN:-${CARGO_TARGET_DIR:-$root/target}/debug/agora-server}
app_path=${1:-/}

[[ -x "$bin" ]] || {
  echo "fresh-parity: no server binary at $bin" >&2
  echo "  build one with: cargo build -p agora-server   (then AGORA_SERVER_BIN=<path>)" >&2
  exit 2
}
[[ -d "$root/web/dist" ]] || {
  echo "fresh-parity: web/dist missing — run: npm run build -w web" >&2
  exit 2
}

# Ask the kernel for an unused port instead of using a shared fixed port.
port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
data_dir=$(mktemp -d /tmp/agora-parity-XXXXXX)
log=$data_dir/server.log

cleanup() {
  if [[ -n "${server_pid:-}" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true   # reap it quietly; no "Terminated" noise
  fi
  rm -rf "$data_dir"
}
trap cleanup EXIT

AGORA_PORT=$port "$bin" --data-dir "$data_dir" --ui-dir "$root/web/dist" > "$log" 2>&1 &
server_pid=$!

token=""
for _ in $(seq 1 60); do
  if token=$(grep -m1 -o '^Admin key: .*' "$log" 2>/dev/null | cut -d' ' -f3); [[ -n "$token" ]]; then break; fi
  kill -0 "$server_pid" 2>/dev/null || { echo "fresh-parity: server died:" >&2; cat "$log" >&2; exit 1; }
  sleep 0.5
done
[[ -n "$token" ]] || { echo "fresh-parity: server never printed an admin key:" >&2; cat "$log" >&2; exit 1; }

echo "fresh-parity: server on 127.0.0.1:$port, data dir $data_dir"
AGORA_BASE="http://127.0.0.1:$port" AGORA_TOKEN="$token" node "$here/parity.mjs" "$app_path"
