// GET /api/comments?page=/zh/2026/xxx/   读
// POST /api/comments                      发
//
// Cloudflare Pages Functions 的文件路由：functions/api/comments.js 就是
// /api/comments。站点和接口同一个域名，不需要任何 CORS 配置。

import { HttpError, LIMITS, makeConfig } from "../../cf/lib/core.mjs";
import { createStore } from "../../cf/lib/store.mjs";
import { addComment, listComments } from "../../cf/lib/service.mjs";

const json = (status, body, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // 评论刚发完刷新就得看见，一律不缓存
      "Cache-Control": "no-store",
      ...extra,
    },
  });

function clientIp(request) {
  // Cloudflare 一定会塞这个头，访客伪造不了
  return (
    request.headers.get("CF-Connecting-IP") ||
    (request.headers.get("X-Forwarded-For") || "").split(",")[0].trim() ||
    "unknown"
  );
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  if (!env || !env.DB) {
    console.error("[comments] 没有绑定 D1：检查 wrangler.toml 里的 d1_databases");
    return json(503, { ok: false, error: "评论库没接上，等站长处理。" });
  }

  const cfg = makeConfig(env);
  const store = createStore(env.DB);

  try {
    if (method === "GET") {
      const page = url.searchParams.get("page") || "";
      if (!page) return json(400, { ok: false, error: "缺少 page 参数" });
      const limit = url.searchParams.get("limit") || "200";
      const data = await listComments(cfg, store, page, limit);
      return json(200, { ok: true, ...data });
    }

    if (method === "POST") {
      const length = parseInt(request.headers.get("content-length") || "0", 10);
      if (length > LIMITS.body) return json(413, { ok: false, error: "内容太长了" });

      const text = await request.text();
      if (!text) return json(400, { ok: false, error: "请求是空的" });
      if (text.length > LIMITS.body) return json(413, { ok: false, error: "内容太长了" });

      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        return json(400, { ok: false, error: "请求格式不对" });
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return json(400, { ok: false, error: "请求格式不对" });
      }

      const result = await addComment(cfg, store, payload, clientIp(request));

      if (result.dropped) return json(201, { ok: true, dropped: true });
      if (result.pending) return json(202, { ok: true, pending: true, message: result.message });
      return json(201, { ok: true, comment: result.comment });
    }

    return json(405, { ok: false, error: "不支持的方法" }, { Allow: "GET, POST" });
  } catch (err) {
    if (err instanceof HttpError) {
      const extra = err.retryAfter ? { "Retry-After": String(err.retryAfter) } : {};
      return json(err.status, { ok: false, error: err.message }, extra);
    }
    console.error("[comments] 未预期错误：", err && err.stack ? err.stack : err);
    return json(500, { ok: false, error: "服务刚才打了个嗝，稍后再试。" });
  }
}
