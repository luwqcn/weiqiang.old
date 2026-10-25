# 评论系统 · Cloudflare Pages + D1

> **要从零部一遍？看仓库根目录的 [`DEPLOY.md`](../DEPLOY.md)** —— 那边是按顺序能照着敲的步骤，
> 这份文档讲的是设计取舍、额度、速度这些「为什么」。

全站跑在 Cloudflare 上：静态页和评论接口同一个域名，没有自己的服务器，也没有跨域。

```
浏览器 ──GET 页面──────> Cloudflare Pages（边缘节点，静态文件 + 构建时直出的评论）
   │
   └────GET/POST /api/comments──> Pages Functions ──> D1（SQLite）
                                        │
                              仓库里的 data/comments.json 是快照：
                              npm run comments:pull / push 双向同步，
                              构建时按它把评论直出进 HTML
```

## 为什么是这套

| 做法 | 目的 |
| --- | --- |
| 接口同源 | 不用配置 CORS，也不会因为跨域被浏览器拦掉 |
| 构建时直出评论 | 读者打开页面立刻看见评论，不用等 JS 再等接口 |
| 数据放 D1 而不是一个大 JSON | 发一条就是一条 INSERT，两个人同时发不会互相覆盖；文章多了也不会越读越慢 |
| 仓库保留 JSON 快照 | 能 grep、能手改、能跟着 git 回溯；换托管平台也不用重新导数据 |

**一个必须知道的限制**：Pages Functions 拿不到一个可写的文件系统，所以运行时
写不回仓库里的 `data/comments.json`。线上真数据在 D1，仓库里那份是快照。
想要「评论自动提交回仓库」，见文末的可选方案。

## 免费额度

2026 年 10 月的官方数字：

| 项目 | 免费额度 | 这套系统怎么用 |
| --- | --- | --- |
| Pages 静态请求 / 带宽 | 不限 | 文章、CSS、JS、图片都走这里 |
| Pages 构建 | 500 次/月（每次 20 分钟上限） | 每推一次 `main` 算一次 |
| Workers / Pages Functions 请求 | 100,000 次/天 | 一次评论加载 = 1 次请求 |
| Workers CPU | 10 ms/次 | 读评论约 1–3 ms：两条 SQL + 拼 JSON |
| D1 行读取 | 5,000,000 行/天 | 一页 8 条评论 ≈ 读十几行 |
| D1 行写入 | 100,000 行/天 | 一条评论 ≈ 写 3 行（表 + 两个索引） |
| D1 存储 | 5 GB | 一万条评论也就几 MB |

按每天 1000 次页面浏览、其中 2% 的人留言估算：

```
函数请求   1000 / 100000   → 1%
D1 读      ~20000 行/天    → 0.4%
D1 写      ~60 行/天       → 0.06%
```

也就是说，**正常写博客几十年也碰不到额度**。真正会先用完的是构建次数（500 次/月
≈ 每天 16 次），所以别在 `main` 上反复试错——推分支看预览，确认了再合并。

## 部署

前置：仓库在 GitHub（Cloudflare 要能拉到代码），装了 `wrangler` 并登录
（`npx wrangler login`）。

### 1. 建 D1 库

```bash
npx wrangler d1 create weiqiang-comments --location apac --update-config
```

`--location apac` 把主库放在亚太 —— 默认是美西，国内读者查评论要多跨一次太平洋。
`--update-config` 自动把 `database_id` 写回 `wrangler.toml`，跑完检查一眼 `binding`
还是不是 `DB`。

### 2. 建表

```bash
npx wrangler d1 execute weiqiang-comments --remote --file=cf/schema.sql
```

### 3. 建 Pages 项目

Dashboard → Workers & Pages → Create → Pages → Connect to Git，选这个仓库，然后：

| 项 | 值 |
| --- | --- |
| Build command | `npm run build` |
| Build output directory | `public` |
| 环境变量 `HUGO_VERSION` | `0.168.0` |
| 环境变量 `NODE_VERSION` | `20` |

`npm run build` 会先跑 `scripts/comments-prerender.mjs`（把快照直出成评论树），
再跑 `hugo`。构建命令和环境变量只在 Dashboard 配 —— Pages 的 wrangler 配置不读
`[build]` 段，写进 `wrangler.toml` 不会生效。

