#!/usr/bin/env python3
"""
把 Emacs + Org-Mode 生成的站点源文件整理成 Hugo 可直接使用的形式。

保留 .org 格式，不转 markdown。做四件事：

  1. #+DATE 里的非活动时间戳 [2016-01-02] 改成 <2016-01-02>
     —— go-org 只认尖括号形式，方括号会让 Hugo 直接报构建错误。
  2. 图片链接统一改成站点根路径：[[file:../images/a.jpg]] -> [[file:/images/a.jpg]]
     —— 图片已从 content/images 搬到 static/images，Hugo 不会复制 content 下的静态文件。
  3. 站内文章链接改成最终 URL：[[file:foo.org][说明]] -> [[/zh/foo/][说明]]
     —— .org 源文件路径在 Hugo 里不对应任何页面。
  4. 清掉各栏目首页手写的归档表格（#+html 行），改由主题自动生成列表。

用法：
    python3 scripts/org-migrate.py          # 预演，只报告将要改动什么
    python3 scripts/org-migrate.py --write  # 真正写回文件
"""
import os
import re
import sys
import posixpath
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONTENT = ROOT / "content"

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg"}
LINK_RE = re.compile(r"\[\[(?:file:)?([^\]\[]+)\](?:\[([^\]\[]*)\])?\]")
PROTO_RE = re.compile(r"^(?:https?|mailto|ftp|tel):")


# --------------------------------------------------------------------------
# 建立全部页面的索引，供链接解析使用
# --------------------------------------------------------------------------
def collect_pages():
    """返回 {相对路径Stem: [URL, ...]} 与 {(目录, 文件名): URL}"""
    by_stem = defaultdict(list)
    by_path = {}
    for p in sorted(CONTENT.rglob("*.org")):
        rel = p.relative_to(CONTENT).as_posix()
        if Path(rel).name == "_index.org":
            continue
        sec = posixpath.dirname(rel)
        stem = p.stem
        url = "/{}/{}/".format(sec, stem) if sec else "/{}/".format(stem)
        by_stem[stem].append(url)
        by_path[rel] = url
    return by_stem, by_path


BY_STEM, BY_PATH = collect_pages()


def page_url(dest, src_rel_dir):
    """把源文件中的 .org 相对路径解析成站点内的最终 URL。"""
    dest = dest.strip()
    cand = posixpath.normpath(posixpath.join(src_rel_dir, dest)).lstrip("/")
    if cand in BY_PATH:
        return BY_PATH[cand]
    stem = posixpath.splitext(posixpath.basename(dest))[0]
    hits = BY_STEM.get(stem, [])
    if len(hits) == 1:
        return hits[0]
    if len(hits) > 1:
        return "AMBIGUOUS:" + ",".join(hits)
    return None


def image_url(dest):
    """content/images 已经迁到 static/images，统一成根路径写法。"""
    m = re.search(r"(?:^|/)images/(.+)$", dest)
    return "/images/" + m.group(1) if m else None


def convert_link(m, src_rel_dir, problems):
    dest, desc = m.group(1), m.group(2)
    if PROTO_RE.match(dest) or dest.startswith("#"):
        return m.group(0)

    ext = posixpath.splitext(dest)[1].lower()
    new = None
    if ext in IMAGE_EXTS:
        new = image_url(dest)
        if new and desc:
            # go-org 里给图片链接加描述会退化成普通 <a>，不再内联显示，记一笔
            problems.append(("image-with-desc", dest))
    elif ext in {".org", ".md"}:
        new = page_url(dest, src_rel_dir)
        if new is None:
            problems.append(("dangling-page", dest))
            new = None
        elif new.startswith("AMBIGUOUS:"):
            problems.append((new, dest))
            new = None
    elif dest.startswith(("./", "../")) and not ext:
        # 形如 [[./zh/][网志]] 的栏目入口
        new = "/" + posixpath.normpath(posixpath.join(src_rel_dir, dest)).lstrip("/") + "/"

    if new is None or new == dest:
        return m.group(0)

    # go-org 只对带 file: 前缀、且没有描述的链接内联成 <img>；
    # 一旦写了描述就退化成普通 <a>，前缀也就没必要保留了。
    prefix = "file:" if (ext in IMAGE_EXTS and desc is None) else ""
    target = "{}{}".format(prefix, new)
    return "[[{}]]".format(target) if desc is None else "[[{}][{}]]".format(target, desc)


