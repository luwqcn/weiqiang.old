// GET /api/health —— 探活用，顺带报一下库里的规模。
//
// 部署完先打开这个地址：能看到 JSON 就说明函数和 D1 都活着。

import { makeConfig } from "../../cf/lib/core.mjs";
import { createStore } from "../../cf/lib/store.mjs";
import { health } from "../../cf/lib/service.mjs";

export async function onRequest(context) {
  const { env } = context;
  const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };

  if (!env || !env.DB) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "没有绑定 D1（env.DB）",
        hint: "wrangler.toml 里加 [[d1_databases]]，binding = \"DB\"；本地跑 npm run dev 会自动建库",
      }),
      { status: 503, headers },
    );
  }

  try {
    const data = await health(makeConfig(env), createStore(env.DB));
    return new Response(JSON.stringify(data), { status: 200, headers });
  } catch (err) {
    // 最常见的原因：表还没建。把命令写在回包里，省得翻文档。
    return new Response(
      JSON.stringify({
        ok: false,
        error: String((err && err.message) || err),
        hint: "表可能还没建：npx wrangler d1 execute weiqiang-comments --remote --file=cf/schema.sql",
      }),
      { status: 503, headers },
    );
  }
}
