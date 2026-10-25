// 业务层：读评论、发评论、审核、导入导出。
//
// 和上一版相比，最大的变化是没有「读整页 → 改 → 写回」了：
// 发评论是一条 INSERT，父级校验是一条 SELECT，删整串用递归 CTE。
// 并发不再需要重试，代码也短了。

import {
  HttpError, PARENT_RE, clean, makeId, nowIso, publicView,
  sha256Hex, validateComment,
} from "./core.mjs";

// 同一个 IP 的节奏：15 秒 1 条、10 分钟 5 条、一天 30 条
const RATE_RULES = [[1, 15], [5, 600], [30, 86400]];
const DAY_MS = 86400 * 1000;

export async function ipHash(cfg, ip) {
  const digest = await sha256Hex(cfg.salt + "|" + String(ip || ""));
  return digest.slice(0, 24);
}

/** 放行返回 { wait: 0 }，否则返回 { wait: 秒 }。 */
async function rateCheck(store, cfg, ip) {
  const hash = await ipHash(cfg, ip);
  const now = Date.now();
  const hits = await store.recentHits(hash, now - DAY_MS);

  let wait = 0;
  for (const [count, windowSec] of RATE_RULES) {
    const cutoff = now - windowSec * 1000;
    const recent = hits.filter((t) => t > cutoff);
    if (recent.length >= count) {
      wait = Math.max(wait, Math.ceil((recent[0] + windowSec * 1000 - now) / 1000) + 1);
    }
  }
  if (wait) return { wait, hash };

  await store.addHit(hash, now);
  // 一天前的记录顺手清掉，不用每次都清
  if (Math.random() < 0.02) await store.pruneHits(now - DAY_MS);
  return { wait: 0, hash };
}

// ---------------------------------------------------------------------------
// 读
// ---------------------------------------------------------------------------
export async function listComments(cfg, store, page, limit) {
  const { comments, total } = await store.listPage(page, limit);
  return {
    page,
    // count 是这次返回的条数（和历史接口一致），total 是这页一共多少条
    count: comments.length,
    total,
    comments: comments.map((c) => publicView(c, cfg)),
  };
}

// ---------------------------------------------------------------------------
// 写
// ---------------------------------------------------------------------------
export async function addComment(cfg, store, payload, ip) {
  // 蜜罐：正常访客看不见这个「公司」输入框，填了的都是脚本。静默丢弃并假装成功。
  if (clean(payload && payload.company)) {
    return { dropped: true };
  }

  const { page, name, email, content, website } = validateComment(payload || {});

  // 限流放在校验之后：填错的表单不占配额，否则改一次错字就被锁 15 秒。
  const { wait, hash } = await rateCheck(store, cfg, ip);
  if (wait) {
    const err = new HttpError(429, `发得有点快，${wait} 秒后再试试。`);
    err.retryAfter = wait;
    throw err;
  }

  // 回复关系：父级必须是同一页上真实存在的一条。
  // 找不到（被删了 / id 写错 / 还在审核）就退化成普通评论 ——
  // 别因为父级没了，把人家写的字一起丢掉。
  let parent = clean(payload.parent);
  if (parent && !PARENT_RE.test(parent)) parent = "";
  if (parent) {
    const root = await store.getById(parent);
    if (!root || root.page !== page) parent = "";
  }

  const comment = {
    id: makeId(),
    page,
    parent,
    name,
    email,
    website,
    content,
    created: nowIso(),
    status: cfg.moderate ? "pending" : "approved",
    ip_hash: hash,
  };

  await store.insert(comment);

  if (comment.status === "pending") {
    return { pending: true, message: "收到了，等站长过一眼就会显示出来。" };
  }
  return { comment: publicView(comment, cfg) };
}

// ---------------------------------------------------------------------------
// 管理：导出 / 导入 / 审核 / 删除
// ---------------------------------------------------------------------------
export async function exportAll(store) {
  const rows = await store.listAll();
  return { version: 1, updated: nowIso(), comments: rows };
}

export async function importAll(cfg, store, input, mode = "merge") {
  const doc = typeof input === "string" ? JSON.parse(input) : input;
  const rows = Array.isArray(doc) ? doc : doc && doc.comments;
  if (!Array.isArray(rows)) throw new HttpError(400, "导入内容应该是 { comments: [...] } 或数组");

  const valid = rows.filter((c) => c && typeof c === "object" && c.id && c.page);
  const pages = new Set(valid.map((c) => c.page));
  const { added, skipped } = await store.insertMany(valid, mode === "replace" ? "replace" : "merge");
  return { ok: true, mode, pages: pages.size, added, skipped };
}

export async function setStatus(cfg, store, commentId, status) {
  if (!["approved", "pending", "spam"].includes(status)) {
    throw new HttpError(400, "status 只能是 approved / pending / spam");
  }
  const changed = await store.updateStatus(commentId, status);
  if (!changed) throw new HttpError(404, "没有这条评论");
  const fresh = await store.getById(commentId);
  return { ok: true, comment: fresh ? publicView(fresh, cfg) : null };
}

export async function deleteComment(store, commentId) {
  const exists = await store.getById(commentId);
  if (!exists) throw new HttpError(404, "没有这条评论");
  // 删根评论时把整串回复一起带走，免得页面上留下一串没头没尾的话
  const removed = await store.deleteCascade(commentId);
  return { ok: true, id: commentId, removed };
}

export async function health(cfg, store) {
  const stats = await store.stats();
  return {
    ok: true,
    backend: store.kind,
    moderate: cfg.moderate,
    gravatar: cfg.gravatar,
    admin: Boolean(cfg.adminToken),
    stats,
    time: nowIso(),
  };
}
