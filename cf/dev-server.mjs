// 本地开发服务器：一个进程同时发静态文件和 /api/*。
//
// 不用装 wrangler 也能跑：先 npm run build（或 hugo），再
//   npm run dev
// 打开 http://127.0.0.1:8788/ 就是线上形态 —— 同源、无 CORS、SQLite 存储。
//
// 数据库用的是项目内的 .preview/comments.db（git 忽略），不会碰线上 D1。
//
// 环境变量：
//   PORT            监听端口，默认 8788
//   PUBLIC          静态目录，默认 <项目根>/public
//   COMMENTS_DB     本地库文件，默认 <项目根>/.preview/comments.db
//   COMMENTS_SEED   =0 时不把 data/comments.json 灌进空库（默认会灌，方便预览）

import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { makeConfig } from "./lib/core.mjs";
import { applySchema, openLocalD1 } from "./lib/d1-sqlite.mjs";
import { createStore } from "./lib/store.mjs";
import { importAll } from "./lib/service.mjs";

import * as commentsFn from "../functions/api/comments.js";
import * as healthFn from "../functions/api/health.js";
import * as adminFn from "../functions/api/comments-admin.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = resolve(process.env.PUBLIC || join(ROOT, "public"));
const PORT = parseInt(process.env.PORT || "8788", 10);
const DB_FILE = resolve(process.env.COMMENTS_DB || join(ROOT, ".preview/comments.db"));

const ROUTES = new Map([
  ["/api/comments", commentsFn],
  ["/api/health", healthFn],
  ["/api/comments-admin", adminFn],
]);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

// ---------------------------------------------------------------------------
// 数据库
// ---------------------------------------------------------------------------
mkdirSync(dirname(DB_FILE), { recursive: true });
const db = openLocalD1(DB_FILE);
applySchema(db, join(ROOT, "cf/schema.sql"));

const env = {
  DB: db,
  COMMENTS_ADMIN_TOKEN: process.env.COMMENTS_ADMIN_TOKEN || "dev-token",
  COMMENTS_MODERATE: process.env.COMMENTS_MODERATE || "",
  COMMENTS_GRAVATAR: process.env.COMMENTS_GRAVATAR || "1",
  COMMENTS_SALT: process.env.COMMENTS_SALT || "local-dev-salt",
  COMMENTS_SITE: "http://127.0.0.1:" + PORT,
};

const cfg = makeConfig(env);
const store = createStore(db);

// 空库时把快照灌进来，预览一打开就有评论可看。
// COMMENTS_SNAPSHOT 可以指到别的文件（本地预览常用 .preview/comments.json），
// 让「构建时直出的那份」和「接口返回的那份」是同一批数据。
if (process.env.COMMENTS_SEED !== "0") {
  const { total } = await store.stats();
  const snapPath = resolve(ROOT, process.env.COMMENTS_SNAPSHOT || "data/comments.json");
  if (total === 0 && existsSync(snapPath)) {
    const { readFileSync } = await import("node:fs");
    const snap = JSON.parse(readFileSync(snapPath, "utf8"));
    const rows = Array.isArray(snap) ? snap : snap.comments || [];
    if (rows.length) {
      const r = await importAll(cfg, store, rows, "merge");
      console.log(`已从 ${process.env.COMMENTS_SNAPSHOT || "data/comments.json"} 导入 ${r.added} 条评论`);
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function readBody(req) {
  return new Promise((ok, fail) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => ok(Buffer.concat(chunks)));
    req.on("error", fail);
  });
}

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end("bad path");
    return;
  }

  let file = normalize(join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403).end("forbidden");
    return;
  }

  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!existsSync(file)) {
    const notFound = join(PUBLIC, "404.html");
    if (existsSync(notFound)) {
      res.writeHead(404, { "Content-Type": TYPES[".html"] });
      createReadStream(notFound).pipe(res);
    } else {
      res.writeHead(404, { "Content-Type": TYPES[".txt"] }).end("404");
    }
    return;
  }

  res.writeHead(200, {
    "Content-Type": TYPES[extname(file).toLowerCase()] || "application/octet-stream",
    "Cache-Control": "no-store",
  });
  createReadStream(file).pipe(res);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  if (pathname === "/api" || pathname.startsWith("/api/")) {
    console.log(`[dev] ${req.method} ${url.pathname}${url.search}`);

    const mod = ROUTES.get(pathname);
    const handler = mod && (mod.onRequest || mod.default);
    if (!handler) {
      res.writeHead(404, { "Content-Type": TYPES[".json"] }).end('{"ok":false,"error":"no such api"}');
      return;
    }

    try {
      const body = ["GET", "HEAD"].includes(req.method) ? undefined : await readBody(req);
      const request = new Request(url, {
        method: req.method,
        headers: req.headers,
        body: body && body.length ? body : undefined,
      });

      // 本地没有 CF 的头，补上一个，让限流按「本机 IP」走
      if (!request.headers.get("CF-Connecting-IP")) {
        request.headers.set("CF-Connecting-IP", req.socket.remoteAddress || "127.0.0.1");
      }

      const response = await handler({
        request,
        env,
        params: {},
        data: {},
        next: async () => new Response("not found", { status: 404 }),
        waitUntil: () => {},
      });

      const headers = {};
      response.headers.forEach((v, k) => { headers[k] = v; });
      res.writeHead(response.status, headers);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      console.error("[dev] 接口炸了：", err);
      res.writeHead(500, { "Content-Type": TYPES[".json"] }).end('{"ok":false,"error":"internal"}');
    }
    return;
  }

  serveStatic(req, res, url.pathname);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n评论开发服务器：http://127.0.0.1:${PORT}/`);
  console.log(`静态目录：${PUBLIC}${existsSync(PUBLIC) ? "" : "（还没有，先跑 npm run build）"}`);
  console.log(`本地数据库：${DB_FILE}`);
  console.log(`管理令牌：${env.COMMENTS_ADMIN_TOKEN}\n`);
});
