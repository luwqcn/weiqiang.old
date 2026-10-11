#!/usr/bin/env python3
"""
规范 Markdown 文章 front matter 里的 `tags`。

本站的标签分类法只有 Hugo 惯例的 `tags` 一个（对外地址 /tags/<词>/）。
Org 时代遗留的两套——`#+FILETAGS` 与 `#+KEYWORDS`——在迁移时已经并进 tags，
这个脚本负责把之后手写进去的标签也收拾干净：

  * 掐掉词尾的逗号顿号。Org 按空白切词时会把逗号留在词里（「中医,」），
    照抄过来显示很难看。
  * 同一个词写两次只留一次（保留第一次出现的位置）。
  * 万一还有 `keywords` / `filetags` 这两个旧键，并进 tags 后删掉——
    它们没注册成分类法，留着既没有词条页也不显示。

幂等：重复执行不会再有改动。

用法
    python3 scripts/normalize-tags.py           # 干跑，只报告要改什么
    python3 scripts/normalize-tags.py --apply   # 真的写回文件
"""

import argparse
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
CONTENT = ROOT / "content"

# front matter：YAML 的 --- 或 TOML 的 +++
FM_RE = re.compile(r"^(---|\+\+\+)\n(.*?)\n\1\n", re.S)
# `tags: [...]` / `tags = [...]` / 同理的 keywords、filetags
LIST_RE = re.compile(r'^(tags|keywords|filetags)\s*[:=]\s*\[(.*?)\]\s*$', re.M)
TERM_RE = re.compile(r'"([^"]*)"|\'([^\']*)\'')

# 标签来源的优先顺序：作者显式打的在前
SOURCE_ORDER = ("tags", "filetags", "keywords")


def parse_terms(raw):
    """从 `[...]` 里的原文取出词表，保持顺序。"""
    return [a if a is not None else b for a, b in TERM_RE.findall(raw)]


def render_terms(terms, sep):
    body = ", ".join('"{}"'.format(t) for t in terms)
    return "tags{} [{}]".format(sep, body)


def clean(terms):
    """去尾逗号顿号 + 去重（保序）。"""
    out, seen = [], set()
    for t in terms:
        t = t.strip().rstrip("，,、;；").strip()
        if t and t not in seen:
            seen.add(t)
            out.append(t)
    return out


def normalize(text):
    """返回 (新文本, 说明)；没变化就说明为空字符串。"""
    m = FM_RE.match(text)
    if not m:
        return text, ""
    is_yaml = m.group(1) == "---"
    sep = ":" if is_yaml else " ="
    fm = m.group(2)

    found = {k: v for k, v in LIST_RE.findall(fm)}
    if not found:
        return text, ""

    merged = []
    for key in SOURCE_ORDER:
        if key in found:
            merged.extend(parse_terms(found[key]))
    terms = clean(merged)
    old_terms = parse_terms(found.get("tags", ""))

    extra = [k for k in ("keywords", "filetags") if k in found]
    if terms == old_terms and not extra:
        return text, ""

    # 先删掉旧键，再把 tags 插到原来 tags 的位置（没有就放 front matter 末尾）
    lines = fm.split("\n")
    tag_line = render_terms(terms, sep)
    placed = False
    out = []
    for line in lines:
        m2 = LIST_RE.match(line)
        if not m2:
            out.append(line)
            continue
        if m2.group(1) == "tags" and not placed:
            out.append(tag_line)
            placed = True
        # keywords / filetags 以及重复的 tags 行直接丢掉
    if not placed:
        out.append(tag_line)

    new_fm = "\n".join(out)
    new_text = text[:m.start()] + m.group(1) + "\n" + new_fm + "\n" + m.group(1) + "\n" + text[m.end():]
    note = "去尾逗号/去重" if terms != old_terms else ""
    if extra:
        note = (note + "，合并 " + "+".join(extra)).lstrip("，")
    return new_text, note


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="写回文件（默认只报告）")
    args = ap.parse_args()

    changed = []
    for path in sorted(CONTENT.rglob("*.md")):
        text = path.read_text(encoding="utf-8")
        new_text, note = normalize(text)
        if not note:
            continue
        changed.append((path, note))
        if args.apply:
            path.write_text(new_text, encoding="utf-8")

    rel = lambda p: p.relative_to(ROOT)
    print("标签需要规范化的文件：{} 个{}".format(
        len(changed), "" if args.apply else "（干跑，加 --apply 才写）"))
    for path, note in changed[:40]:
        print("  {} — {}".format(rel(path), note))
    if len(changed) > 40:
        print("  …… 其余 {} 个略".format(len(changed) - 40))
    return 0


if __name__ == "__main__":
    sys.exit(main())
