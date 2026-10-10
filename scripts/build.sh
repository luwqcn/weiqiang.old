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

# 图片瘦身：给 static/images 下的原图各配一张 webp（原图不动）。
# webp 落在 .cache/webp/ —— 不进仓库，也不塞进 static/ 让 hugo 拷。
python3 scripts/optimize-assets.py --skip-html --no-publish

# 改过 permalinks 之后旧目录不会自己消失，清空再生成最省心。
# 用 Hugo 自带的 --cleanDestinationDir 而不是 `rm -rf public`：
#   · 不依赖 shell，Windows / CI 上一样能跑
#   · 只删 Hugo 自己写过的东西，不会误伤 public/ 里放的手工文件
hugo --minify --ignoreCache --cleanDestinationDir "$@"

# 冷启动（--ignoreCache）时 Hugo 偶尔会把一个还没填好的资源先发布出去，
# 产物里就多一个 0 字节的 css/js（没有任何页面引用它，纯粹是脏东西）。
# -print 让它删了什么说一声，真出问题也看得见。
find public -type f \( -name '*.css' -o -name '*.js' \) -size 0 -print -delete

# 生成完了再回头改 HTML：给 <img> 补 width/height/loading，套上 webp。
# Org 走的不是 Hugo 的 render hook，图片只能在产出后这一步收拾。
python3 scripts/optimize-assets.py --skip-webp
