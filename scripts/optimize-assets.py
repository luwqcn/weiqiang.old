#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
optimize-assets.py — 构建产物瘦身。

  1. 图片：给 static/images 下的 jpg / png 各生成一张 webp 优化版
     （限制最大宽度，默认 1600px）。原图一律不动。
     生成的 webp 放在 .cache/webp/ —— 不进仓库，构建时再拷进 public/。
     支持 webp 的浏览器加载它，不支持的自动回退原图。

  2. HTML：给 public/ 里每个 <img> 补上 width / height / loading / decoding，
     并把 webp 包进 <picture>。顺手清掉 Org 导出留下的
     `alt="/images/x.jpg" title="/images/x.jpg"` —— 那会让屏幕阅读器念一整串
     路径，鼠标悬停还会弹出路径气泡。

用法：
    python3 scripts/optimize-assets.py                 # 全做（增量）
    python3 scripts/optimize-assets.py --force         # 忽略缓存，重生成全部 webp
    python3 scripts/optimize-assets.py --skip-webp     # 不生成，只拷贝 + 改 HTML
    python3 scripts/optimize-assets.py --skip-html     # 只生成 webp
    python3 scripts/optimize-assets.py --prune         # 删掉没有原图的 webp

依赖：vips（本机有；没有就自动跳过第 1 步，第 2 步照常工作）。
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IMG_DIR = ROOT / "static" / "images"
CACHE_DIR = ROOT / ".cache" / "webp"     # 生成的 webp 缓存，不进仓库
PUBLIC = ROOT / "public"
PUBLIC_IMG = PUBLIC / "images"

MAX_WIDTH = 1600          # 正文列约 850px，2 倍图够清晰了
SRC_EXT = {".jpg", ".jpeg", ".png"}
VIPS = shutil.which("vips")


# --------------------------------------------------------------------------
# 1. 图片尺寸：直接读文件头，比调 vipsheader 快两个数量级
# --------------------------------------------------------------------------

def _jpeg_size(path: Path):
    with path.open("rb") as fh:
        data = fh.read()
    i, n = 2, len(data)
    while i < n - 9:
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        seglen = int.from_bytes(data[i + 2:i + 4], "big")
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
                      0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            h = int.from_bytes(data[i + 5:i + 7], "big")
            w = int.from_bytes(data[i + 7:i + 9], "big")
            return w, h
        i += 2 + seglen
    return None


