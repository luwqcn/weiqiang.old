#!/usr/bin/env python3
"""
把 content/ 下的 Org-Mode 文章转成 Hugo 的 Markdown 文章。

目标：**转换前后站点渲染结果不变**。因此这不是「顺手转一下」，而是逐条对齐
go-org 已经做过的事情：

头部（#+XXX:）
    go-org 只把固定那几个键交给 Hugo（实测 title / date / author /
    description / keywords / slug / language / filetags / email / url /
    subtitle / cover / index / tags / categories / options / startup）。
    #+KEYWORDS、#+FILETAGS 是**按空白切**成数组的（「生活, 支教」→
    ["生活,", "支教"]，逗号留在词里）。转成 md 时这两项合并成一个 `tags`：
    Hugo 的惯例分类法是 tags，本站注册的就是它。合并顺序 #+FILETAGS →
    #+KEYWORDS（作者显式打的在前），去重，并顺手去掉尾巴上那颗逗号。

正文
    * 标题        org 的 N 颗星 → md 的 N+1 个 #（因为 h1 留给页面标题），
                  id 沿 go-org 的 headline-N 序号；若标题下写了 :CUSTOM_ID:
                  则用那个值。
    * 图片        [[file:/x.jpg]] → ![]() ；前面有 #+CAPTION 就变成图片 title，
                  由主题的 render-image 钩子包成 <figure><figcaption>。
    * 引用块      #+BEGIN_QUOTE 里 go-org 把**每一行**当成独立段落（不是整块
                  一个 <p>），所以转换时行与行之间要留空行；列表项则连着写，
                  才会合并成一个 <ul>/<ol>。
    * 源码块      #+BEGIN_SRC lang → ```lang（走 Chroma，与 go-org 同样输出
                  <div class=highlight><pre class=chroma>）。
    * 导出块      #+BEGIN_EXPORT html 原样输出（站点已开 markup unsafe）。
    * 行内标记    *粗* → **粗**，/斜/ → *斜*，=码= ~码~ → `码`，+删+ → ~~删~，
                  _下划线_ 直接写 <u>。
    * 注释行      org 的「# 开头」是注释，md 里却是标题，必须删掉。

用法
    python3 scripts/org-to-md.py            # 干跑，只报告
    python3 scripts/org-to-md.py --write    # 生成 .md，并把 .org 移到 _legacy/org/

.md 生成后仍然留在 content/ 里的 .org 会和它撞路径（Hugo 会当成两篇页面），
所以 --write 时原件统一挪到 _legacy/org/ 下保存，随时可整体搬回来。
"""

import argparse
import datetime
import posixpath
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONTENT = ROOT / "content"
LEGACY = ROOT / "_legacy" / "org"

# ---------------------------------------------------------------------------
# 头部
# ---------------------------------------------------------------------------

# go-org 只认「文件开头连成一片的」#+KEY: 行；中间插一条注释或空行，后面的键
# 全部作废。这里照同样规则停，好让转出来的 front matter 和原来逐字一致。
KEY_RE = re.compile(r"^#\+([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$")

# org 键 → front matter 键；值为 list 的表示要按空白切成数组
SCALAR_KEYS = {
    "TITLE": "title",
    "DATE": "date",
    "AUTHOR": "author",
    "DESCRIPTION": "description",
    "SLUG": "slug",
    "LANGUAGE": "language",
    "EMAIL": "email",
    "URL": "url",
    "SUBTITLE": "subtitle",
    "COVER": "cover",
    "INDEX": "index",
    "OPTIONS": "options",
    "STARTUP": "startup",
}
# 这三个键的值都是标签，合成 front matter 里的一个 tags（FILETAGS 在前）
TAG_KEYS = ("FILETAGS", "KEYWORDS", "TAGS")
LIST_KEYS = {
    "CATEGORIES": "categories",
}

# 写在 front matter 里的顺序：先正文要用的，再是原样保留的
ORDER = ["title", "date", "author", "description", "tags", "slug",
         "language", "email", "url", "subtitle", "cover",
         "index", "categories", "options", "startup"]

DATE_ONLY = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")
DATE_TIME = re.compile(r"^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$")


def split_head(text):
    """切出文件头的 #+XXX: 行，返回 (键→值列表, 正文行)。"""
    lines = text.split("\n")
    head, i = {}, 0
    while i < len(lines):
        m = KEY_RE.match(lines[i])
        if not m:
            break
        head.setdefault(m.group(1).upper(), []).append(m.group(2).strip())
        i += 1
    return head, lines[i:]


def yaml_str(v):
    return '"' + v.replace("\\", "\\\\").replace('"', '\\"') + '"'


