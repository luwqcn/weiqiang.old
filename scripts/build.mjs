#!/usr/bin/env node
/**
 * 构建入口：先直出评论到 data/commenttrees.json，再用「确定版本」的 Hugo 出站。
 *
 * 为什么自己管 Hugo 版本
 * ---------------------
 * Cloudflare Pages 构建镜像自带 Hugo 0.147.7，而主题用了两个更新版本的语法：
 *   · {{ return 值 }}          —— 0.148.0 起支持，主题里 12 处
 *   · site.Language.Locale     —— 0.158.0 起支持（已在本仓库改成 params.langCode）
 * 镜像里的 hugo 版本太低，构建会在 render 阶段直接失败。
 *
 * 官方给的办法是在 Pages 项目里设 HUGO_VERSION 环境变量，但本项目实测设了不生效
 * （构建日志 "Build environment variables: (none found)"，版本仍是 0.147.7）。
 * 所以这里不再依赖控制台：先看系统 hugo 够不够新，不够就下载指定版本再跑。
 * 结果与 Cloudflare / 本地 / CI 的环境无关，哪儿跑都一样。
 *
 * 用法：
 *   node scripts/build.mjs                  # 等价于旧 npm run build
 *   node scripts/build.mjs --baseURL https://x.pages.dev/
 *
 * 环境变量：
 *   HUGO_VERSION        要下载的版本，默认 0.168.0
 *   HUGO_FORCE_DOWNLOAD=1  跳过系统 hugo，强制走下载（调试用）
 */
import { spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// 模板真正需要的最低版本（{{ return 值 }} 从 0.148 起，Locale 从 0.158 起）
const MIN_VERSION = "0.158.0";
// 系统版本不够时装这个。跟本地开发用的版本对齐，避免"本地好好的线上就错"
const PIN_VERSION = process.env.HUGO_VERSION || "0.168.0";
const CACHE_DIR = path.resolve(".hugo");
const IS_WIN = process.platform === "win32";

/* ---------- 版本比较 ---------- */

function parseVersion(text) {
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(text || "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function gte(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}

function fmt(v) {
  return v.join(".");
}

/* ---------- 找一个能用的 hugo ---------- */

function probe(bin) {
  const r = spawnSync(bin, ["version"], { encoding: "utf8", timeout: 30_000 });
  if (r.error || r.status !== 0) return null;
  const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
  const v = parseVersion(out);
  if (!v) return null;
  return { bin, version: v, raw: out.split("\n")[0] };
}

/** 下载指定版本的 Hugo 到 .hugo/ 并返回可执行路径 */
async function download(tag) {
  const arch = { x64: "amd64", arm64: "arm64" }[process.arch];
  if (!arch) throw new Error(`不支持的 CPU 架构：${process.arch}`);
  const platform = IS_WIN ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
  if (platform === "windows") throw new Error("Windows 下请自行安装 Hugo，本脚本只负责 Linux / macOS");

  await fs.mkdir(CACHE_DIR, { recursive: true });

  // extended 跟镜像里的一致；万一运行不起来（缺 libstdc++）退回标准版。
  // 主题没有 SCSS，标准版完全够用。
  const editions = ["extended", "plain"];
  const errors = [];

  for (const edition of editions) {
    const asset = edition === "extended"
      ? `hugo_extended_${tag}_${platform}-${arch}.tar.gz`
      : `hugo_${tag}_${platform}-${arch}.tar.gz`;
    const url = `https://github.com/gohugoio/hugo/releases/download/v${tag}/${asset}`;
    const tmp = path.join(CACHE_DIR, `${asset}.part`);

    try {
      console.log(`  下载 ${asset}`);
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));

      const out = spawnSync("tar", ["-xzf", tmp, "-C", CACHE_DIR], { encoding: "utf8" });
      await fs.rm(tmp, { force: true });
      if (out.error) throw out.error;
      if (out.status !== 0) throw new Error(`解压失败：${(out.stderr || "").trim()}`);

      const bin = path.join(CACHE_DIR, "hugo");
      await fs.chmod(bin, 0o755);
      const info = probe(bin);
      if (!info) throw new Error("下载的二进制跑不起来");
      return info;
    } catch (err) {
      errors.push(`${asset}: ${err.message}`);
      await fs.rm(tmp, { force: true });
    }
  }

  throw new Error(`Hugo ${tag} 下载失败：\n  ${errors.join("\n  ")}`);
}

async function resolveHugo() {
  const min = parseVersion(MIN_VERSION);

  if (!process.env.HUGO_FORCE_DOWNLOAD) {
    // 本地缓存的优先（上次下载的），省一次下载
    const cached = probe(path.join(CACHE_DIR, IS_WIN ? "hugo.exe" : "hugo"));
    if (cached && gte(cached.version, min)) return { ...cached, where: "缓存的 .hugo/" };

    const onPath = probe("hugo");
    if (onPath && gte(onPath.version, min)) return { ...onPath, where: "系统 PATH" };
    if (onPath) {
      console.log(`系统 hugo ${fmt(onPath.version)} 低于要求的 ${MIN_VERSION}，改走下载。`);
    } else {
      console.log("找不到 hugo，直接下载。");
    }
  }

  const got = await download(PIN_VERSION);
  if (!gte(got.version, min)) {
    throw new Error(`下载到的 Hugo ${fmt(got.version)} 仍低于最低要求 ${MIN_VERSION}`);
  }
  return { ...got, where: "刚下载" };
}

/* ---------- 主流程 ---------- */

// 构建机时区默认 UTC，会让东八区写下的日期差一天。这里钉死，日志时间也可读。
process.env.TZ = "Asia/Shanghai";

const hugo = await resolveHugo();
console.log(`Hugo ${fmt(hugo.version)}（${hugo.where}）`);
console.log(`  ${hugo.raw}`);

// 1. 评论直出：读 data/comments.json 快照 → data/commenttrees.json
const prerender = spawnSync(process.execPath, ["scripts/comments-prerender.mjs"], {
  stdio: "inherit",
  env: process.env,
});
if (prerender.status !== 0) {
  console.error("评论预渲染失败，构建中止。");
  process.exit(prerender.status ?? 1);
}

// 2. Hugo 出站
const extra = process.argv.slice(2);
const args = ["--gc", "--minify", ...extra];
console.log(`\n执行：hugo ${args.join(" ")}\n`);

const built = spawnSync(hugo.bin, args, { stdio: "inherit", env: process.env });
if (built.error) {
  console.error(`无法执行 ${hugo.bin}：${built.error.message}`);
  process.exit(1);
}
process.exit(built.status ?? 1);
