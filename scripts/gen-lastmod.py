#!/usr/bin/env python3
"""
把 git 里「真正改过内容」的日期导出成 data/lastmod.json，供页脚显示。

为什么需要它
------------
Hugo 只有在开了 enableGitInfo 时才认 git 时间。但本站的仓库是 2026-10-06
才建的，几百篇老文章是那一次 first commit 整体导入的 —— 一开 enableGitInfo，
它们全都会显示成 2026-10-06，比显示原来的发布日期更假。所以不开，改用本
脚本自己算。

难点是「怎么分辨真改过和批量刷过一遍」：本站历史上有一次 456 个文件的
提交，其实是补 slug 的脚本刷的，只有 about.org 那几处是手改的文字。规则
因此定成这样：

    文件数 <= 20 的提交                     → 人手改的，全部算数
    文件数 >  20 的提交（批量）             → 逐个文件看 diff：
        只有 #+ 开头的关键字行 / 空行变化   → 机械刷的，不算
        动了正文行                          → 算数
    root commit（第一个提交）               → 纯导入，一律不算

于是「昨天改过的关于页」会自动拿到昨天的日期，而只被脚本补过 slug 的文章
照旧显示自己的发布日期。

用法
----
    python3 scripts/gen-lastmod.py        # 生成 data/lastmod.json

由 scripts/build.sh 在每次构建前调用；不在 git 仓库里或 git 不可用时只是
跳过，不影响构建。
"""

import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "lastmod.json")
EXTS = (".org", ".md")
PREFIX = "content/"

# 一次提交动了多少文件以上就当作「批量提交」，要逐个看 diff
BATCH_LIMIT = 20


def git(*args):
    try:
        return subprocess.run(
            ["git", "-C", ROOT, *args],
            capture_output=True, text=True, check=True,
        ).stdout
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def is_mechanical(text):
    """这行改动算不算「机器刷的」——关键字行、空行、front matter 分隔符都算。"""
    text = text.strip()
    if not text:
        return True
    if text.startswith("#+"):        # Org 的 #+TITLE / #+SLUG / #+OPTIONS …
        return True
    if text in ("---", "+++"):       # Markdown front matter 的分隔线
        return True
    return False


def parse_diff(raw):
    """把一次提交的 diff 拆成 {文件路径: 是否动了正文}。"""
    files, path, real, is_new = {}, None, False, False

    def flush():
        if path is not None and not is_new:      # 新建的文件是「导入」，不是修改
            files[path] = real

    for line in raw.splitlines():
        if line.startswith("diff --git "):
            flush()
            # 取 b/ 后面那一段
            tail = line.split(" b/", 1)[-1]
            path = tail[len(PREFIX):] if tail.startswith(PREFIX) else None
            if path and not path.endswith(EXTS):
                path = None
            real, is_new = False, False
            continue
        if path is None:
            continue
        if line.startswith("new file mode"):
            is_new = True
            continue
        if line.startswith(("--- ", "+++ ", "@@", "index ")):
            continue
        if line[:1] in ("+", "-"):
            if not is_mechanical(line[1:]):
                real = True
    flush()
    return files


def main():
    log = git("log", "--format=%H|%cI|%P", "--no-renames")
    if log is None:
        print("gen-lastmod: 不在 git 仓库里，跳过")
        return 0

    table = {}
    for entry in log.splitlines():
        if not entry.strip():
            continue
        sha, date, parents = (entry.split("|") + ["", ""])[:3]
        date = date[:10]
        if not parents.strip():
            continue                                  # root commit = 导入
        raw = git("show", "--format=", "--unified=0", "--no-renames",
                  sha, "--", PREFIX)
        if raw is None:
            continue
        changed = parse_diff(raw)
        if len(changed) > BATCH_LIMIT:
            picked = [p for p, real in changed.items() if real]
        else:
            picked = list(changed)
        for rel in picked:
            if not os.path.exists(os.path.join(ROOT, PREFIX, rel)):
                continue
            table.setdefault(rel, date)               # 提交从新到旧，先到先得

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(dict(sorted(table.items())), f, ensure_ascii=False, indent=1)
        f.write("\n")

    print(f"gen-lastmod: 写入 {len(table)} 条真实修改日期 → data/lastmod.json")
    for rel in sorted(table):
        print(f"  {rel}  {table[rel]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
