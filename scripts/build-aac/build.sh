#!/usr/bin/env bash
# Rebuild the separately licensed AAC library. Run from the extracted source kit.
set -euo pipefail
recipe_dir="$(cd "$(dirname "$0")" && pwd)"
source_root="${AAC_SOURCE_ROOT:-$recipe_dir/../source}"
ffmpeg_root="${AAC_FFMPEG_ROOT:-$source_root/ffmpeg}"
mediabunny_root="$source_root/mediabunny"
output_root="${AAC_OUTPUT_ROOT:-$recipe_dir/../output}"
emcc --version | head -1 | grep -q '4.0.10' || {
  echo 'Activate the pinned Emscripten 4.0.10 toolchain first.' >&2; exit 1;
}
test -f "$ffmpeg_root/libavcodec/aacenc.c"
test -f "$mediabunny_root/packages/aac-encoder/src/bridge.c"
test ! -e "$output_root" || { echo 'Output already exists; choose a fresh AAC_OUTPUT_ROOT.' >&2; exit 1; }
mkdir -p "$output_root/package" "$output_root/evidence"

cd "$ffmpeg_root"
emconfigure ./configure \
  --target-os=none --arch=x86_32 --enable-cross-compile \
  --disable-asm --disable-x86asm --disable-inline-asm \
  --disable-programs --disable-doc --disable-debug \
  --disable-all --disable-everything --disable-autodetect \
  --disable-pthreads --disable-runtime-cpudetect \
  --disable-gpl --disable-nonfree --disable-version3 \
  --enable-avcodec --enable-encoder=aac \
  --cc=emcc --cxx=em++ --ar=emar --ranlib=emranlib \
  --extra-cflags='-DNDEBUG -Oz -flto -msimd128' \
  --extra-ldflags='-Oz -flto' > "$output_root/evidence/configure.log" 2>&1
emmake make -j"${AAC_BUILD_JOBS:-4}" > "$output_root/evidence/make.log" 2>&1
grep -q '^#define CONFIG_GPL 0$' config.h
grep -q '^#define CONFIG_NONFREE 0$' config.h
grep -q '^#define CONFIG_VERSION3 0$' config.h
cp config.h config_components.h ffbuild/config.mak "$output_root/evidence/"

cd "$mediabunny_root/packages/aac-encoder"
mkdir -p build
emcc -c src/bridge.c -I"$ffmpeg_root" -msimd128 -flto -Oz -o build/bridge.o
emcc build/bridge.o "$ffmpeg_root/libavcodec/libavcodec.a" "$ffmpeg_root/libavutil/libavutil.a" \
  -s MODULARIZE=1 -s EXPORT_ES6=1 -s SINGLE_FILE=1 \
  -s ALLOW_MEMORY_GROWTH=1 -s ENVIRONMENT=web,worker \
  -s FILESYSTEM=0 -s MALLOC=emmalloc -s SUPPORT_LONGJMP=0 \
  -s DYNAMIC_EXECUTION=0 -s EXPORTED_RUNTIME_METHODS=cwrap,HEAPU8 \
  -s EXPORTED_FUNCTIONS=_malloc,_free -msimd128 -flto -Oz -o build/aac.js

# Install only the exact build tools in this source kit's lockfile.
cd "$recipe_dir"
npm ci --ignore-scripts --no-audit --no-fund
node bundle.mjs "$mediabunny_root" "$output_root/package"
node package.mjs "$mediabunny_root" "$output_root/package"
cd "$output_root/package"
npm pack --ignore-scripts --pack-destination "$output_root"
echo "Rebuilt package and configuration evidence: $output_root"