def yaml_date(v):
    """org 的日期写法 → md front matter 里 YAML/Go 都认的写法。

    取值要和 go-org 解析出来的完全一致，所以照它的脾气来：
      2026-04-04                 → 2026-04-04
      2025-10-02 19:56:00        → 2025-10-02T19:56:00+08:00
      <2026-08-24 一 21:29:38>   → 2026-08-24
        （尖括号里带中文星期，go-org 只认出日期部分，时间丢掉 ——
          实测 .Params.date 是 2026-08-24T00:00:00+08:00）
    """
    v = v.strip()
    if DATE_ONLY.match(v):
        return v
    m = DATE_TIME.match(v)
    if m:                       # 补上秒和时区，跟 go-org 解析出来的值对齐
        return "{}T{}:{}:{}+08:00".format(m.group(1), m.group(2), m.group(3),
                                          m.group(4) or "00")
    m = re.match(r"^[<\[]\s*(\d{4})-(\d{2})-(\d{2})", v)
    if m:                       # org 时间戳：<...> / [...] 只取日期
        return "{}-{}-{}".format(*m.groups())
    m = re.search(r"\d{4}-\d{2}-\d{2}", v)
    if m:
        return m.group(0)
    return yaml_str(v)


def build_front_matter(head):
    vals = {}
    for org_key, md_key in SCALAR_KEYS.items():
        if org_key in head:
            raw = head[org_key][0]
            vals[md_key] = yaml_date(raw) if md_key == "date" else yaml_str(raw)
    # 标签：#+FILETAGS / #+KEYWORDS / #+TAGS 合成一个 tags
    #
    # Org 时代这是两套分类法（filetags 优先显示，keywords 兜底），迁到 Markdown
    # 后统一用 Hugo 的 tags。切词规则照 go-org（按空白切），但尾巴上那颗逗号
    # 是切词留下的垃圾，去掉；同一个词出现两次只留一次。
    terms, seen = [], set()
    for org_key in TAG_KEYS:
        for v in head.get(org_key, []):
            for w in v.split():
                w = w.rstrip(",")
                if w and w not in seen:
                    seen.add(w)
                    terms.append(w)
    if terms:
        vals["tags"] = "[" + ", ".join(yaml_str(w) for w in terms) + "]"

    for org_key, md_key in LIST_KEYS.items():
        if org_key in head:
            words = [w for v in head[org_key] for w in v.split()]
            vals[md_key] = "[" + ", ".join(yaml_str(w) for w in words) + "]"

    out = ["---"]
    for k in ORDER:
        if k in vals:
            out.append("{}: {}".format(k, vals[k]))
    return "\n".join(out) + "\n---\n"


# ---------------------------------------------------------------------------
# 正文
# ---------------------------------------------------------------------------

HEAD_RE = re.compile(r"^(\*+)[ \t]+(.*)$")
BEGIN_RE = re.compile(r"^[ \t]*#\+BEGIN_([A-Za-z]+)(?:[ \t]+(.*))?[ \t]*$", re.I)
END_RE = re.compile(r"^[ \t]*#\+END_([A-Za-z]+)[ \t]*$", re.I)
CAPTION_RE = re.compile(r"^[ \t]*#\+CAPTION:[ \t]*(.*)$", re.I)
KEYWORD_RE = re.compile(r"^[ \t]*#\+[A-Za-z_][A-Za-z0-9_-]*:")
COMMENT_RE = re.compile(r"^#[ \t]")
DRAWER_RE = re.compile(r"^[ \t]*:([A-Za-z_][A-Za-z0-9_-]*):[ \t]*$")
END_DRAWER_RE = re.compile(r"^[ \t]*:END:[ \t]*$", re.I)
HR_RE = re.compile(r"^-{5,}[ \t]*$")
TABLE_ROW_RE = re.compile(r"^[ \t]*\|")
TABLE_SEP_RE = re.compile(r"^[ \t]*\|[ \t]*[-+|: ]*\|?[ \t]*$")
BULLET_RE = re.compile(r"^[ \t]*[-+*][ \t]+")
NUM_RE = re.compile(r"^[ \t]*(\d+)[.)][ \t]+")
LINK_RE = re.compile(r"\[\[([^\]\[]+)\](?:\[([^\]\[]*)\])?\]")
IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg", ".bmp", ".tiff")

# Org 脚注：正文里写 [fn:1]，文末写 [fn:1] 说明文字。go-org 会把它渲染成
# 上标引用 + 文末的脚注区，Markdown 没有等价语法，只能照它的样子输出 HTML。
FN_REF_RE = re.compile(r"\[fn:([^\]]+)\]")
FN_DEF_RE = re.compile(r"^\s*\[fn:([^\]]+)\]\s*(.*)$")


