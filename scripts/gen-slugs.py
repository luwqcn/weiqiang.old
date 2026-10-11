#!/usr/bin/env python3
"""
给内容文件补上 #+SLUG:（Org）/ slug:（Markdown），把「文件名前面的日期」摘掉。

为什么需要它
------------
站点启用了 [permalinks] 之后，Hugo 展开 :slug 时若文章没写 slug，会退回用
**中文标题** 当地址（/zh/2026/人生无意义/），而不是文件名。所以只要用了
permalinks，每篇文章都得有显式 slug。

本脚本按这条规则生成 slug：
    2026-07-05-rensheng-yiyi.org  →  rensheng-yiyi
    没有日期前缀的文件           →  原样用文件名（等价于现在的地址）

用法
----
    python3 scripts/gen-slugs.py          # 干跑：只报告要改什么、有无冲突
    python3 scripts/gen-slugs.py --apply  # 真的写进文件

想换作用范围，改下面的 SECTIONS。
已经写过 #+SLUG: / slug: 的文件会跳过，重复执行安全（幂等）。
"""

import argparse
import collections
import os
import re
import sys

try:
    import tomllib  # Python 3.11+
except ImportError:  # pragma: no cover
    tomllib = None

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "content")
CONFIG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "hugo.toml")

# 兜底范围：只有按日期命名的网志类栏目才需要处理（/zh/ 网志）。
# /xy/ 习艺、/bc/ 本草、/yue/ 乐记 是导览/专题型内容，文件名本就没有日期，
# 保持原地址更合适。正常情况下不用改这里 —— 脚本会读 hugo.toml 的
# [permalinks] 自动决定范围，以后给新栏目加 permalinks 会自己跟上。
# （/zj/ 支教已并入 /zh/，见 content/series/zj/_index.md）
FALLBACK_SECTIONS = ("zh",)


def sections_from_config():
    """要处理的栏目 = hugo.toml 里启用 [permalinks] 的那些。

    只有启用 permalinks 的栏目才会踩「没 slug 就拿中文标题当地址」这个坑，
    所以「配置里写了谁」就是最可靠的范围，不用手工维护列表。
    读不到配置（或解析失败）就退回 FALLBACK_SECTIONS。
    """
    if tomllib is None:
        return list(FALLBACK_SECTIONS)
    try:
        with open(CONFIG, "rb") as fh:
            data = tomllib.load(fh)
    except Exception:
        return list(FALLBACK_SECTIONS)
    perms = data.get("permalinks") or {}
    keys = [k for k in perms if os.path.isdir(os.path.join(ROOT, k))]
    return keys or list(FALLBACK_SECTIONS)

DATED = re.compile(r"^(\d{4})-(\d{2})-(\d{2})-(.+)$")
ORG_SLUG = re.compile(r"^#\+SLUG:", re.IGNORECASE | re.MULTILINE)
# Markdown 的 slug 有两种写法：YAML 头是 `slug: x`，TOML 头是 `slug = "x"`。
# 只认前一种的话，TOML 的文章会被当成「没写 slug」，再往 +++ 里塞一行 YAML
# 语法的 `slug: x`，Hugo 直接报 "expected '=' after key"，整站构建失败。
MD_SLUG = re.compile(r"^slug\s*[:=]", re.IGNORECASE | re.MULTILINE)
ORG_DATE = re.compile(r"^#\+DATE:\s*(\d{4})-\d{2}-\d{2}", re.IGNORECASE | re.MULTILINE)
MD_DATE = re.compile(r"^date\s*=\s*['\"]?(\d{4})-\d{2}-\d{2}", re.IGNORECASE | re.MULTILINE)


