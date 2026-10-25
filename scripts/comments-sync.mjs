#!/usr/bin/env node
// 线上评论 <-> 仓库快照 的双向同步。
//
//   npm run comments:pull            线上 → data/comments.json（建议提交进 git）
//   npm run comments:push            本地 → 线上（合并，不删线上已有的）
//   npm run comments:push:replace    本地 → 线上（整份覆盖，慎用）
//
// 需要两个环境变量：
//   COMMENTS_URL            站点地址，例如 https://weiqiang.org
//   COMMENTS_ADMIN_TOKEN    和 Cloudflare 环境变量里那个保持一致

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DATA = resolve(process.env.COMMENTS_DATA || resolve(ROOT, "data/comments.json"));

const BASE = (process.env.COMMENTS_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.COMMENTS_ADMIN_TOKEN || "";

if (!BASE) {
  console.error("缺 COMMENTS_URL，例如：COMMENTS_URL=https://weiqiang.org npm run comments:pull");
  process.exit(1);
}
if (!TOKEN) {
  console.error("缺 COMMENTS_ADMIN_TOKEN（和 Cloudflare 环境变量里那个一致）");
  process.exit(1);
}

const ENDPOINT = BASE + "/api/comments-admin";
const auth = { Authorization: "Bearer " + TOKEN };

function writeAtomic(file, text) {
  const tmp = file + ".tmp";
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, file);
}

async function pull() {
  const res = await fetch(ENDPOINT, { headers: auth });
  if (!res.ok) {
    console.error(`拉取失败：HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    process.exit(1);
  }
  const data = await res.json();
  const comments = Array.isArray(data.comments) ? data.comments : [];
  const doc = {
    version: 1,
    updated: data.updated || new Date().toISOString(),
    comments,
  };
  writeAtomic(DATA, JSON.stringify(doc, null, 2) + "\n");

  const pages = new Set(comments.map((c) => c.page));
  console.log(`已写入 ${DATA}`);
  console.log(`  共 ${comments.length} 条，分布在 ${pages.size} 个页面`);
}

async function push(mode) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(DATA, "utf8"));
  } catch (err) {
    console.error(`读不了 ${DATA}：${err.message}`);
    process.exit(1);
  }
  const comments = Array.isArray(doc) ? doc : doc.comments;
  if (!Array.isArray(comments)) {
    console.error("数据文件格式不对，应该是 { comments: [...] } 或数组");
    process.exit(1);
  }

  if (mode === "replace") {
    process.stdout.write(`将用本地 ${comments.length} 条整份覆盖线上，5 秒内 Ctrl-C 可取消…\n`);
    await new Promise((r) => setTimeout(r, 5000));
  }

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "import", mode, comments }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    console.error(`推送失败：HTTP ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`推送完成（${mode}）：${body.pages} 个页面，新增 ${body.added} 条` +
              (body.skipped ? `，已存在跳过 ${body.skipped} 条` : ""));
}

const [, , cmd, ...rest] = process.argv;
if (cmd === "pull") {
  await pull();
} else if (cmd === "push") {
  const mode = rest.find((a) => a.startsWith("--mode="))?.slice(7) || "merge";
  await push(mode);
} else {
  console.log(`用法：
  node scripts/comments-sync.mjs pull
  node scripts/comments-sync.mjs push [--mode=merge|replace]

环境变量：COMMENTS_URL、COMMENTS_ADMIN_TOKEN`);
  process.exit(cmd ? 1 : 0);
}
