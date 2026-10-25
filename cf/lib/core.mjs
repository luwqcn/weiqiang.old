// 评论模块的公共底座：配置、清洗、校验、id、摘要。
//
// 这一份要同时跑在三个地方，所以只用 Web 标准 API（TextEncoder / crypto /
// URL / Date），不碰任何 node: 内置模块：
//
//   Cloudflare Workers（线上）
//   Node（本地 dev-server 和测试，Node 18+ 都有全局 crypto）
//
// 行为跟 comments-api/server.py 保持一致 —— 同一份数据两套后端不该校出两种结果。

// ---------------------------------------------------------------------------
// 配置：Workers 里没有 process.env，一切都从 env 传进来
// ---------------------------------------------------------------------------
const TRUTHY = new Set(["1", "true", "yes", "on"]);

function str(v) {
  return v === undefined || v === null ? "" : String(v).trim();
}

function flag(v, fallback) {
  const s = str(v).toLowerCase();
  if (!s) return fallback;
  return TRUTHY.has(s);
}

/** env 可以是 Workers 的 env、process.env，或者一个普通对象。 */
export function makeConfig(env = {}) {
  return {
    /** 先审后发：新评论记 pending，改 status 为 approved 才公开 */
    moderate: flag(env.COMMENTS_MODERATE, false),
    /** Gravatar 开关：关掉后接口不再下发邮箱 MD5 */
    gravatar: flag(env.COMMENTS_GRAVATAR, true),
    /** 管理接口令牌，没配置就等于管理接口关闭 */
    adminToken: str(env.COMMENTS_ADMIN_TOKEN),
    /** 站点地址，日志和同步脚本用来显示 */
    site: (str(env.COMMENTS_SITE) || "https://weiqiang.org").replace(/\/+$/, ""),
    /** IP 哈希的盐，建议线上单独设一个 */
    salt: str(env.COMMENTS_SALT) || "weiqiang-comments",
  };
}

// 字段长度上限，前后端各校验一遍（前端只是体验，后端才算数）
export const LIMITS = {
  name: 40,
  email: 120,
  website: 200,
  contentMin: 2,
  contentMax: 3000,
  page: 300,
  body: 64 * 1024,
  listMax: 500,
};