# --------------------------------------------------------------------------
# #+DATE 的处理
#
# go-org 只把「带限定词的」org 时间戳转成时间，其它一律当成普通字符串：
#
#   <2015-06-06 Sat>      识别为时间戳  -> 可用
#   <2024-05-05>          不识别，保持字面量 -> Hugo 报 "not a parsable date"
#   [2024-05-05]          同上 -> 报错
#   2024-05-05            可用
#   2024-05-05 08:18      不可用（缺秒才是关键：08:18 不行，08:18:30 才行）
#
# 与其记住这套脾气，不如统一把 #+DATE 写成 go-org/Go 都认的普通 ISO 形式。
# 顺手丢掉 <...> 里的星期名（英文 Sat / 中文 日 三 都可能出现）。
# --------------------------------------------------------------------------
DATE_RE = re.compile(r"^(\s*#\+DATE:\s*)(\S.*?)\s*$", re.M | re.I)
ISO_RE = re.compile(r"(\d{4})-(\d{2})-(\d{2})")
TIME_RE = re.compile(r"\b(\d{1,2}):(\d{2})(?::(\d{2}))?")


# 关键字冒号后必须有一个空格，否则 go-org 整行当正文输出。
# 例：#+html:<div ...> 会被原样印成 "#+html:<div ...>"，页面上就是一行脏文本；
#     #+CAPTION:木桥 同理，图片说明会丢失。
KWSPACE_RE = re.compile(r"^(#\+[A-Za-z_][A-Za-z0-9_-]*):(\S.*)$", re.M)


def norm_keyword_space(m):
    return "{}: {}".format(m.group(1), m.group(2))


def norm_date(m):
    prefix, val = m.group(1), m.group(2)
    dm = ISO_RE.search(val)
    if not dm:
        return m.group(0)
    out = dm.group(0)
    tm = TIME_RE.search(val)
    if tm:
        out = "{} {:02d}:{}{}".format(out, int(tm.group(1)), tm.group(2),
                                      ":" + (tm.group(3) or "00"))
    return prefix + out


def convert(s, src_rel_dir, problems):
    s, n_kw = KWSPACE_RE.subn(norm_keyword_space, s)
    s, n_date = DATE_RE.subn(norm_date, s)
    s, n_link = LINK_RE.subn(lambda m: convert_link(m, src_rel_dir, problems), s)
    return s, n_kw, n_date, n_link


def main():
    write = "--write" in sys.argv
    total_files = 0
    changed_files = 0
    stats = defaultdict(int)
    problem_files = defaultdict(list)

    for p in sorted(CONTENT.rglob("*.org")):
        rel = p.relative_to(CONTENT)
        src = p.read_text(encoding="utf-8")
        src_rel_dir = posixpath.dirname(rel.as_posix())
        problems = []
        out, n_kw, n_date, n_link = convert(src, src_rel_dir, problems)
        total_files += 1
        if n_kw or n_date or n_link:
            changed_files += 1
            stats["keyword"] += n_kw
            stats["date"] += n_date
            stats["link"] += n_link
            if write:
                p.write_text(out, encoding="utf-8")
        for kind, val in zip(problems[0::2], problems[1::2]):
            problem_files[kind].append("{} -> {}".format(rel, val))

    print("扫描 {} 个 .org 文件，改动 {} 个".format(total_files, changed_files))
    print("  关键字补空格: {} 处".format(stats["keyword"]))
    print("  #+DATE 修正:  {} 处".format(stats["date"]))
    print("  链接重写:     {} 处".format(stats["link"]))
    for kind, items in problem_files.items():
        print("\n!! 待处理 {} ({}):".format(kind, len(items)))
        for it in items[:20]:
            print("   ", it)
    print("\n模式: {}".format("已写入" if write else "预演（加 --write 才会写文件）"))


if __name__ == "__main__":
    main()
