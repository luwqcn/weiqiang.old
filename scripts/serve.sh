#!/usr/bin/env bash
#
# 起本地预览（http://localhost:1313/）。
#
# 比直接 `hugo server` 多做两步：补 slug、规范 tags（去尾逗号与重复词）——
# 直接从命令行跑 hugo server 的话这两步不会执行，新写的文章地址可能变成
# 中文、标签也可能带着垃圾字符。
#
# 用法：
#   ./scripts/serve.sh                 # http://localhost:1313/
#   ./scripts/serve.sh --port 1314     # 额外参数原样传给 hugo server
#
set -euo pipefail
cd "$(dirname "$0")/.."

python3 scripts/gen-slugs.py --apply
python3 scripts/normalize-tags.py --apply

hugo server --disableFastRender "$@"