export const EMAIL_RE = /^[^@\s<>"'`]+@[^@\s<>"'`]+\.[^@\s<>"'`]{2,}$/;
// 允许中文路径、百分号编码；不允许空白、反斜杠、? # 和引号，也不允许 ..
export const PAGE_RE = /^\/[^\s\\?#<>"']*$/;
export const PARENT_RE = /^[A-Za-z0-9_-]{4,40}$/;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// 清洗
// ---------------------------------------------------------------------------
// 控制字符（保留 \n \t）：和 Python 那份一致
const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** 收掉控制字符、统一换行、掐掉首尾空白。 */
export function clean(value, { multiline = false } = {}) {
  if (value === null || value === undefined) return "";
  let s = String(value).replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(CTRL_RE, "");
  if (!multiline) s = s.replace(/[\n\t]/g, " ").replace(/ {2,}/g, " ");
  return s.trim();
}

/** 按字符数截断 —— 一个中文字、一个 emoji 都算一个。 */
export function clip(s, n) {
  if (s.length <= n) return s;
  return Array.from(s).slice(0, n).join("");
}

/** 返回 { url, error }。空 URL 表示访客没填。 */
export function normWebsite(input) {
  const v = clean(input);
  if (!v) return { url: "", error: "" };
  if (v.length > LIMITS.website) return { url: "", error: "网址太长了。" };

  const withScheme = v.includes("://") ? v : "https://" + v;
  let u;
  try {
    u = new URL(withScheme);
  } catch {
    return { url: "", error: "网址看起来不太对，检查一下。" };
  }
  if (!["http:", "https:"].includes(u.protocol) || !u.hostname || !u.hostname.includes(".")) {
    return { url: "", error: "网址看起来不太对，检查一下。" };
  }
  return { url: u.toString(), error: "" };
}

export function nowIso() {
  // 统一 UTC。前端 new Date() 会自动转成访客的本地时区显示。
  return new Date().toISOString();
}

export function timeOf(iso) {
  const t = Date.parse(String(iso || ""));
  return Number.isFinite(t) ? t : Date.now();
}

function hex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
  return out;
}

export function makeId() {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  return "c" + Date.now().toString(36) + hex(buf);
}

// ---------------------------------------------------------------------------
// 摘要
// ---------------------------------------------------------------------------
/**
 * SHA-256，用于 IP 哈希。Web Crypto 只有异步版本。
 */
export async function sha256Hex(text) {
  const data = new TextEncoder().encode(String(text));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return hex(new Uint8Array(digest));
}

// Web Crypto 不提供 MD5（也不该提供），但 Gravatar 只认 MD5。
// 自己实现一份：评论量很小，正确性比速度重要。
const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const MD5_K = (() => {
  const k = new Int32Array(64);
  for (let i = 0; i < 64; i++) k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
  return k;
})();

export function md5(input) {
  const bytes = new TextEncoder().encode(String(input));
  const len = bytes.length;
  // 补到 56 mod 64，再加 8 字节长度
  const total = (((len + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[len] = 0x80;
  const view = new DataView(buf.buffer);
  const bits = len * 8;
  view.setUint32(total - 8, bits >>> 0, true);
  view.setUint32(total - 4, Math.floor(bits / 4294967296) >>> 0, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89 | 0;
  let c0 = 0x98badcfe | 0;
  let d0 = 0x10325476;

  const m = new Int32Array(16);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) m[i] = view.getInt32(off + i * 4, true);

    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + MD5_K[i] + m[g]) | 0;
      const s = MD5_S[(i >> 4) * 4 + (i % 4)];
      A = D;
      D = C;
      C = B;
      B = (B + ((F << s) | (F >>> (32 - s)))) | 0;
    }
    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }

  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setInt32(0, a0, true);
  ov.setInt32(4, b0, true);
  ov.setInt32(8, c0, true);
  ov.setInt32(12, d0, true);
  return hex(out);
}

export function avatarHash(email, cfg) {
  if (!cfg.gravatar || !email) return "";
  return md5(String(email).trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------
/**
 * 给浏览器的字段。邮箱、IP 一律不出门。
 *
 * avatar 不下发：头像映射是展示层配置，构建时由 Hugo 直接写进页面
 * （见 layouts/partials/comments/json.html 里的 cm-avatars），
 * 后端少读一个文件，改头像也不用重新部署函数。
 */
export function publicView(c, cfg) {
  return {
    id: String(c.id || ""),
    parent: String(c.parent || ""),
    name: String(c.name || ""),
    website: String(c.website || ""),
    content: String(c.content || ""),
    created: String(c.created || ""),
    avatar_hash: avatarHash(String(c.email || ""), cfg),
  };
}

// ---------------------------------------------------------------------------
// 校验（POST 那一侧）
// ---------------------------------------------------------------------------
export function validatePage(input) {
  const page = clean(input);
  if (!page || !PAGE_RE.test(page) || page.includes("..") || page.length > LIMITS.page) {
    throw new HttpError(400, "page 参数不对");
  }
  return page;
}

export function validateComment(payload) {
  const page = validatePage(payload.page);
  const name = clip(clean(payload.name), LIMITS.name);
  const email = clip(clean(payload.email), LIMITS.email);
  const content = clip(clean(payload.content, { multiline: true }), LIMITS.contentMax);
  const { url: website, error: siteError } = normWebsite(payload.website);

  if (!name) throw new HttpError(400, "昵称要填一下。");
  if (!email) throw new HttpError(400, "邮箱要填一下（不会公开）。");
  if (!EMAIL_RE.test(email)) throw new HttpError(400, "邮箱格式看着不对。");
  if (siteError) throw new HttpError(400, siteError);
  if (content.length < LIMITS.contentMin) throw new HttpError(400, "评论内容太短了。");

  return { page, name, email, content, website };
}