def _png_size(path: Path):
    with path.open("rb") as fh:
        head = fh.read(24)
    if len(head) < 24 or head[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    return (int.from_bytes(head[16:20], "big"),
            int.from_bytes(head[20:24], "big"))


def image_size(path: Path):
    ext = path.suffix.lower()
    try:
        if ext in (".jpg", ".jpeg"):
            return _jpeg_size(path)
        if ext == ".png":
            return _png_size(path)
    except OSError:
        pass
    return None


# --------------------------------------------------------------------------
# 2. 生成 webp（放到 .cache，不进仓库）
# --------------------------------------------------------------------------

def cache_path(src: Path) -> Path:
    return CACHE_DIR / src.relative_to(IMG_DIR).with_name(src.name + ".webp")


def _run(cmd: list[str]) -> bool:
    # vips 启动时会往 stderr 打几条 magick / poppler 的加载警告，无害，丢掉
    return subprocess.run(cmd, stdout=subprocess.DEVNULL,
                          stderr=subprocess.DEVNULL).returncode == 0


def make_webp(src: Path, dst: Path, force: bool) -> str:
    if not force and dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
        return "skip"
    dst.parent.mkdir(parents=True, exist_ok=True)

    size = image_size(src)
    if size and size[0] > MAX_WIDTH:
        ok = _run([VIPS, "thumbnail", str(src), str(dst), str(MAX_WIDTH)])
    else:
        ok = _run([VIPS, "webpsave", str(src), str(dst), "--Q", "80"])
    if not ok and dst.exists():
        dst.unlink()
    return "ok" if ok else "fail"


def step_webp(force: bool, prune: bool) -> None:
    if not VIPS:
        print("optimize-assets: 没找到 vips，跳过 webp 生成", file=sys.stderr)
        return
    if not IMG_DIR.is_dir():
        return

    jobs = []
    for src in sorted(IMG_DIR.rglob("*")):
        if src.is_file() and src.suffix.lower() in SRC_EXT:
            jobs.append((src, cache_path(src)))

    if prune:
        live = {d for _, d in jobs}
        for stale in sorted(CACHE_DIR.rglob("*.webp")):
            if stale not in live:
                stale.unlink()
                print(f"  删除孤立 {stale.relative_to(ROOT)}")

    with ThreadPoolExecutor(max_workers=os.cpu_count() or 4) as pool:
        results = list(pool.map(lambda j: make_webp(j[0], j[1], force), jobs))

    print(f"webp: 新生成 {results.count('ok')} 张，"
          f"跳过 {results.count('skip')} 张，失败 {results.count('fail')} 张"
          f"（共 {len(jobs)} 张原图）")


def step_publish() -> None:
    """把缓存里的 webp 拷进 public/images，让 <picture> 指得到。"""
    if not CACHE_DIR.is_dir():
        return
    if not PUBLIC_IMG.is_dir():
        print("optimize-assets: public/images/ 不存在，先构建", file=sys.stderr)
        return
    n = 0
    for src in sorted(CACHE_DIR.rglob("*.webp")):
        dst = PUBLIC_IMG / src.relative_to(CACHE_DIR)
        if dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        n += 1
    print(f"webp: 拷进 public/ {n} 张")


# --------------------------------------------------------------------------
# 3. 改 HTML
# --------------------------------------------------------------------------

IMG_RE = re.compile(r"<img\b[^>]*>", re.IGNORECASE)
# 值可以带双引号、单引号，也可以裸着（hugo --minify 会把引号去掉）
ATTR_RE = re.compile(
    r'([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|\'([^\']*)\'|([^\s"\'>=`]+))')


def parse_attrs(tag: str) -> dict:
    out = {}
    inner = tag[4:-1] if tag.endswith(">") else tag
    for m in ATTR_RE.finditer(inner):
        val = m.group(3)
        if val is None:
            val = m.group(4)
        if val is None:
            val = m.group(5)
        out[m.group(1).lower()] = val or ""
    return out


def build_img(attrs: dict, order: list[str]) -> str:
    parts = ["<img"]
    for key in order:
        parts.append(f'{key}="{attrs[key]}"')
    return " ".join(parts) + ">"


def rewrite_html(path: Path, seen: dict) -> tuple[int, int]:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return 0, 0

    stats = {"img": 0, "webp": 0}
    first = [True]   # 第一张图多半在首屏，不懒加载

    def repl(m: re.Match) -> str:
        tag = m.group(0)
        attrs = parse_attrs(tag)
        src = attrs.get("src", "")
        if not src.startswith("/images/"):
            return tag

        stats["img"] += 1
        rel = src.lstrip("/")
        src_file = ROOT / "static" / rel

        # ---- 尺寸：给浏览器预留空间，图片加载完不再跳版 ----
        if "width" not in attrs and "height" not in attrs:
            size = seen.get(rel)
            if size is None:
                size = image_size(src_file)
                if size:
                    w, h = size
                    # 显示的是缩放后的 webp，尺寸按比例换算
                    if w > MAX_WIDTH and (src_file.with_name(src_file.name + ".webp").exists()
                                          or (PUBLIC_IMG / rel[7:]).with_name(
                                              Path(rel).name + ".webp").exists()):
                        h = round(h * MAX_WIDTH / w)
                        w = MAX_WIDTH
                    size = (w, h)
                seen[rel] = size
            if size:
                attrs["width"], attrs["height"] = str(size[0]), str(size[1])

        # ---- 懒加载 / 异步解码 ----
        # 首张图通常参与 LCP：即使模板先写了 loading="lazy"，生产构建也要
        # 覆盖成 eager；其余图片默认懒加载。
        attrs["loading"] = "eager" if first[0] else attrs.get("loading", "lazy")
        if "decoding" not in attrs:
            attrs["decoding"] = "async"
        if first[0]:
            attrs["fetchpriority"] = "high"

        # ---- Org 导出会把路径写进 alt / title，清掉 ----
        # 旧文没有替代文字时显式写空 alt，至少避免读屏器念出文件名路径。
        if "alt" not in attrs:
            attrs["alt"] = ""
        if attrs.get("alt", "").lstrip("/") == src.lstrip("/"):
            attrs["alt"] = ""
        if attrs.get("title") == src:
            del attrs["title"]

        # ---- 属性顺序：src 在前，视觉属性紧随，其余按原顺序 ----
        order = [k for k in ("src", "alt", "width", "height", "loading",
                             "decoding", "fetchpriority", "class", "srcset")
                 if k in attrs]
        order += [k for k in attrs if k not in order]
        new_tag = build_img(attrs, order)
        first[0] = False

        # ---- 有 webp 就包一层 <picture>，浏览器自己挑 ----
        webp = PUBLIC_IMG / rel[len("images/"):]
        webp = webp.with_name(webp.name + ".webp")
        if webp.exists():
            stats["webp"] += 1
            return (f'<picture><source srcset="{src}.webp" type="image/webp">'
                    f'{new_tag}</picture>')
        return new_tag

    new_text = IMG_RE.sub(repl, text)
    if new_text != text:
        path.write_text(new_text, encoding="utf-8")
    return stats["img"], stats["webp"]


def step_html() -> None:
    if not PUBLIC.is_dir():
        print("optimize-assets: public/ 不存在，先构建", file=sys.stderr)
        return
    pages = sorted(PUBLIC.rglob("*.html"))
    cache: dict = {}
    total_img = total_webp = 0
    for page in pages:
        n_img, n_webp = rewrite_html(page, cache)
        total_img += n_img
        total_webp += n_webp
    print(f"html: 处理 {len(pages)} 个页面，{total_img} 个 <img>，"
          f"其中 {total_webp} 个包上了 webp")


# --------------------------------------------------------------------------

def main() -> None:
    ap = argparse.ArgumentParser(description="静态资源瘦身：webp + HTML 图片增强")
    ap.add_argument("--force", action="store_true", help="重生成全部 webp")
    ap.add_argument("--prune", action="store_true", help="删掉没有原图的 webp")
    ap.add_argument("--skip-webp", action="store_true", help="不调用 vips 生成")
    ap.add_argument("--skip-html", action="store_true", help="不改 HTML")
    ap.add_argument("--no-publish", action="store_true", help="不把 webp 拷进 public/")
    args = ap.parse_args()

    if not args.skip_webp:
        step_webp(args.force, args.prune)
    if not args.no_publish:
        step_publish()
    if not args.skip_html:
        step_html()


if __name__ == "__main__":
    main()