def fn_ref(m):
    name = m.group(1)
    return ('<sup class="footnote-reference">'
            '<a id="footnote-reference-{}" href="#footnote-{}">{}</a></sup>'
            .format(name, name, name))


# 脚注区是整块原生 HTML，浏览器不会再按 Markdown 解析里面的链接语法 ——
# inline() 输出的 `[说明](网址)`、`![](图)`、`<网址>` 三种写法要在这里翻成
# 真正的标签，否则读者看到的是一整条裸网址（而且会顶破手机屏）。
MD_LINK_RE = re.compile(r"(!?)\[([^\]\n]*)\]\(([^()\s]+)(?:\s+\"([^\"]*)\")?\)")
MD_AUTO_RE = re.compile(r"<((?:https?|ftp|mailto):[^<>\s]+)>")


def md_links_to_html(text):
    def link(m):
        bang, desc, url, _title = m.groups()
        if bang:
            return '<img src="{}" alt="{}">'.format(url, desc)
        return '<a href="{}">{}</a>'.format(url, desc or url)

    def auto(m):
        url = m.group(1)
        return '<a href="{}">{}</a>'.format(url, url)

    return MD_AUTO_RE.sub(auto, MD_LINK_RE.sub(link, text))


def footnote_block(defs):
    out = ['<div class="footnotes"><hr class="footnotes-separatator">',
           '<div class="footnote-definitions">']
    for name, text in defs:
        out.append('<div class="footnote-definition">'
                   '<sup id="footnote-{0}"><a href="#footnote-reference-{0}">{0}</a></sup>'
                   '<div class="footnote-body"><p>{1}</p></div></div>'
                   .format(name, md_links_to_html(inline(text))))
    out.append("</div></div>")
    return out


# 正文里的裸网址：go-org 会自己补成链接（实测 `参见 https://a.com/b` 会渲染成
# `<a href="https://a.com/b">https://a.com/b</a>`），所以这里也必须转。而且一
# 定要在斜体标记 /…/ 之前处理掉 —— 否则网址里那些斜杠会被当成 Org 的斜体，
# https://a.com/b 变成 https:/*a.com*b，链接就废了。
BARE_URL_RE = re.compile(r"(?<![\[\(<\w/])https?://[^\s\[\]<>()（）「」“”\"]+")
# 网址末尾常常紧跟着句号、逗号、中文标点，那些不是网址的一部分
URL_TAIL = ".,;:!?'\"、。，；：！？）)】》"


def hold_autolink(hold, m):
    raw = m.group(0)
    url = raw.rstrip(URL_TAIL) or raw
    return hold("<" + url + ">") + raw[len(url):]


TS_INLINE_RE = re.compile(r"<(\d{4})-(\d{2})-(\d{2})(?:[ \t][^<>]*)?>")
WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")


def ts_repl(m):
    y, mo, d = (int(x) for x in m.groups())
    wd = WEEKDAYS[datetime.date(y, mo, d).weekday()]
    return ('<span class="timestamp">&lt;{:04d}-{:02d}-{:02d} {}&gt;</span>'
            .format(y, mo, d, wd))


def is_image(dest):
    return posixpath.splitext(dest)[1].lower() in IMAGE_EXTS


def inline_link(m):
    """[[目标]] / [[目标][说明]] → markdown 链接。"""
    dest, desc = m.group(1).strip(), m.group(2)
    if re.match(r"^(?:https?|mailto|ftp|tel):", dest) or dest.startswith("//"):
        target = dest
    elif re.match(r"^\w+:", dest):          # file: 之类
        target = dest.split(":", 1)[1]
    else:
        target = dest
    if desc is None:
        # 裸链接：图片写 ![](x)，其余写 <url>（goldmark 的自动链接）
        return "![]({})".format(target) if is_image(target) else "<{}>".format(target)
    if is_image(target) and dest.startswith("file:"):
        return "![{}]({})".format(desc, target)
    return "[{}]({})".format(desc, target)


