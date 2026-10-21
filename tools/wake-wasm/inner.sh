#!/usr/bin/env bash
# Runs inside the pinned emscripten image (see build.sh). /w is tools/wake-wasm.
set -euo pipefail

want="$1"
have="$(emcc --version | head -1 | sed -E 's/.* ([0-9]+\.[0-9]+\.[0-9]+) .*/\1/')"
if [ "$have" != "$want" ]; then
  echo "expected emscripten $want, got $have" >&2
  exit 1
fi

cache=/w/.cache
tflm="$cache/tflite-micro"
tree="$cache/tflm-tree"

# TFLM's own generator lists exactly the library sources and fetches its
# pinned third-party deps (flatbuffers, gemmlowp, ruy, kissfft).
if [ ! -d "$tree/tensorflow" ]; then
  (cd "$tflm" && python3 tensorflow/lite/micro/tools/project_generation/create_tflm_tree.py "$tree")
fi

# The microfrontend is not part of the TFLM library tree; take it from the
# same commit. kiss_fft_int16.cc #includes kissfft's C files as FIXED_POINT=16.
fe_src="$tflm/tensorflow/lite/experimental/microfrontend/lib"
fe_dst="$tree/tensorflow/lite/experimental/microfrontend/lib"
rm -rf "$fe_dst" && mkdir -p "$fe_dst"
for f in "$fe_src"/*.c "$fe_src"/*.cc "$fe_src"/*.h; do
  case "$(basename "$f")" in
    *_test.cc | *_io.c | *_io.h | *_main.c | *_main.cc | *memmap*) continue ;;
  esac
  cp "$f" "$fe_dst/"
done

flags=(
  -O3 -DNDEBUG -DTF_LITE_STATIC_MEMORY -DTF_LITE_STRIP_ERROR_STRINGS
  -I"$tree" -I"$tree/third_party/flatbuffers/include" -I"$tree/third_party/gemmlowp"
  -I"$tree/third_party/ruy" -I"$tree/third_party/kissfft"
  -ffile-prefix-map="$tree"=. -ffile-prefix-map=/w=.
  -fno-exceptions -fno-rtti -fno-unwind-tables -fno-threadsafe-statics
)

objdir="$cache/obj"
rm -rf "$objdir"
mkdir -p "$objdir"

# Everything in the library tree except signal/ (DSP ops these models do not
# use) and kissfft's .c files (pulled in by the int16 wrapper above).
mapfile -t sources < <(
  cd "$tree" && find tensorflow -type f \( -name '*.cc' -o -name '*.c' \) | LC_ALL=C sort
)
sources+=("/w/src/wake_api.cc")

objs=()
for src in "${sources[@]}"; do
  path="$src"
  [ "${src:0:1}" = "/" ] || path="$tree/$src"
  obj="$objdir/$(echo "$src" | tr '/' '_').o"
  case "$src" in
    *.c) emcc -std=c11 "${flags[@]}" -c "$path" -o "$obj" ;;
    *) em++ -std=c++17 "${flags[@]}" -c "$path" -o "$obj" ;;
  esac
  objs+=("$obj")
done

exports='_wake_frontend_init,_wake_frontend_process,_wake_model_load,_wake_model_input,_wake_model_invoke,_wake_model_arena_used,_wake_model_reset,_wake_model_free,_wake_malloc,_wake_free'

mkdir -p /w/.cache/out
em++ -O3 "${objs[@]}" -o /w/.cache/out/wake.wasm \
  -sSTANDALONE_WASM=1 --no-entry \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=2MB -sSTACK_SIZE=64KB \
  -sEXPORTED_FUNCTIONS="$exports" \
  -sFILESYSTEM=0 -sASSERTIONS=0 -sERROR_ON_UNDEFINED_SYMBOLS=1
