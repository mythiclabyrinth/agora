#!/usr/bin/env bash
# Cross-checks wake.wasm's frontend against the ESP32 desk's *vendored*
# microfrontend (Esp32Agent/src/microfrontend), configured as Wake.cpp does,
# and writes the golden features the web test asserts
# (web/src/jarvis/wake/__fixtures__/golden-features.json).
#
#   tools/wake-wasm/host/check-features.sh [path/to/Esp32Agent]
#
# Two builds of features_dump.cc + the vendored sources:
#   - emscripten (same pinned image as build.sh): the golden. It isolates the
#     *source*: any difference from wake.wasm would be a code difference.
#   - native (the host's cc): reported only. The frontend's runtime is pure
#     integer, but its init tables (window, mel filterbank weights, PCAN LUT,
#     FFT twiddles) are computed once with libm floats, so a different libm
#     can move a table entry by 1 LSB (on macOS/arm64: one filterbank weight)
#     and a few feature values by a few units. The ESP32's newlib is a third
#     libm; see docs/JARVIS_WAKE.md.
#
# Needs Docker and the TFLM tree from tools/wake-wasm/build.sh (for kissfft).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
wasmdir="$(cd "$here/.." && pwd)"
root="$(cd "$wasmdir/../.." && pwd)"
esp="${1:-$HOME/Coding/Arduino/Esp32Agent}"
cache="$wasmdir/.cache"
fixtures="$root/web/src/jarvis/wake/__fixtures__"
case "$(uname -m)" in
  arm64 | aarch64) image="$(sed -n 's/^EMSDK_ARM64=//p' "$wasmdir/build.sh")" ;;
  *) image="$(sed -n 's/^EMSDK_AMD64=//p' "$wasmdir/build.sh")" ;;
esac

[ -d "$esp/src/microfrontend/lib" ] || { echo "no vendored microfrontend under $esp" >&2; exit 1; }
[ -d "$cache/tflm-tree/third_party/kissfft" ] || { echo "run tools/wake-wasm/build.sh first" >&2; exit 1; }

rm -rf "$cache/esp" && mkdir -p "$cache/esp"
cp -R "$esp/src/microfrontend/lib" "$cache/esp/lib"
cp -R "$cache/tflm-tree/third_party/kissfft" "$cache/esp/kissfft"
cp "$here/features_dump.cc" "$here/kiss_fft_fixed16.cc" "$cache/esp/"

# shellcheck disable=SC2016
build='set -e; cd "$1"; CC="$2"; CXX="$3"; OUT="$4"; o=()
  for f in lib/*.c; do "$CC" -O2 -Ilib -Ikissfft -c "$f" -o "$f.o"; o+=("$f.o"); done
  for f in lib/*.cc kiss_fft_fixed16.cc features_dump.cc; do "$CXX" -O2 -std=c++17 -Ilib -Ikissfft -c "$f" -o "$f.o"; o+=("$f.o"); done
  "$CXX" "${o[@]}" $EXTRA -o "$OUT"; rm -f lib/*.o ./*.o'
docker run --rm -v "$cache/esp":/esp -e EXTRA="-sNODERAWFS=1 -sALLOW_MEMORY_GROWTH=1" "$image" \
  bash -c "$build" _ /esp emcc em++ dump.js
EXTRA="" bash -c "$build" _ "$cache/esp" cc c++ dump-native

golden="$fixtures/golden-features.json"
{
  echo "{"
  first=1
  for wav in "$fixtures"/*.wav; do
    name="$(basename "$wav")"
    node "$cache/esp/dump.js" "$wav" > "$cache/esp/wasm.u16"
    "$cache/esp/dump-native" "$wav" > "$cache/esp/native.u16"
    frames=$(( $(wc -c < "$cache/esp/wasm.u16") / 80 ))
    sha="$(shasum -a 256 "$cache/esp/wasm.u16" | cut -d' ' -f1)"
    node -e '
      const fs = require("fs");
      const read = (p) => { const b = fs.readFileSync(p); return new Uint16Array(b.buffer, b.byteOffset, b.length / 2); };
      const a = read(process.argv[1]), b = read(process.argv[2]);
      let n = 0, max = 0;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { n++; max = Math.max(max, Math.abs(a[i] - b[i])); }
      console.error(`${process.argv[3]}: ${a.length / 40} frames; native ${process.platform}/${process.arch} build differs in ${n} of ${a.length} values (max ${max})`);
    ' "$cache/esp/wasm.u16" "$cache/esp/native.u16" "$name"
    [ $first = 1 ] || echo ","
    first=0
    printf '  "%s": { "frames": %d, "sha256": "%s" }' "$name" "$frames" "$sha"
  done
  echo
  echo "}"
} > "$golden"
cat "$golden"
