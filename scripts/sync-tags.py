#!/usr/bin/env python3
"""
把 Markdown 文章的 `tags` 同步一份到 `keywords`。

为什么需要它
------------
本站的标签体系是 Org 时代定下来的：标签来自 `#+FILETAGS` / `#+KEYWORDS`，
对外地址统一是 /tags/<词>/ —— 而 Hugo 那边真正注册的分类法是 `keywords`
（[permalinks] 把 keywords 的词条页指到 /tags/<词>/）。`tags` 这个分类法
本站**没有注册**，所以 Markdown 文章老老实实写：

    tags = ["hugo", "orgmode"]

页面上一个标签都不会显示：模板走的是 .GetTerms，未注册的分类法拿不到词条，
也就没有可点的归档页。

试过直接注册 `tag = "tags"`，但那会打架：
    · tags 的列表页默认也是 /tags/，把 keywords 的列表页顶掉；
    · 同名词的词条页会互相覆盖 —— 实测 /tags/orgmode/ 只剩 Markdown 那篇，
      Org 里 keyword 是 orgmode 的旧文章全丢了。
所以不注册，改成把 tags 并进 keywords：地址、归档页、列表页全复用现成那套，
跟几百篇 Org 文章完全同源。

用法
----
    python3 scripts/sync-tags.py          # 干跑：只报告要改什么
    python3 scripts/sync-tags.py --apply  # 真的写进文件

只动 Markdown（+++ 的 TOML 头信息）；Org 文件的 #+KEYWORDS 不碰。
已有 keywords 的不会覆盖，只把 tags 里缺的补进去，重复执行安全（幂等）。
"""

import argparse
import re
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONTENT = ROOT / "content"

# +++ 开头、+++ 结尾的 TOML front matter
FM = re.compile(r"\A\+\+\+\r?\n(.*?)\r?\n\+\+\+[ \t]*\r?\n", re.S)
KW_LINE = re.compile(r"^keywords\s*=.*$", re.M)
TAG_LINE = re.compile(r"^tags\s*=.*$", re.M)


def as_list(value):
    if value is None:
        return []
    if isinstance(value, str):
        return [value] if value.strip() else []
    return [str(v) for v in value if str(v).strip()]


def toml_array(values):
    return "[" + ", ".join(f'"{v}"' for v in values) + "]"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="真的写进文件")
    args = ap.parse_args()

    changed, skipped = [], 0
    for path in sorted(CONTENT.rglob("*.md")):
        text = path.read_text(encoding="utf-8")
        m = FM.match(text)
        if not m:
            continue
        try:
            fm = tomllib.loads(m.group(1))
        except tomllib.TOMLDecodeError as e:
            print(f"  ! {path.relative_to(ROOT)} 头信息解析失败，跳过：{e}")
            continue

        tags = as_list(fm.get("tags"))
        if not tags:
            continue
        keywords = as_list(fm.get("keywords"))
        missing = [t for t in tags if t not in keywords]
        if not missing:
            skipped += 1
            continue

        merged = keywords + missing
        line = f"keywords = {toml_array(merged)}"
        head = m.group(1)
        if KW_LINE.search(head):
            head = KW_LINE.sub(line, head, count=1)
        else:
            head = TAG_LINE.sub(lambda mo: mo.group(0) + "\n" + line, head, count=1)
        new = text[:m.start(1)] + head + text[m.end(1):]

        changed.append((path.relative_to(ROOT), missing))
        if args.apply:
            path.write_text(new, encoding="utf-8")

    verb = "将写入" if args.apply else "待写入（加 --apply 才真写）"
    print(f"sync-tags: {verb} {len(changed)} 个文件；已经同步过的 {skipped} 个")
    for rel, missing in changed:
        print(f"  {rel}  + keywords: {', '.join(missing)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
