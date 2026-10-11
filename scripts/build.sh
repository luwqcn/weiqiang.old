#!/usr/bin/env bash
#
# 危墙生产构建：内容预处理 → 图片缓存 → Hugo 压缩导出 → 图片增强。
#
# 用法：
#   ./scripts/build.sh
#   ./scripts/build.sh --baseURL=https://example.com/
#   PREPARE_CONTENT=0 ./scripts/build.sh   # CI 中只构建，不改 front matter
#   OPTIMIZE_IMAGES=0 ./scripts/build.sh   # 无 vips 的环境跳过 webp
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

log() {
    printf '\n==> %s\n' "$1"
}

# 日常写作默认自动补 slug、整理 tags；CI/只读构建可显式关闭，避免工作区
# 产生副作用。两个脚本均为幂等操作。
if [[ "${PREPARE_CONTENT:-1}" == "1" ]]; then
    log "规范内容元数据"
    python3 scripts/gen-slugs.py --apply
    python3 scripts/normalize-tags.py --apply
fi

log "生成最近更新时间索引"
python3 scripts/gen-lastmod.py

# webp 放在 .cache/webp，原图不改；--prune 清掉已无对应原图的缓存项。
if [[ "${OPTIMIZE_IMAGES:-1}" == "1" ]]; then
    log "生成增量 webp 缓存"
    python3 scripts/optimize-assets.py --skip-html --no-publish --prune
fi

log "运行 Hugo 生产构建"
export HUGO_ENVIRONMENT="production"
# minifyOutput 也写进 hugo.toml，保证换平台直接运行 hugo 仍会压缩；这里保留
# --minify 是为了让脚本意图一眼可见。不要再加 --ignoreCache，它会放弃 Hugo
# 资源缓存并显著拖慢重复构建。
hugo --minify --gc --cleanDestinationDir "$@"

if [[ "${OPTIMIZE_IMAGES:-1}" == "1" ]]; then
    log "为导出 HTML 补图片尺寸、懒加载和 webp"
    python3 scripts/optimize-assets.py --skip-webp
fi

log "构建完成：public/"
