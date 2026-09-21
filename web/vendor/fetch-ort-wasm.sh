#!/usr/bin/env bash
# 把 ONNX Runtime 的 WASM 二进制下到 web/vendor/transformers/ort/，
# 让本地 Whisper 识别完全不依赖 CDN（打 Electron 桌面版前跑一次）。
#
# 这两个文件加起来 41 MB，别 commit 进 git。
#
#   用法：bash web/vendor/fetch-ort-wasm.sh

set -euo pipefail

# 必须和 @huggingface/transformers 锁定的 onnxruntime-web 版本完全一致，
# 版本对不上 WASM 工厂和二进制会互相不认。
# 查法：cat node_modules/onnxruntime-web/package.json | grep '"version"'
ORT_VERSION="1.31.0-dev.20260914-8d85527a0"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/transformers/ort"
BASE="https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist"

mkdir -p "$DIR"

for f in ort-wasm-simd-threaded.asyncify.wasm ort-wasm-simd-threaded.wasm; do
  if [ -f "$DIR/$f" ]; then
    echo "已存在，跳过：$f"
    continue
  fi
  echo "下载 $f ..."
  curl -fL --progress-bar -o "$DIR/$f.part" "$BASE/$f"
  mv "$DIR/$f.part" "$DIR/$f"
done

echo
echo "完成。目录内容："
ls -lh "$DIR"
echo
echo "提示：把这两个 .wasm 加进 .gitignore，别提交到仓库。"