def collect(sections):
    files = []
    for sec in sections:
        d = os.path.join(ROOT, sec)
        for dirpath, _dirs, names in os.walk(d):
            for n in sorted(names):
                # Emacs 的锁文件 / 自动保存 / 备份都不是内容：
                #   .#xxx.org  锁（指向不存在目标的符号链接，open 会直接炸）
                #   #xxx#      自动保存      xxx~  备份
                if n.startswith("_") or n.startswith(".") or n.startswith("#") or n.endswith("~"):
                    continue
                p = os.path.join(dirpath, n)
                if os.path.islink(p):
                    continue
                if n.endswith(".org"):
                    files.append((p, "org"))
                elif n.endswith(".md"):
                    files.append((p, "md"))
    return files


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="真的写入文件（默认只干跑）")
    ap.add_argument("--check", action="store_true",
                    help="只检查：有缺 slug 的文件就打印并退出码 1（给 CI / 构建前用）")
    args = ap.parse_args()

    sections = sections_from_config()
    todo, skipped, conflicts = [], 0, collections.defaultdict(list)
    year_mismatch = []

    for path, kind in collect(sections):
        base = os.path.basename(path).rsplit(".", 1)[0]
        text = open(path, encoding="utf-8").read()

        has = ORG_SLUG.search(text) if kind == "org" else MD_SLUG.search(text)
        if has:
            skipped += 1
            continue

        m = DATED.match(base)
        slug = m.group(4) if m else base

        rel = os.path.relpath(path, ROOT)
        sec = rel.split(os.sep)[0]

        # 同一栏目 + 同一年份 + 同一 slug 才会撞地址，按这个粒度查重
        dm = (ORG_DATE if kind == "org" else MD_DATE).search(text)
        year = dm.group(1) if dm else (m.group(1) if m else "????")
        if m and dm and m.group(1) != dm.group(1):
            year_mismatch.append((rel, m.group(1), dm.group(1)))

        conflicts[(sec, year, slug)].append(rel)
        todo.append((path, kind, slug))

    dup = {k: v for k, v in conflicts.items() if len(v) > 1}

    print(f"作用栏目（来自 hugo.toml 的 [permalinks]）：{'、'.join(sections)}")
    print(f"将写入 slug：{len(todo)} 个    已有 slug 跳过：{skipped} 个")
    print(f"地址冲突（栏目+年份+slug 相同）：{len(dup)} 组")
    for k, v in dup.items():
        print(f"   /{k[0]}/{k[1]}/{k[2]}/  ←  {v}")
    if year_mismatch:
        print(f"文件名日期与 #+DATE 年份不一致：{len(year_mismatch)} 个（年份以 #+DATE 为准）")
        for rel, fy, dy in year_mismatch[:10]:
            print(f"   {rel}  文件名 {fy} vs DATE {dy}")
    if not todo:
        return

    if args.check:
        # 构建前用：缺 slug 就别往下走了，否则地址会变成中文标题
        print("\n下面这些文件缺 slug，地址会变成中文标题：")
        for path, kind, slug in todo:
            print(f"   {os.path.relpath(path, ROOT)}  →  应为 {slug}")
        print("\n先跑：python3 scripts/gen-slugs.py --apply")
        return 1

    if not args.apply:
        print("\n干跑示例（前 5 条）：")
        for path, kind, slug in todo[:5]:
            print(f"   {os.path.relpath(path, ROOT)}  →  {slug}")
        print("\n确认无误后加 --apply 写入。")
        return

    for path, kind, slug in todo:
        text = open(path, encoding="utf-8").read()
        if kind == "md" and text.startswith("+++"):
            # TOML front matter：写在 +++ 之间，语法也得是 TOML 的
            line = f'slug = "{slug}"\n'
            end = text.find("+++", 3)
            text = text[:end].rstrip("\n") + f"\n{line}" + text[end:]
        elif kind == "md":
            line = f"slug: {slug}\n"
            text = line + text
        else:
            line = f"#+SLUG: {slug}\n"
            text = line + text
        open(path, "w", encoding="utf-8").write(text)

    print(f"已写入 {len(todo)} 个文件。用 git diff 复核，git checkout content/ 可整体回滚。")


if __name__ == "__main__":
    sys.exit(main())
