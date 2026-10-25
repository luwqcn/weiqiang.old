// 存储层：Cloudflare D1（线上）与 node:sqlite（本地/测试）共用同一套 SQL。
//
// 上一版 Netlify 是用 Blobs 存「一页一个 JSON 大块」，写的时候读-改-写，
// 并发要靠 etag 重试。换成表之后这些都没了：发一条评论就是一条 INSERT，
// 两个人同时按发送也不会互相覆盖。
//
// 这里只依赖 D1 的四个方法：prepare / bind / all / first / run / batch，
// 本地适配器（cf/lib/d1-sqlite.mjs）实现了同样的形状，所以测试跑的就是
// 线上那套 SQL，不是 mock。

function rowToComment(r) {
  if (!r) return null;
  return {
    id: String(r.id || ""),
    page: String(r.page || ""),
    parent: String(r.parent || ""),
    name: String(r.name || ""),
    email: String(r.email || ""),
    website: String(r.website || ""),
    content: String(r.content || ""),
    created: String(r.created || ""),
    status: String(r.status || "approved"),
    ip_hash: String(r.ip_hash || ""),
  };
}

// 老数据里 status 可能缺字段，缺了就当已通过 —— 别让评论因为少个字段而消失
const VISIBLE = "(status = 'approved' OR status IS NULL OR status = '')";

const FIELDS = "id, page, parent, name, email, website, content, created, status, ip_hash";

function sortTs(c) {
  const t = Date.parse(String(c.created || ""));
  return Number.isFinite(t) ? t : Date.now();
}

export function createStore(db) {
  const stmt = (sql) => db.prepare(sql);

  return {
    kind: db.kind || "d1",

    // -----------------------------------------------------------------------
    // 读
    // -----------------------------------------------------------------------
    async listPage(page, limit) {
      const cap = Math.max(1, Math.min(Number(limit) || 200, 500));

      const totalRow = await stmt(
        `SELECT COUNT(*) AS n FROM comments WHERE page = ? AND ${VISIBLE}`,
      ).bind(page).first();

      // 取最近 cap 条，再按时间正序返回 —— 和之前「slice(-cap)」的语义一致
      const res = await stmt(
        `SELECT ${FIELDS} FROM (
           SELECT ${FIELDS}, created_ts FROM comments
           WHERE page = ? AND ${VISIBLE}
           ORDER BY created_ts DESC
           LIMIT ?
         ) ORDER BY created_ts ASC`,
      ).bind(page, cap).all();

      return {
        comments: (res.results || []).map(rowToComment),
        total: Number((totalRow && totalRow.n) || 0),
      };
    },

    async getById(id) {
      const r = await stmt(`SELECT ${FIELDS} FROM comments WHERE id = ?`).bind(id).first();
      return rowToComment(r);
    },

    async pageOf(id) {
      const r = await stmt("SELECT page FROM comments WHERE id = ?").bind(id).first();
      return r ? String(r.page) : "";
    },

    async listAll() {
      const res = await stmt(`SELECT ${FIELDS} FROM comments ORDER BY created_ts ASC`).all();
      return (res.results || []).map(rowToComment);
    },

    async stats() {
      const r = await stmt(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN ${VISIBLE} THEN 1 ELSE 0 END) AS visible,
                COUNT(DISTINCT page) AS pages
         FROM comments`,
      ).first();
      return {
        total: Number((r && r.total) || 0),
        visible: Number((r && r.visible) || 0),
        pages: Number((r && r.pages) || 0),
      };
    },

    // -----------------------------------------------------------------------
    // 写
    // -----------------------------------------------------------------------
    async insert(c) {
      await stmt(
        `INSERT INTO comments (id, page, parent, name, email, website, content, created, created_ts, status, ip_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        c.id, c.page, c.parent || "", c.name, c.email || "", c.website || "",
        c.content, c.created, sortTs(c), c.status || "approved", c.ip_hash || "",
      ).run();
      return c;
    },

    async updateStatus(id, status) {
      const res = await stmt("UPDATE comments SET status = ? WHERE id = ?").bind(status, id).run();
      return Number((res.meta && res.meta.changes) || 0) > 0;
    },

    /**
     * 删一条，连同它下面整串回复。
     * 递归 CTE 一次搞定，不用在 JS 里反复扫数组。
     */
    async deleteCascade(id) {
      // 先数一下会带走多少条，方便回话
      const counted = await stmt(
        `WITH RECURSIVE doomed(id) AS (
           SELECT id FROM comments WHERE id = ?
           UNION ALL
           SELECT c.id FROM comments c JOIN doomed d ON c.parent = d.id
         )
         SELECT COUNT(*) AS n FROM doomed`,
      ).bind(id).first();

      await stmt(
        `WITH RECURSIVE doomed(id) AS (
           SELECT id FROM comments WHERE id = ?
           UNION ALL
           SELECT c.id FROM comments c JOIN doomed d ON c.parent = d.id
         )
         DELETE FROM comments WHERE id IN (SELECT id FROM doomed)`,
      ).bind(id).run();

      return Number((counted && counted.n) || 0);
    },

    async deletePage(page) {
      const res = await stmt("DELETE FROM comments WHERE page = ?").bind(page).run();
      return Number((res.meta && res.meta.changes) || 0);
    },

    async clearAll() {
      await stmt("DELETE FROM comments").run();
    },

    /**
     * 批量写入。replace 先清空；merge 靠主键去重（已有的不覆盖）。
     * 用 batch 一次提交，几百条也不会把请求 CPU 拖爆。
     */
    async insertMany(rows, mode = "merge") {
      let added = 0;
      let skipped = 0;

      if (mode === "replace") await this.clearAll();

      const verb = mode === "replace" ? "INSERT OR REPLACE" : "INSERT OR IGNORE";
      const CHUNK = 40; // 一次 batch 别塞太多语句
      for (let i = 0; i < rows.length; i += CHUNK) {
        const slice = rows.slice(i, i + CHUNK);
        const stmts = slice.map((c) =>
          stmt(
            `${verb} INTO comments (id, page, parent, name, email, website, content, created, created_ts, status, ip_hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            c.id, c.page, c.parent || "", c.name || "", c.email || "", c.website || "",
            c.content || "", c.created || new Date().toISOString(), sortTs(c),
            c.status || "approved", c.ip_hash || "",
          ),
        );
        const results = await db.batch(stmts);
        for (const r of results || []) {
          const changes = Number((r && r.meta && r.meta.changes) || 0);
          if (changes > 0) added++;
          else skipped++;
        }
      }
      return { added, skipped };
    },

    // -----------------------------------------------------------------------
    // 限流
    // -----------------------------------------------------------------------
    async recentHits(ipHash, sinceMs) {
      const res = await stmt(
        "SELECT ts FROM rate_hits WHERE ip_hash = ? AND ts > ? ORDER BY ts ASC",
      ).bind(ipHash, sinceMs).all();
      return (res.results || []).map((r) => Number(r.ts));
    },

    async addHit(ipHash, ts) {
      await stmt("INSERT INTO rate_hits (ip_hash, ts) VALUES (?, ?)").bind(ipHash, ts).run();
    },

    /** 清理一天前的记录。低频执行，别每次都扫。 */
    async pruneHits(beforeMs) {
      await stmt("DELETE FROM rate_hits WHERE ts <= ?").bind(beforeMs).run();
    },
  };
}
