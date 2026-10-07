#!/usr/bin/env bash
#
# 构建整站。比直接 `hugo` 多做一步：先把缺 slug 的文件补上。
#
# 站点给 /zh/、/zj/ 启用了 [permalinks]，而 Hugo 展开 :slug 时若文章没写
# slug，会拿**中文标题**当地址。所以每次构建前先跑一遍补 slug（幂等，
# 已有 slug 的文件会跳过），免得新写的文章地址变成 /zh/2026/中文标题/。
#
# 用法：
#   ./scripts/build.sh                 # 生成到 public/
#   ./scripts/build.sh --baseURL=...   # 额外参数会原样传给 hugo
#
set -euo pipefail
cd "$(dirname "$0")/.."

python3 scripts/gen-slugs.py --apply

# Markdown 文章习惯写 tags，本站标签分类法却叫 keywords，不同步就一个标签
# 都显示不出来
python3 scripts/sync-tags.py --apply

# 页脚「本页最近更新」要用的日期表：从 git 里挑出真正改过正文的提交
python3 scripts/gen-lastmod.py

# 改过 permalinks 之后旧目录不会自己消失，清空再生成最省心
rm -rf public

hugo --minify --ignoreCache "$@"
