#!/usr/bin/env bash
#
# 起本地预览（http://localhost:1313/）。
#
# 比直接 `hugo server` 多做两步：补 slug、把 Markdown 的 tags 同步成
# keywords —— 直接从命令行跑 hugo server 的话这两步不会执行，新写的
# Markdown 文章就会连标签都不显示。
#
# 用法：
#   ./scripts/serve.sh                 # http://localhost:1313/
#   ./scripts/serve.sh --port 1314     # 额外参数原样传给 hugo server
#
set -euo pipefail
cd "$(dirname "$0")/.."

python3 scripts/gen-slugs.py --apply
python3 scripts/sync-tags.py --apply

hugo server --disableFastRender "$@"
