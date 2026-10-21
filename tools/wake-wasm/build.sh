#!/usr/bin/env bash
# Rebuilds web/src/jarvis/wake/runtime/wake.wasm: TFLite Micro + the TFLM
# audio microfrontend + tools/wake-wasm/src/wake_api.cc, compiled with a
# pinned emscripten inside Docker. The built .wasm is committed, so nobody
# needs this to work on the web app; run it only when changing the C side.
#
#   tools/wake-wasm/build.sh            # build and overwrite the committed wasm
#   tools/wake-wasm/build.sh --check    # build to a temp file and compare bytes
#
# Pins (change together, then rebuild and commit the wasm):
#   - TFLite Micro commit (also the microfrontend source; the ESP32 desk
#     vendors the same files from this commit)
#   - emscripten 4.0.15 (Docker image, by digest)
set -euo pipefail

TFLM_COMMIT=b57ba0d0d40d66cc775fa06fbffcec9e0c50b2c8
EMSDK_TAG=4.0.15
# The arm64 and amd64 images are separate tags with the same emscripten.
EMSDK_ARM64=emscripten/emsdk@sha256:d4216eed0500d24261bbdbe91be922ca9518c8ff262f7e7d3a6f8729729a7713
EMSDK_AMD64=emscripten/emsdk@sha256:27bc6267cb285223b8aebb7627bfebae7cb3ad2aaa0d5923b8aa5321793033e8

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
cache="$here/.cache"
out="$root/web/src/jarvis/wake/runtime/wake.wasm"

case "$(uname -m)" in
  arm64 | aarch64) image="${WAKE_EMSDK_IMAGE:-$EMSDK_ARM64}" ;;
  *) image="${WAKE_EMSDK_IMAGE:-$EMSDK_AMD64}" ;;
esac

mkdir -p "$cache"
if [ ! -d "$cache/tflite-micro/.git" ] || [ "$(git -C "$cache/tflite-micro" rev-parse HEAD)" != "$TFLM_COMMIT" ]; then
  rm -rf "$cache/tflite-micro" "$cache/tflm-tree"
  git init -q "$cache/tflite-micro"
  git -C "$cache/tflite-micro" remote add origin https://github.com/tensorflow/tflite-micro.git
  git -C "$cache/tflite-micro" fetch -q --depth 1 origin "$TFLM_COMMIT"
  git -C "$cache/tflite-micro" checkout -q FETCH_HEAD
fi

mkdir -p "$cache/out"
docker run --rm -v "$here":/w -w /w "$image" bash /w/inner.sh "$EMSDK_TAG"

if [ "${1:-}" = "--check" ]; then
  if cmp -s "$cache/out/wake.wasm" "$out"; then
    echo "wake.wasm is current ($(wc -c <"$out" | tr -d ' ') bytes)"
  else
    echo "wake.wasm differs from a fresh build" >&2
    exit 1
  fi
else
  mkdir -p "$(dirname "$out")"
  cp "$cache/out/wake.wasm" "$out"
  # Licenses of everything linked into the wasm travel with it.
  lic="$(dirname "$out")/LICENSES"
  mkdir -p "$lic"
  cp "$cache/tflite-micro/LICENSE" "$lic/tflite-micro-LICENSE"
  cp "$cache/tflm-tree/third_party/flatbuffers/LICENSE" "$lic/flatbuffers-LICENSE"
  cp "$cache/tflm-tree/third_party/gemmlowp/LICENSE" "$lic/gemmlowp-LICENSE"
  cp "$cache/tflm-tree/third_party/kissfft/COPYING" "$lic/kissfft-COPYING"
  echo "wrote $out ($(wc -c <"$out" | tr -d ' ') bytes)"
fi
shasum -a 256 "$cache/out/wake.wasm"
