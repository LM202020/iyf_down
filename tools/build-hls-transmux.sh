#!/bin/sh
# 重建 lib/hls-transmux.min.js —— 从 hls.js 源码抽 TS→fMP4 转封装,不含播放/MSE/ABR。
# 用法:sh tools/build-hls-transmux.sh   (需要 node/npm,会在临时目录装依赖)
set -e
HLS_VERSION=1.6.16
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
npm init -y >/dev/null
# @svta/common-media-library 与 url-toolkit 是 hls.js 源码的直接依赖
npm i --silent --no-audit --no-fund \
    "hls.js@$HLS_VERSION" esbuild @svta/common-media-library url-toolkit
cp "$ROOT/tools/hls-transmux-entry.js" entry.js

# __USE_M2TS_ADVANCED_CODECS__ 必须为 true,否则 HEVC 的 hvc1 init segment 会被编译成空
npx esbuild entry.js --bundle --format=iife --global-name=HlsTransmux --minify \
    --loader:.ts=ts --resolve-extensions=.ts,.js --target=chrome110 \
    --define:__USE_M2TS_ADVANCED_CODECS__=true \
    --define:__USE_ALT_AUDIO__=false --define:__USE_EME_DRM__=false \
    --define:__USE_CMCD__=false --define:__USE_CONTENT_STEERING__=false \
    --define:__USE_INTERSTITIALS__=false --define:__USE_MEDIA_CAPABILITIES__=false \
    --define:__USE_SUBTITLES__=false --define:__USE_VARIABLE_SUBSTITUTION__=false \
    --define:__IN_WORKER__=false --define:__HLS_WORKER_BUNDLE__=false \
    --define:__VERSION__="\"$HLS_VERSION\"" \
    --outfile="$ROOT/lib/hls-transmux.min.js"

echo "已生成 $ROOT/lib/hls-transmux.min.js"