### 4. 绑定 D1

项目 → Settings → Functions → D1 database bindings：

- Variable name：`DB`
- D1 database：`weiqiang-comments`

`wrangler.toml` 里已经声明了，命令行部署会自动带；Dashboard 建的连接 Git 的项目
需要在界面上再点一次（两边一致即可）。

### 5. 设密钥

```bash
npx wrangler pages secret put COMMENTS_ADMIN_TOKEN --project-name weiqiang-org
npx wrangler pages secret put COMMENTS_SALT        --project-name weiqiang-org
```

- `COMMENTS_ADMIN_TOKEN`：管理接口的令牌，`openssl rand -hex 24` 生成。
  不设的话管理接口整个关闭（导数据、审核都用不了）。
- `COMMENTS_SALT`：IP 哈希的盐，随便一串长随机值。换了它，历史限流记录就失效，
  其他没影响。

可选：

| 变量 | 作用 |
| --- | --- |
| `COMMENTS_MODERATE=1` | 先审后发，新评论记 `pending` |
| `COMMENTS_GRAVATAR=0` | 不下发邮箱 MD5，头像只剩本地图和色块 |
| `COMMENTS_SITE=https://weiqiang.org` | 日志和同步脚本显示用 |

### 6. 绑域名

Custom domains 里加 `weiqiang.org`。域名在 Cloudflare 上的话，DNS 记录会自动建好；
在别家就把 DNS 指过去。**绑定后先关掉旧服务器上的站点**，免得两份内容打架。

### 7. 把旧评论导进去

```bash
COMMENTS_URL=https://weiqiang.org COMMENTS_ADMIN_TOKEN=xxx npm run comments:push
```

`data/comments.json` 有什么就导什么，按 id 去重，线上已有的不会被覆盖。

### 8. 验证

打开 `https://weiqiang.org/api/health`，应该看到：

```json
{ "ok": true, "backend": "d1", "admin": true, "stats": { "total": 8, "visible": 8, "pages": 1 } }
```

再去文章页发一条，刷新还在，就成了。

## 日常维护

```bash
# 线上评论 → 仓库快照（建议每次发版前跑，提交进 git）
COMMENTS_URL=https://weiqiang.org COMMENTS_ADMIN_TOKEN=xxx npm run comments:pull

# 仓库快照 → 线上（合并去重）
npm run comments:push

# 整份覆盖（危险：线上没被快照包含的会被删掉）
npm run comments:push -- --mode=replace
```

审核单条：

```bash
curl -X POST https://weiqiang.org/api/comments-admin \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"action":"status","id":"c2026...","status":"approved"}'
```

`status` 只能是 `approved`（公开）/ `pending`（待审）/ `spam`（垃圾）。
删一条根评论会连带删掉它下面整串回复。

## 本地开发

```bash
npm run build     # 先构建（含评论直出）
npm run dev       # http://127.0.0.1:8788/
```

本地用 Node 自带的 `node:sqlite` 顶替 D1，库文件在 `.preview/comments.db`，
跑的是和线上同一份 `cf/schema.sql`。第一次启动会把 `data/comments.json`
灌进去，预览一打开就有评论看。

想用预览数据而不动仓库快照：

```bash
COMMENTS_SNAPSHOT=.preview/comments.json npm run build
COMMENTS_SNAPSHOT=.preview/comments.json npm run dev
```

测试：

```bash
npm test        # 57 项：读写、校验、限流、回复、审核、导入、边界、并发
```

测试直接调 `functions/api/*.js` 里的 `onRequest`，和线上是同一份代码。

## 排错

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `/api/health` 返回 503 带 `hint` | 表还没建，或没绑 D1 | 跑第 2 步，检查绑定名是不是 `DB` |
| 页面有评论，但发不出去 | 函数没绑 D1 | 同上；浏览器控制台会看到 503 |
| 发出去刷新就没了 | 写进了预览环境的库 | Pages 的预览部署和正式环境是两套 D1 绑定，正常 |
| 评论列表停在「上次构建时的评论」 | 接口挂了 | 看 `/api/health`，或 Cloudflare 的 Functions 日志 |
| 部署后头像全变回色块 | `data/avatars.json` 没提交，或路径写成 `/avatars/x.png` | 站内图写相对路径 `avatars/x.png`，构建时会按 baseURL 补前缀 |
| 时间显示差一天 | 快照里是 `+08:00`，浏览器按本地时区渲染 | 数据本身没问题；列表排序用的是时间戳，不受影响 |

