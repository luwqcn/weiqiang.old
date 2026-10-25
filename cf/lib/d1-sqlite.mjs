// 本地版 D1：用 Node 自带的 node:sqlite 顶替 Cloudflare 的 D1 绑定。
//
// 为什么值得这么干：D1 本身就是 SQLite，本地换成同一个引擎之后，
// 跑测试用的就是线上那套 SQL（包括索引、递归 CTE、INSERT OR IGNORE），
// 而不是另写一份「假装是数据库」的内存实现。
//
// 只在 Node 下被动态 import（cf/dev-server.mjs、cf/test/run.mjs），
// 不会进 Workers 的包里。

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/** node:sqlite 返回 null 原型对象，转成普通对象顺手点。 */
function plain(row) {
  return row === undefined || row === null ? null : { ...row };
}

class LocalStatement {
  constructor(stmt) {
    this.stmt = stmt;
    this.args = [];
  }

  bind(...args) {
    this.args = args;
    return this;
  }

  async all() {
    return { success: true, results: this.stmt.all(...this.args).map(plain) };
  }

  async first(column) {
    const row = plain(this.stmt.get(...this.args));
    if (!row) return null;
    return column ? row[column] : row;
  }

  async run() {
    const r = this.stmt.run(...this.args);
    return {
      success: true,
      meta: {
        changes: Number(r.changes || 0),
        last_row_id: Number(r.lastInsertRowid || 0),
      },
    };
  }
}

/**
 * 打开一个本地数据库。
 * @param {string} path 文件路径，":memory:" 表示内存库
 */
export function openLocalD1(path = ":memory:") {
  const db = new DatabaseSync(path);

  const api = {
    kind: "sqlite",
    path,

    prepare(sql) {
      return new LocalStatement(db.prepare(sql));
    },

    /** D1 的 batch：一组语句一次提交，返回每条的结果。 */
    async batch(stmts) {
      const out = [];
      db.exec("BEGIN");
      try {
        for (const s of stmts) out.push(await s.run());
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return out;
    },

    exec(sql) {
      db.exec(sql);
      return { success: true };
    },

    close() {
      db.close();
    },
  };

  return api;
}

/** 建表。schema.sql 是唯一的来源，线上和本地跑的是同一份。 */
export function applySchema(db, schemaPath) {
  db.exec(readFileSync(schemaPath, "utf8"));
}
