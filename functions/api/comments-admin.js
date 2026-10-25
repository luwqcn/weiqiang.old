// /api/comments-admin —— 导出、导入、审核、删除。
//
// 没有配置 COMMENTS_ADMIN_TOKEN 时整个端点返回 503 —— 宁可关掉，也不要默认放行。
// 令牌放在 Cloudflare 的加密环境变量里（wrangler pages secret put），不进仓库。
//
//   GET                                       导出全部（含 email，给同步脚本用）
//   POST {action:"status", id, status}        审核：approved / pending / spam
//   POST {action:"delete", id}                删除（根评论会带走整串回复）
//   POST {action:"import", mode, comments}     导入：merge 去重 / replace 清空重来

import { HttpError, makeConfig } from "../../cf/lib/core.mjs";
import { createStore } from "../../cf/lib/store.mjs";
import { deleteComment, exportAll, importAll, setStatus } from "../../cf/lib/service.mjs";

const json = (status, body, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extra,
    },
  });

/** 定长比较，别让时间差把令牌一位一位问出来。 */
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function onRequest(context) {
  const { request, env } = context;
  const cfg = makeConfig(env);

  if (!cfg.adminToken) {
    return json(503, { ok: false, error: "管理接口没开：先设 COMMENTS_ADMIN_TOKEN" });
  }
  const given = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!given || !safeEqual(given, cfg.adminToken)) {
    return json(401, { ok: false, error: "令牌不对" });
  }
  if (!env || !env.DB) {
    return json(503, { ok: false, error: "评论库没接上（env.DB 缺失）" });
  }

  const store = createStore(env.DB);

  try {
    if (request.method.toUpperCase() === "GET") {
      const data = await exportAll(store);
      const url = new URL(request.url);
      const headers = url.searchParams.has("download")
        ? { "Content-Disposition": 'attachment; filename="comments.json"' }
        : {};
      return json(200, data, headers);
    }

    if (request.method.toUpperCase() === "POST") {
      const body = await request.json().catch(() => null);
      if (!body || typeof body !== "object") return json(400, { ok: false, error: "请求格式不对" });

      const action = body.action || (body.comments ? "import" : "");

      if (action === "import") {
        const result = await importAll(cfg, store, body.comments ? body : body.data, body.mode || "merge");
        return json(200, result);
      }
      if (action === "status") {
        const result = await setStatus(cfg, store, String(body.id || ""), String(body.status || ""));
        return json(200, result);
      }
      if (action === "delete") {
        const result = await deleteComment(store, String(body.id || ""));
        return json(200, result);
      }
      return json(400, { ok: false, error: "未知的 action" });
    }

    return json(405, { ok: false, error: "不支持的方法" }, { Allow: "GET, POST" });
  } catch (err) {
    if (err instanceof HttpError) return json(err.status, { ok: false, error: err.message });
    console.error("[comments-admin] 出错：", err && err.stack ? err.stack : err);
    return json(500, { ok: false, error: String((err && err.message) || err) });
  }
}