def inline(text):
    """org 行内标记 → markdown 行内标记。"""
    # 先占好位：下面几步生成的 HTML（脚注上标、时间戳）里带着 = 和 _ 这类
    # 字符，会被后面「等宽代码 / 下划线」的替换当成 Org 标记切碎，必须先摘出去。
    slots = []

    def hold(s):
        slots.append(s)
        return "\x00{}\x00".format(len(slots) - 1)

    text = FN_REF_RE.sub(lambda m: hold(fn_ref(m)), text)
    # Org 时间戳：<2021-02-08>、<2023-09-27 三> 之类。go-org 认得它们，会
    # 渲染成 <span class="timestamp">&lt;2021-02-08 Mon&gt;</span>（补上英文
    # 星期）—— 而 .timestamp 在 components.css 里是有样式的，直接放过去会
    # 变成干巴巴的一行文字。这里照它的样子写死成同样的 HTML。
    text = TS_INLINE_RE.sub(lambda m: hold(ts_repl(m)), text)
    text = BARE_URL_RE.sub(lambda m: hold_autolink(hold, m), text)
    # 其余的裸 `<` 到 Markdown 会被当成 HTML 标签吃掉一截，先转义成 &lt;；
    # 真正的 HTML（<b>、</div> 之类）以字母或 / 开头，放过去不动。
    text = re.sub(r"<(?!/?[A-Za-z!])", "&lt;", text)
    # 再把链接和等宽代码摘出来占位，免得后面的星号/下划线替换踩到它们
    text = LINK_RE.sub(lambda m: hold(inline_link(m)), text)
    for pat in (r"=([^=\s][^=]*?)=", r"~([^~\s][^~]*?)~"):
        text = re.sub(pat, lambda m: hold("`" + m.group(1) + "`"), text)
    text = re.sub(r"\+([^+\s][^+]*?)\+",
                  lambda m: hold("<del>" + m.group(1) + "</del>"), text)
    text = re.sub(r"_([^_\s][^_]*?)_",
                  lambda m: hold("<u>" + m.group(1) + "</u>"), text)
    text = re.sub(r"\*([^*\s][^*]*?)\*",
                  lambda m: hold("**" + m.group(1) + "**"), text)
    text = re.sub(r"/([^/\s][^/]*?)/",
                  lambda m: hold("*" + m.group(1) + "*"), text)
    return unhold(text, slots)


def unhold(text, slots):
    """把占位符换回内容。

    一次 re.sub 不会回头再扫替换出来的结果，而占位符是会嵌套的（链接里的
    说明文字本身又可以是粗体），所以要反复展开到没有占位符为止 —— 漏掉的话
    文件里会留下 \\x00 这种看不见的控制字符。
    """
    for _ in range(8):
        new = re.sub(r"\x00(\d+)\x00", lambda m: slots[int(m.group(1))], text)
        if new == text:
            break
        text = new
    return text


def quote_lines(raw):
    """#+BEGIN_QUOTE 的内容 → md 引用。

    go-org 在引用块里把每个非空行当成独立段落，只有连续的列表项会并成一个
    列表。所以：列表项连着写，其它行前后各留一个空行（块内用 > 连接）。
    """
    out = []
    prev_item = False
    for line in raw:
        if not line.strip():
            continue
        is_item = bool(BULLET_RE.match(line) or NUM_RE.match(line))
        # 连续的列表项并成一个列表，其余情况前后都要断开（go-org 就是这么切的）
        if out and not (is_item and prev_item):
            out.append(">")
        out.append("> " + inline(line.strip()))
        prev_item = is_item
    return out


def table_lines(rows):
    """org 表格 → md 表格。org 的 |---+---| 是分隔线，只保留第一行的位置。"""
    data = []
    for r in rows:
        if TABLE_SEP_RE.match(r):
            continue
        cells = [c.strip() for c in r.strip().strip("|").split("|")]
        data.append(cells)
    if not data:
        return []
    width = max(len(row) for row in data)
    # 注意别用 r：上面 for r in rows 的循环变量会泄漏成字符串
    def line_of(cells):
        return "| " + " | ".join(cells + [""] * (width - len(cells))) + " |"

    out = [line_of(data[0]), "|" + "|".join(["---"] * width) + "|"]
    out.extend(line_of(row) for row in data[1:])
    return out