看实时日志：

```bash
npx wrangler pages deployment tail --project-name weiqiang-org
```

## 可选：让快照自动回到仓库

想要「`data/comments.json` 始终是最新的」又不想手动 pull，加一个 GitHub Actions：

```yaml
# .github/workflows/comments-sync.yml
name: comments-sync
on:
  schedule: [{ cron: "0 18 * * *" }]   # 每天凌晨 2 点（东八区）
  workflow_dispatch:
jobs:
  pull:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm run comments:pull
        env:
          COMMENTS_URL: https://weiqiang.org
          COMMENTS_ADMIN_TOKEN: ${{ secrets.COMMENTS_ADMIN_TOKEN }}
      - run: |
          git config user.name  "comments-bot"
          git config user.email "bot@users.noreply.github.com"
          git diff --quiet data/comments.json && exit 0
          git add data/comments.json
          git commit -m "chore: sync comments"
          git push
```

这样仓库里始终有一份最近一天的完整数据，同时 D1 仍是线上实时的那份。

## 速度这块做了什么

1. **评论直出**：构建时把快照渲染成 HTML，首屏不等 JS、不等接口。省掉两个来回，
   弱网下差别很明显。
2. **接口只做增量**：页面加载后 JS 拉一次，通常是「和静态那份一样」，替换不可见。
3. **查询走索引**：`(page, created_ts)` 覆盖了列表查询，一页几十条也只有十几行读。
4. **CSS 内联**：评论区样式直接写在页面里，没有额外的样式请求，也不会样式闪动。
5. **JS 单文件 + 指纹**：`defer` 加载，长缓存，改一次换一个 URL。
6. **静态资源走 Pages 边缘**：带宽和请求都不限量。

关于国内访问，说实话：**Cloudflare 免费版走的是海外节点**（香港、新加坡、日本、
美西），大陆访问延迟大概 60–250 ms，个别运营商时段会绕路。它比 Netlify 稳，
但比国内服务器慢，这是套餐决定的，代码层面解决不了。

能改善的几件事：

- 用 `weiqiang.org` 这种自定义域名，别长期用 `*.pages.dev`；
- 图片压到 WebP、控制在 200 KB 以内（边缘节点再快也救不了大图）；
- 上线后实测：`curl -o /dev/null -w '%{time_starttransfer}\n' https://weiqiang.org/`
  多测几次，看 TTFB 稳不稳。

如果读者绝大多数在国内、且对速度要求很高，那就得走备案域名 + 国内 CDN 回源，
或者干脆把静态站放国内对象存储，评论接口继续留在 Cloudflare（跨域，把
`endpoint` 写成完整 https 地址即可，前端代码不用改）。

## 目录

```
functions/api/comments.js         GET 读 / POST 发
functions/api/comments-admin.js   导出 / 导入 / 审核 / 删除（要令牌）
functions/api/health.js           探活
cf/lib/core.mjs                   清洗、校验、md5/sha256、配置
cf/lib/store.mjs                  D1 的全部 SQL
cf/lib/service.mjs                业务：限流、回复、审核
cf/lib/d1-sqlite.mjs              本地用 node:sqlite 顶替 D1（只在开发/测试里加载）
cf/schema.sql                     建表语句（线上本地共用这一份）
cf/dev-server.mjs                 本地静态 + 接口
cf/test/run.mjs                   57 项测试
scripts/comments-prerender.mjs    快照 → 构建期直出
scripts/comments-sync.mjs         线上 ↔ 仓库快照
wrangler.toml                     Pages + D1 绑定
```

旧方案（Python 自建服务、Netlify 版、Codeberg 覆盖配置）都挪到了
`_legacy/cloudflare-migration/`，不进仓库，需要查的时候还在。
