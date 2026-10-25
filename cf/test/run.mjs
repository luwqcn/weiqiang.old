#!/usr/bin/env node
// 评论接口全量测试。不起 HTTP 服务，直接调 Pages Functions 的 onRequest ——
// 和线上跑的是同一份代码，存储是同构的 SQLite（D1 本身就是 SQLite）。
//
//   node cf/test/run.mjs
//
// 全程内存库，不碰 data/comments.json，也不碰线上 D1。

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { md5 } from "../lib/core.mjs";
import { applySchema, openLocalD1 } from "../lib/d1-sqlite.mjs";

import * as commentsFn from "../../functions/api/comments.js";
import * as healthFn from "../../functions/api/health.js";
import * as adminFn from "../../functions/api/comments-admin.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCHEMA = join(ROOT, "cf/schema.sql");

let pass = 0;
let fail = 0;

function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log("  ok   " + name);
  } else {
    fail++;
    console.log("  FAIL " + name + (detail ? "  -> " + detail : ""));
  }
}

function makeEnv(overrides = {}) {
  const db = openLocalD1(":memory:");
  applySchema(db, SCHEMA);
  return {
    DB: db,
    COMMENTS_ADMIN_TOKEN: "test-token-123",
    COMMENTS_GRAVATAR: "1",
    COMMENTS_SALT: "test-salt",
    ...overrides,
  };
}

async function call(mod, env, opts = {}) {
  const { method = "GET", url = "http://x/api/comments", body, ip = "203.0.113.1", headers = {} } = opts;
  const init = { method, headers: { "content-type": "application/json", ...headers } };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  const request = new Request(url, init);
  request.headers.set("CF-Connecting-IP", ip);
  const res = await mod.onRequest({
    request,
    env,
    params: {},
    data: {},
    next: async () => new Response("nf", { status: 404 }),
    waitUntil: () => {},
  });
  return res;
}

async function asJson(res) {
  const data = await res.json();
  return { status: res.status, headers: res.headers, data };
}

const q = (page) => `http://x/api/comments?page=${encodeURIComponent(page)}`;

