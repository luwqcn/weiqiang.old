#!/usr/bin/env python3
"""
把 Artalk 评论数据的 page_key 在「旧站 .html」和「漂亮 URL」之间互相改写。

背景
----
评论是按 page_key 存的。旧站（Emacs + Org-Mode 导出）页面上 Artalk 的
pageKey 是空的 —— Artalk 2.x 遇到空值会取 location.pathname，所以库里存的是
当时的路径：/zh/2016-05-11-find-your-own-X.html。

站点换成 Hugo 的漂亮 URL 后，路径变成 /zh/2016-05-11-find-your-own-X/，
用新路径去查一条评论都查不到 —— 数据没丢，只是 key 对不上了。

两种改法，看你能碰到哪一层：

  A. 有数据库（推荐，改动最小、不重复评论）
     sqlite： sqlite3 data/artalk-go.db
     mysql：  mysql  artalk

       UPDATE comments
          SET page_key = CONCAT(LEFT(page_key, LENGTH(page_key)-5), '/')
        WHERE page_key LIKE '%.html';
       -- 整站首页类： /index.html -> /
       UPDATE comments SET page_key = '/' WHERE page_key = '/index.html';

       UPDATE pages
          SET `key` = CONCAT(LEFT(`key`, LENGTH(`key`)-5), '/')
        WHERE `key` LIKE '%.html';

     改完把站点配置里的 params.comments.artalk.legacyKeys 设回 false。
     执行前先备份数据库文件。

  B. 只有导出文件（Artrans）
     artalk export ./backup.artrans           # 或控制中心「迁移」里导出
     python3 scripts/artalk-migrate.py backup.artrans --write pretty.artrans
     # 然后把 pretty.artrans 导回 Artalk（控制中心或 artalk import）

     注意：直接导回同一个实例会「重复一遍评论」（旧 key 那批还在），
     所以要么导入到一个干净的实例/站点，要么先按 A 的方式清掉旧数据。

用法
----
    python3 scripts/artalk-migrate.py backup.artrans            # 预演，只报告
    python3 scripts/artalk-migrate.py backup.artrans --write pretty.artrans
    python3 scripts/artalk-migrate.py backup.artrans --to legacy --write back.artrans
    python3 scripts/artalk-migrate.py backup.artrans --check-public public   # 校验新 key 有对应页面
"""
import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parent.parent


# --------------------------------------------------------------------------
# Artrans 读写
# --------------------------------------------------------------------------
def load_artrans(path: Path):
    """Artalk 导出的是 JSON 数组；也兼容每行一个对象的 NDJSON。"""
    text = path.read_text(encoding="utf-8-sig")
    try:
        data = json.loads(text)
        if isinstance(data, dict):            # 有些版本包了一层 {"artrans": [...]}
            data = data.get("artrans", data.get("data"))
        if not isinstance(data, list):
            raise ValueError("顶层不是数组")
        return data, "array"
    except json.JSONDecodeError:
        items = [json.loads(ln) for ln in text.splitlines() if ln.strip()]
        return items, "ndjson"


# --------------------------------------------------------------------------
# key 变换
# --------------------------------------------------------------------------
def to_pretty(path: str) -> str:
    """'/zh/a.html' -> '/zh/a/'   '/index.html' -> '/'"""
    if path.endswith("/index.html"):
        return path[: -len("index.html")] or "/"
    if path.endswith(".html"):
        return path[: -len(".html")] + "/"
    return path


def to_legacy(path: str) -> str:
    """'/zh/a/' -> '/zh/a.html'   '/' -> '/'"""
    if path in ("/", ""):
        return "/"
    return path.rstrip("/") + ".html"


def convert(key: str, direction: str):
    """返回 (新 key, 是否变化)。带域名的完整 URL 只改路径部分。"""
    if not key:
        return key, False
    parts = urlsplit(key)
    if parts.scheme or parts.netloc:          # 完整 URL：只动 path
        new_path = to_pretty(parts.path) if direction == "pretty" else to_legacy(parts.path)
        if new_path == parts.path:
            return key, False
        return urlunsplit((parts.scheme, parts.netloc, new_path, parts.query, parts.fragment)), True
    new = to_pretty(key) if direction == "pretty" else to_legacy(key)
    return new, new != key


def main() -> int:
    ap = argparse.ArgumentParser(description="改写 Artalk 评论的 page_key")
    ap.add_argument("artrans", type=Path, help="Artrans 导出文件")
    ap.add_argument("--to", choices=["pretty", "legacy"], default="pretty",
                    help="pretty：/zh/a.html -> /zh/a/（默认）；legacy：反向")
    ap.add_argument("--write", type=Path, metavar="OUT", help="写出新文件；不给则只预演")
    ap.add_argument("--check-public", type=Path, metavar="DIR", default=ROOT / "public",
                    help=f"用构建产物校验新 key 有没有对应页面（默认 {ROOT/'public'}）")
    ap.add_argument("--no-check", action="store_true", help="跳过 public 校验")
    args = ap.parse_args()

    if not args.artrans.is_file():
        sys.exit(f"找不到文件：{args.artrans}")

    rows, fmt = load_artrans(args.artrans)
    print(f"读入 {args.artrans.name}：{len(rows)} 条评论（{fmt}）")

    changed = 0
    examples = []
    missing = Counter()
    for row in rows:
        old = row.get("page_key", "") or ""
        new, diff = convert(old, args.to)
        if diff:
            changed += 1
            row["page_key"] = new
            if len(examples) < 8:
                examples.append((old, new))

    sites = Counter(r.get("site_name", "") or "(空)" for r in rows)

    print(f"方向：{args.to}")
    print(f"需要改写的 key：{changed} 条 / 共 {len(rows)} 条")
    print("站点分布：", dict(sites))
    if examples:
        print("示例：")
        for old, new in examples:
            print(f"  {old}  ->  {new}")

    # 校验：新 key 是否在构建产物里真有对应页面
    if args.to == "pretty" and not args.no_check:
        pub = args.check_public
        if not pub.is_dir():
            print(f"\n（跳过校验：{pub} 不存在，先跑一次 hugo 再校验）")
        else:
            for key, cnt in Counter(r.get("page_key", "") for r in rows).items():
                if not key.startswith("/") or "?" in key:
                    continue
                local = key if key.endswith("/") else key + "/"
                if not (pub / local.lstrip("/") / "index.html").is_file():
                    if not (pub / local.lstrip("/")).is_file():
                        missing[key] = cnt
            if missing:
                print(f"\n注意：有 {len(missing)} 个 key 在 {pub} 里找不到对应页面 "
                      f"（可能页面已改名/删除，评论会“查不到”）：")
                for k, c in missing.most_common(10):
                    print(f"  {c} 条  {k}")
            else:
                print(f"\n校验通过：所有 key 在 {pub} 里都有对应页面。")

    if args.write:
        args.write.parent.mkdir(parents=True, exist_ok=True)
        if fmt == "array":
            args.write.write_text(json.dumps(rows, ensure_ascii=False, indent=2),
                                  encoding="utf-8")
        else:
            args.write.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows),
                                  encoding="utf-8")
        print(f"\n已写出：{args.write}")
        print("导回 Artalk 后，记得把 hugo.toml 里的 "
              "params.comments.artalk.legacyKeys 改回 false。")
    else:
        print("\n只是预演，没写文件。加 --write <输出文件> 才会真正生成。")

    return 0


if __name__ == "__main__":
    sys.exit(main())
