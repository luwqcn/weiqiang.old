#!/usr/bin/env node
// 把 data/comments.json 预渲染成「按页面分好组的评论树」，给 Hugo 构建时直出。
//
//   node scripts/comments-prerender.mjs
//
// 为什么要有这一步：
//   评论如果全靠浏览器拉接口，读者要等 HTML → JS → 接口三个来回才看见字。
//   把上次的快照在构建时就写进 HTML，评论区首屏立刻有内容，接口慢、甚至
//   接口挂了，读者照样能看评论。JS 起来之后再拉一次，补上新增的那些。
//
// 输出：data/commenttrees.json（生成物，已 gitignore）
//
// 树的结构和前端 buildTree() 完全一致：回复挂到它所在那串的根评论下面，
// 父级找不到（被删了 / 还在审核）就自己当根 —— 一条都不会消失。

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// 默认读仓库快照；本地预览可以用 COMMENTS_SNAPSHOT 指到别处（比如 .preview/）
const SRC = process.env.COMMENTS_SNAPSHOT
  ? resolve(ROOT, process.env.COMMENTS_SNAPSHOT)
  : join(ROOT, "data/comments.json");
const AVATARS = join(ROOT, "data/avatars.json");
const OUT = join(ROOT, "data/commenttrees.json");

// 和接口默认 limit 对齐：静态最多直出这么多条
const PER_PAGE = 200;

// 头像底色：跟 assets/js/comments-json.js 里同一套色相，同一个昵称在
// 静态直出和 JS 渲染下颜色一致，刷新时不会跳。
const HUES = [6, 24, 42, 92, 148, 188, 212, 262, 318];

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function hueOf(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 100000;
  return HUES[h % HUES.length];
}

function initialOf(name) {
  const s = String(name || "").trim();
  if (!s) return "?";
  return String.fromCodePoint(s.codePointAt(0)).toUpperCase();
}

function pad(n) {
  return n < 10 ? "0" + n : String(n);
}

/** 构建机时区下的日期，别让读者看到一个差一天的日期。 */
function dateText(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || "").slice(0, 10);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function tsOf(c) {
  const t = Date.parse(String((c && c.created) || ""));
  return Number.isFinite(t) ? t : 0;
}

// ---------------------------------------------------------------------------
const snapshot = readJson(SRC, { comments: [] });
const rows = Array.isArray(snapshot) ? snapshot : snapshot.comments || [];
const avatarMap = readJson(AVATARS, {});

const visible = rows.filter(
  (c) => c && c.id && c.page && (c.status === undefined || c.status === "" || c.status === "approved"),
);

// 按页面分组
const byPage = new Map();
for (const c of visible) {
  if (!byPage.has(c.page)) byPage.set(c.page, []);
  byPage.get(c.page).push(c);
}

const pages = {};
let dropped = 0;

for (const [page, list] of byPage) {
  const sorted = list.slice().sort((a, b) => tsOf(a) - tsOf(b));

  const byId = new Map(sorted.map((c) => [c.id, c]));
  const rootOf = (c) => {
    let cur = c;
    let hops = 0;
    while (cur.parent && byId.has(cur.parent) && hops < 20) {
      const next = byId.get(cur.parent);
      if (next === cur) break;
      cur = next;
      hops++;
    }
    return cur;
  };

  const roots = [];
  const kids = new Map();
  for (const c of sorted) {
    const r = rootOf(c);
    if (r === c) roots.push(c);
    else {
      if (!kids.has(r.id)) kids.set(r.id, []);
      kids.get(r.id).push(c);
    }
  }

  // 太多了就只留最近的，和接口 limit 的行为一致
  let kept = roots;
  if (roots.length > PER_PAGE) {
    kept = roots.slice(-PER_PAGE);
    dropped += roots.length - PER_PAGE;
  }

  const node = (c, replyTo) => ({
    id: String(c.id),
    name: String(c.name || "匿名"),
    website: /^https?:\/\//i.test(String(c.website || "")) ? String(c.website) : "",
    content: String(c.content || ""),
    created: String(c.created || ""),
    date: dateText(c.created),
    // 头像映射是手写在 data/avatars.json 的；这里只带原值，
    // 子路径前缀由模板按 baseURL 补
    avatar: String(avatarMap[c.name] || ""),
    initial: initialOf(c.name),
    hue: hueOf(String(c.name || "")),
    replyTo: replyTo || "",
  });

  pages[page] = kept.map((r) => {
    const children = kids.get(r.id) || [];
    return {
      ...node(r, ""),
      kids: children.map((child) => ({
        ...node(child, child.parent && child.parent !== r.id ? (byId.get(child.parent) || {}).name || "" : ""),
      })),
    };
  });
}

const out = {
  version: 1,
  generated: new Date().toISOString(),
  source: "data/comments.json",
  pages,
};

writeFileSync(OUT, JSON.stringify(out) + "\n", "utf8");

const count = Object.values(pages).reduce((n, list) => n + list.length, 0);
console.log(
  `评论预渲染：${Object.keys(pages).length} 个页面 / ${visible.length} 条评论` +
    (dropped ? `（超出上限省略 ${dropped} 个根评论）` : "") +
    ` → data/commenttrees.json`,
);
if (count === 0) {
  console.log("  快照里没有可直出的评论：页面会显示「正在读取评论…」，交给接口补。");
}