def convert_body(lines):
    out = []
    i = 0
    caption = None
    headline_no = 0
    footnotes = []
    while i < len(lines):
        line = lines[i]
        i += 1
        stripped = line.strip()

        if not stripped:
            out.append("")
            caption = None
            continue

        # ---- 块 -----------------------------------------------------------
        m = BEGIN_RE.match(line)
        if m:
            kind = m.group(1).upper()
            info = (m.group(2) or "").strip()
            raw = []
            while i < len(lines) and not END_RE.match(lines[i]):
                raw.append(lines[i])
                i += 1
            i += 1                                   # 吃掉 #+END_
            if kind == "QUOTE":
                out.append("")
                out.extend(quote_lines(raw))
                out.append("")
            elif kind in ("SRC", "EXAMPLE"):
                lang = info.split()[0] if kind == "SRC" and info else ""
                out.append("")
                out.append("```" + lang)
                out.extend(r.rstrip() for r in raw)
                out.append("```")
                out.append("")
            elif kind in ("EXPORT", "HTML"):
                sub = (info or "").lower()
                out.append("")
                if sub and sub != "html":
                    out.append("```" + info)
                    out.extend(r.rstrip() for r in raw)
                    out.append("```")
                else:
                    out.extend(r.rstrip() for r in raw)
                out.append("")
            elif kind == "COMMENT":
                pass
            else:                                    # CENTER 等：内容照抄
                out.append("")
                out.extend(inline(r) for r in raw)
                out.append("")
            caption = None
            continue

        # ---- 标题 ---------------------------------------------------------
        m = HEAD_RE.match(line)
        if m:
            level = len(m.group(1)) + 1              # go-org 把 * 当 h2
            headline_no += 1
            cid = "headline-{}".format(headline_no)
            # 标题下面的 :PROPERTIES: 抽屉里可能有 :CUSTOM_ID:
            j = i
            while j < len(lines) and not lines[j].strip():
                j += 1
            if j < len(lines) and DRAWER_RE.match(lines[j]):
                k = j + 1
                while k < len(lines) and not END_DRAWER_RE.match(lines[k]):
                    dm = re.match(r"^[ \t]*:CUSTOM_ID:[ \t]*(\S+)[ \t]*$", lines[k], re.I)
                    if dm:
                        cid = dm.group(1)
                    k += 1
                i = k + 1
            out.append("")
            out.append("{} {} {{#{}}}".format("#" * level, inline(m.group(2).strip()), cid))
            out.append("")
            caption = None
            continue

        # ---- 杂项行 -------------------------------------------------------
        if CAPTION_RE.match(line):
            caption = CAPTION_RE.match(line).group(1).strip()
            continue
        if KEYWORD_RE.match(line) or COMMENT_RE.match(line):
            continue
        if DRAWER_RE.match(line):                    # 抽屉：整段跳过
            while i < len(lines) and not END_DRAWER_RE.match(lines[i]):
                i += 1
            i += 1
            continue
        if HR_RE.match(stripped):
            out.append(""); out.append("---"); out.append("")
            continue

        # ---- 表格 ---------------------------------------------------------
        if TABLE_ROW_RE.match(line):
            rows = [line]
            while i < len(lines) and TABLE_ROW_RE.match(lines[i]):
                rows.append(lines[i])
                i += 1
            out.append("")
            out.extend(table_lines(rows))
            out.append("")
            continue

        # ---- 脚注定义（文末的 [fn:1] 说明文字）---------------------------
        m = FN_DEF_RE.match(line)
        if m:
            footnotes.append((m.group(1), m.group(2).strip()))
            continue

        # ---- 图片（可带说明）---------------------------------------------
        m = re.match(r"^[ \t]*\[\[([^\]\[]+)\]\][ \t]*$", line)
        if m and (caption or is_image(m.group(1).split(":", 1)[-1])):
            dest = m.group(1).strip()
            if dest.startswith("file:"):
                dest = dest.split(":", 1)[1]
            if caption:
                out.append('![]({} "{}")'.format(dest, caption))
            else:
                out.append("![]({})".format(dest))
            caption = None
            continue

        # ---- 普通行 -------------------------------------------------------
        out.append(inline(line.strip()))
        caption = None

    if footnotes:
        out.append("")
        out.extend(footnote_block(footnotes))

    text = "\n".join(out)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip() + "\n"


def convert(text):
    head, body = split_head(text)
    return build_front_matter(head) + "\n" + convert_body(body)


# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true", help="真的写文件")
    ap.add_argument("--archive", default="_legacy/org",
                    help="原件归档目录（相对仓库根），设为空表示原地删除")
    args = ap.parse_args()

    files = sorted(CONTENT.rglob("*.org"))
    stats = Counter()
    problems = []
    for p in files:
        rel = p.relative_to(CONTENT)
        text = p.read_text(encoding="utf-8")
        md = convert(text)
        out = p.with_suffix(".md")
        if out.exists():
            problems.append("{} 已存在同名 .md，跳过".format(rel))
            continue
        stats["converted"] += 1
        if args.write:
            out.write_text(md, encoding="utf-8")
            if args.archive:
                dst = ROOT / args.archive / rel
                dst.parent.mkdir(parents=True, exist_ok=True)
                p.rename(dst)
            else:
                p.unlink()

    print("转换 {} 个 .org → .md".format(stats["converted"]))
    for msg in problems:
        print("  ! " + msg)
    print("模式: {}".format("已写入" if args.write else "干跑（加 --write 才写文件）"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