// ---------------------------------------------------------------------------
async function runMain() {
  const env = makeEnv();
  const PAGE = "/zh/2026/test-page/";
  const OTHER = "/zh/2026/another/";

  console.log("\n摘要与配置");
  check("md5 空串", md5("") === "d41d8cd98f00b204e9800998ecf8427e");
  check("md5 abc", md5("abc") === "900150983cd24fb0d6963f7d28e17f72");
  check("md5 中文按 UTF-8", md5("中文") === "a7bac2239fcdcb3a067903d8077c4a07", md5("中文"));

  console.log("\n健康检查");
  const h = await asJson(await call(healthFn, env, { url: "http://x/api/health" }));
  check("health 返回 200", h.status === 200);
  check("后端是 sqlite（本地同构）", h.data.backend === "sqlite", h.data.backend);
  check("管理接口显示已开启", h.data.admin === true);

  const noDb = await asJson(await call(healthFn, {}, { url: "http://x/api/health" }));
  check("没有 D1 绑定时 503 且给提示", noDb.status === 503 && Boolean(noDb.data.hint));

  console.log("\n读");
  const empty = await asJson(await call(commentsFn, env, { url: q(PAGE) }));
  check("空页面返回 0 条", empty.data.count === 0, JSON.stringify(empty.data));
  check("缺少 page 参数返回 400",
    (await call(commentsFn, env, { url: "http://x/api/comments" })).status === 400);

  console.log("\n写");
  const first = await asJson(await call(commentsFn, env, {
    method: "POST",
    body: { page: PAGE, name: "林间有风", email: "forest@example.com", website: "example.org",
            content: "第一楼，顺便看看网址补全。", company: "" },
    ip: "203.0.113.11",
  }));
  check("发评论返回 201", first.status === 201, String(first.status));
  check("返回体里有 id", Boolean(first.data.comment && first.data.comment.id));
  check("响应里不含 email", !("email" in (first.data.comment || {})), JSON.stringify(first.data.comment));
  check("不含 ip_hash", !("ip_hash" in (first.data.comment || {})));
  check("网址自动补 https://",
    (first.data.comment || {}).website === "https://example.org/",
    (first.data.comment || {}).website);
  check("邮箱哈希已下发（Gravatar 开着）",
    /^[0-9a-f]{32}$/.test((first.data.comment || {}).avatar_hash || ""));
  check("邮箱哈希是小写去空格的 md5",
    (first.data.comment || {}).avatar_hash === md5("forest@example.com"));

  const afterOne = await asJson(await call(commentsFn, env, { url: q(PAGE) }));
  check("列表里能看到刚发的那条", afterOne.data.count === 1, JSON.stringify(afterOne.data));
  check("total 与 count 一致", afterOne.data.total === 1, String(afterOne.data.total));

  console.log("\n校验");
  const cases = [
    ["昵称必填", { name: "", email: "a@b.co", content: "够长的内容" }],
    ["邮箱必填", { name: "甲", email: "", content: "够长的内容" }],
    ["邮箱格式", { name: "甲", email: "not-an-email", content: "够长的内容" }],
    ["内容太短", { name: "甲", email: "a@b.co", content: "。" }],
    ["网址不像网址", { name: "甲", email: "a@b.co", content: "够长的内容", website: "http://" }],
  ];
  for (const [label, extra] of cases) {
    const r = await asJson(await call(commentsFn, env, {
      method: "POST",
      body: { page: PAGE, company: "", ...extra },
      ip: "203.0.113." + (20 + cases.indexOf(extra)),
    }));
    check(label + " → 400", r.status === 400, `${r.status} ${r.data.error || ""}`);
  }

  console.log("\n蜜罐与限流");
  const honey = await asJson(await call(commentsFn, env, {
    method: "POST",
    body: { page: PAGE, name: "bot", email: "bot@x.co", content: "买点什么吧", company: "有值就是机器人" },
    ip: "203.0.113.30",
  }));
  check("蜜罐命中返回 201（假装成功）", honey.status === 201 && honey.data.dropped === true);
  const afterHoney = await asJson(await call(commentsFn, env, { url: q(PAGE) }));
  check("蜜罐那条没落库", afterHoney.data.count === 1, String(afterHoney.data.count));

  const rl1 = await call(commentsFn, env, {
    method: "POST",
    body: { page: PAGE, name: "刷屏", email: "a@b.co", content: "同一个人连发第一条" },
    ip: "203.0.113.40",
  });
  const rl2 = await asJson(await call(commentsFn, env, {
    method: "POST",
    body: { page: PAGE, name: "刷屏", email: "a@b.co", content: "同一个人连发第二条" },
    ip: "203.0.113.40",
  }));
  check("第一条放行", rl1.status === 201, String(rl1.status));
  check("第二条被限流 429", rl2.status === 429, String(rl2.status));
  check("带 Retry-After", Boolean(rl2.headers.get("retry-after")));

  console.log("\n回复");
  const rootId = first.data.comment.id;
  const reply = await asJson(await call(commentsFn, env, {
    method: "POST",
    body: { page: PAGE, name: "阿墙", email: "q@b.co", content: "回复第一楼。", parent: rootId },
    ip: "203.0.113.12",
  }));
  check("回复带住 parent", (reply.data.comment || {}).parent === rootId,
    String((reply.data.comment || {}).parent));

  const orphan = await asJson(await call(commentsFn, env, {
    method: "POST",
    body: { page: PAGE, name: "阿墙", email: "q@b.co", content: "父级不存在的回复。", parent: "cdeadbeef00" },
    ip: "203.0.113.13",
  }));
  check("父级不存在时降级为普通评论", (orphan.data.comment || {}).parent === "",
    String((orphan.data.comment || {}).parent));

  const crossPage = await asJson(await call(commentsFn, env, {
    method: "POST",
    body: { page: OTHER, name: "阿墙", email: "q@b.co", content: "跨页认亲。", parent: rootId },
    ip: "203.0.113.14",
  }));
  check("父级在别的页面也不认", (crossPage.data.comment || {}).parent === "",
    String((crossPage.data.comment || {}).parent));

  console.log("\n隔离、分页与排序");
  const otherPage = await asJson(await call(commentsFn, env, { url: q(OTHER) }));
  check("别的页面有自己的评论", otherPage.data.count === 1 && otherPage.data.total === 1,
    JSON.stringify(otherPage.data));

  // 这一页此刻有 4 条：首楼 + 回复 + 孤儿降级 + 限流测试里放行的第一条
  const limited = await asJson(await call(commentsFn, env, { url: q(PAGE) + "&limit=1" }));
  check("limit 生效（count 是本次条数，total 是总数）",
    limited.data.count === 1 && limited.data.comments.length === 1 && limited.data.total === 4,
    JSON.stringify({ c: limited.data.count, t: limited.data.total }));

  // 直接灌入乱序时间，验证按 created_ts 排而不是按字符串
  await asJson(await call(adminFn, env, {
    method: "POST",
    url: "http://x/api/comments-admin",
    headers: { authorization: "Bearer test-token-123" },
    body: {
      action: "import", mode: "merge",
      comments: [
        { id: "ctime2", page: "/p/", name: "晚", content: "12:00+08:00 的那条", created: "2026-10-25T12:00:00+08:00", status: "approved" },
        { id: "ctime1", page: "/p/", name: "早", content: "04:00Z 的那条", created: "2026-10-25T04:00:00Z", status: "approved" },
      ],
    },
  }));
  const sorted = await asJson(await call(commentsFn, env, { url: q("/p/") }));
  check("不同时区写法也按真实时间排序",
    sorted.data.comments.map((c) => c.id).join(",") === "ctime1,ctime2",
    sorted.data.comments.map((c) => c.id).join(","));

  console.log("\n并发");
  const before = (await asJson(await call(commentsFn, env, { url: q("/concurrent/") }))).data.count;
  const burst = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      call(commentsFn, env, {
        method: "POST",
        body: { page: "/concurrent/", name: "并发" + i, email: `c${i}@x.co`, content: `第 ${i} 条，同时发。` },
        ip: "198.51.100." + (i + 1),
      }),
    ),
  );
  const okCount = burst.filter((r) => r.status === 201).length;
  const afterBurst = (await asJson(await call(commentsFn, env, { url: q("/concurrent/") }))).data.total;
  check("12 条同时发全部 201", okCount === 12, String(okCount));
  check("一条都没丢", afterBurst === before + 12, `${before} -> ${afterBurst}`);

  console.log("\n管理接口");
  const noAuth = await call(adminFn, env, { url: "http://x/api/comments-admin" });
  check("没令牌 → 401", noAuth.status === 401, String(noAuth.status));
  const badAuth = await call(adminFn, env, {
    url: "http://x/api/comments-admin", headers: { authorization: "Bearer wrong" },
  });
  check("错令牌 → 401", badAuth.status === 401);
  const noTokenEnv = await call(adminFn, makeEnv({ COMMENTS_ADMIN_TOKEN: "" }), {
    url: "http://x/api/comments-admin",
  });
  check("没配令牌 → 503（默认关闭）", noTokenEnv.status === 503, String(noTokenEnv.status));

  const adminHeaders = { authorization: "Bearer test-token-123" };
  const exported = await asJson(await call(adminFn, env, {
    url: "http://x/api/comments-admin", headers: adminHeaders,
  }));
  check("导出成功", exported.status === 200 && Array.isArray(exported.data.comments));
  check("导出保留 email（管理侧要能回信）",
    exported.data.comments.some((c) => c.email === "forest@example.com"));

  const hide = await asJson(await call(adminFn, env, {
    method: "POST", url: "http://x/api/comments-admin",
    headers: adminHeaders, body: { action: "status", id: rootId, status: "pending" },
  }));
  check("审核：改成 pending 成功", hide.status === 200 && hide.data.ok === true);
  const afterHide = await asJson(await call(commentsFn, env, { url: q(PAGE) }));
  check("pending 的不再公开", !afterHide.data.comments.some((c) => c.id === rootId));

  const del = await asJson(await call(adminFn, env, {
    method: "POST", url: "http://x/api/comments-admin",
    headers: adminHeaders, body: { action: "delete", id: rootId },
  }));
  check("删除根评论成功", del.status === 200 && del.data.ok === true);
  check("一并报告带走了几条", del.data.removed >= 2, String(del.data.removed));
  const afterDel = await asJson(await call(commentsFn, env, { url: q(PAGE) }));
  check("删根评论时回复一起没了",
    !afterDel.data.comments.some((c) => c.id === rootId || c.parent === rootId),
    JSON.stringify(afterDel.data.comments.map((c) => c.id)));

  const delMissing = await asJson(await call(adminFn, env, {
    method: "POST", url: "http://x/api/comments-admin",
    headers: adminHeaders, body: { action: "delete", id: "cnope" },
  }));
  check("删不存在的评论 → 404", delMissing.status === 404, String(delMissing.status));

  const merged = await asJson(await call(adminFn, env, {
    method: "POST", url: "http://x/api/comments-admin",
    headers: adminHeaders,
    body: {
      action: "import", mode: "merge",
      comments: [
        { id: "cimport001", page: PAGE, name: "导入", content: "从快照导进来的一条。", created: "2026-01-01T00:00:00Z", status: "approved" },
        { id: "cimport001", page: PAGE, name: "导入", content: "重复 id 应该被跳过。", created: "2026-01-01T00:00:00Z", status: "approved" },
      ],
    },
  }));
  check("merge 导入去重", merged.data.added === 1 && merged.data.skipped === 1,
    JSON.stringify(merged.data));

  console.log("\n边界");
  const big = await call(commentsFn, env, {
    method: "POST", body: "x".repeat(70000), ip: "203.0.113.90",
  });
  check("超大请求 413", big.status === 413, String(big.status));
  const badJson = await call(commentsFn, env, {
    method: "POST", body: "{not json", ip: "203.0.113.91",
  });
  check("坏 JSON 400", badJson.status === 400, String(badJson.status));
  const traversal = await call(commentsFn, env, {
    method: "POST",
    body: { page: "/../../etc/passwd", name: "甲", email: "a@b.co", content: "够长内容" },
    ip: "203.0.113.92",
  });
  check("路径穿越被拒", traversal.status === 400, String(traversal.status));
  const put = await call(commentsFn, env, { method: "PUT" });
  check("不支持的方法 405", put.status === 405, String(put.status));
  const xss = await asJson(await call(commentsFn, env, {
    method: "POST",
    body: { page: "/xss/", name: "<img src=x onerror=alert(1)>", email: "a@b.co",
            content: "<script>alert(1)</script> 原样存" },
    ip: "203.0.113.93",
  }));
  check("尖括号原样存（渲染端负责转义）",
    xss.status === 201 && xss.data.comment.content.includes("<script>"),
    xss.status === 201 ? "ok" : String(xss.status));
}

// ---------------------------------------------------------------------------
async function runModerate() {
  const env = makeEnv({ COMMENTS_MODERATE: "1" });
  console.log("\n审核模式");
  const post = await asJson(await call(commentsFn, env, {
    method: "POST",
    body: { page: "/p/", name: "待审", email: "a@b.co", content: "先审后发的一条评论。", company: "" },
    ip: "198.51.100.10",
  }));
  check("新评论返回 202 而不是 201", post.status === 202, String(post.status));
  check("响应带 pending 标记", post.data.pending === true);

  const list = await asJson(await call(commentsFn, env, { url: q("/p/") }));
  check("待审评论不出现在公开列表", list.data.count === 0, JSON.stringify(list.data));

  const health2 = await asJson(await call(healthFn, env, { url: "http://x/api/health" }));
  check("health 里能看出审核开着", health2.data.moderate === true);
}

// ---------------------------------------------------------------------------
console.log("评论接口测试（Cloudflare 形态）");
await runMain();
await runModerate();

console.log(`\n${pass} 项通过，${fail} 项失败`);
process.exit(fail ? 1 : 0);
