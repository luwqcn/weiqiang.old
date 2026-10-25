-- 评论库（Cloudflare D1 / SQLite）
--
-- 线上执行：
--   npx wrangler d1 execute weiqiang-comments --remote --file=cf/schema.sql
-- 本地由 cf/dev-server.mjs 和测试自动执行，不用手动跑。
--
-- 为什么用表而不是一个 JSON 大字段：
--   1. 发一条评论就是一条 INSERT，两个人同时按发送也不会互相覆盖；
--   2. 读取只碰当前页面，文章多了也不会越读越慢；
--   3. 排序、审核、删除都能交给 SQL，不用把整份数据搬进内存。

CREATE TABLE IF NOT EXISTS comments (
  id          TEXT PRIMARY KEY,
  page        TEXT    NOT NULL,
  parent      TEXT    NOT NULL DEFAULT '',
  name        TEXT    NOT NULL,
  email       TEXT    NOT NULL DEFAULT '',
  website     TEXT    NOT NULL DEFAULT '',
  content     TEXT    NOT NULL,
  created     TEXT    NOT NULL,
  -- created 是给人看的 ISO 字符串（有 Z 也有 +08:00，直接比大小会排错），
  -- 排序一律用这个毫秒时间戳。
  created_ts  INTEGER NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'approved',
  ip_hash     TEXT    NOT NULL DEFAULT ''
);

-- 页面 + 时间：列表查询走这条索引，不用扫全表
CREATE INDEX IF NOT EXISTS idx_comments_page ON comments (page, created_ts);
-- 删除根评论时按 parent 找回复
CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments (parent);

-- 限流：一条评论落一行，按窗口计数。比"读一个数组改完写回"少一次竞态。
CREATE TABLE IF NOT EXISTS rate_hits (
  ip_hash TEXT    NOT NULL,
  ts      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_hits ON rate_hits (ip_hash, ts);

-- 杂项：记录初始化时间之类
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
