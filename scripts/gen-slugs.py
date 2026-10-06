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

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "content")

# 要处理的栏目。只挑「按日期命名的网志类栏目」：/zh/ 网志、/zj/ 支教。
# /xy/ 习艺、/bc/ 本草、/yue/ 乐记 是导览/专题型内容，文件名本就没有日期，
# 保持原地址更合适。
SECTIONS = ("zh", "zj")

DATED = re.compile(r"^(\d{4})-(\d{2})-(\d{2})-(.+)$")
ORG_SLUG = re.compile(r"^#\+SLUG:", re.IGNORECASE | re.MULTILINE)
MD_SLUG = re.compile(r"^slug:", re.IGNORECASE | re.MULTILINE)
ORG_DATE = re.compile(r"^#\+DATE:\s*(\d{4})-\d{2}-\d{2}", re.IGNORECASE | re.MULTILINE)
MD_DATE = re.compile(r"^date\s*=\s*['\"]?(\d{4})-\d{2}-\d{2}", re.IGNORECASE | re.MULTILINE)


def collect():
    files = []
    for sec in SECTIONS:
        d = os.path.join(ROOT, sec)
        for dirpath, _dirs, names in os.walk(d):
            for n in sorted(names):
                if n.startswith("_"):  # _index.org 是栏目页，不参与
                    continue
                if n.endswith(".org"):
                    files.append((os.path.join(dirpath, n), "org"))
                elif n.endswith(".md"):
                    files.append((os.path.join(dirpath, n), "md"))
    return files


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="真的写入文件（默认只干跑）")
    args = ap.parse_args()

    todo, skipped, conflicts = [], 0, collections.defaultdict(list)
    year_mismatch = []

    for path, kind in collect():
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

    if not args.apply:
        print("\n干跑示例（前 5 条）：")
        for path, kind, slug in todo[:5]:
            print(f"   {os.path.relpath(path, ROOT)}  →  {slug}")
        print("\n确认无误后加 --apply 写入。")
        return

    for path, kind, slug in todo:
        text = open(path, encoding="utf-8").read()
        line = f"#+SLUG: {slug}\n" if kind == "org" else f"slug: {slug}\n"
        if kind == "md" and text.startswith("+++"):
            # TOML front matter 的 slug 得写在 +++ 之间
            end = text.find("+++", 3)
            text = text[:end].rstrip("\n") + f"\n{line}" + text[end:]
        else:
            text = line + text
        open(path, "w", encoding="utf-8").write(text)

    print(f"已写入 {len(todo)} 个文件。用 git diff 复核，git checkout content/ 可整体回滚。")


if __name__ == "__main__":
    sys.exit(main())
