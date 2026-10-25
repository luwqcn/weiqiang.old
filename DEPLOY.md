# 部署手册 · 从零上线到 Cloudflare Pages

这份是从「什么都没有」到「评论能发能看」的完整步骤。每一步都写清楚：敲什么命令、看到什么算成功、失败了看哪一条。

背景和设计取舍见 `cf/README.md`，这里只讲怎么装。

---

## 0. 先认清这套东西的四个部分

```
                         ┌──────────────────────────────┐
   读者浏览器  ──GET──→  │  Cloudflare Pages  静态站     │  public/
                         │  构建时已把评论直出进 HTML     │
                         └──────────────────────────────┘
                                    │
                         ┌──────────▼───────────────────┐
            发评论  ───→  │  Pages Functions             │  functions/api/*.js
            拉新评论 ──→  │  /api/comments               │
                         └──────────┬───────────────────┘
                                    │  SQL
                         ┌──────────▼───────────────────┐
                         │  D1（SQLite）   线上唯一真数据 │  cf/schema.sql
                         └──────────────────────────────┘

    仓库里的 data/comments.json 只是「快照」，给构建时直出用，靠 sync 脚本双向同步
```

记住三条，后面不会乱：

1. **线上真数据在 D1**，不在仓库里。
2. **仓库快照只影响首屏直出**，就算它是旧的，JS 起来后也会拉最新的补上。
3. **评论接口和页面同域**，所以前端 `endpoint = "/api/comments"` 是个相对路径，没有 CORS 这回事。

---

## 1. 动手前的清单

| 项目 | 要求 | 现在的情况 |
| --- | --- | --- |
| Cloudflare 账号 | 免费版即可 | 需要注册 |
| GitHub 仓库 | Pages 的 Git 集成只认 GitHub / GitLab | `git@github.com:wejanz/weiqiang.org.git`（旧名 `shujiaccn/weborg` 已重定向） |
| 域名 | 可选；用 `*.pages.dev` 也能跑 | `weiqiang.org` |
| Node | 本地跑 wrangler 要 **≥ 22**；Cloudflare 构建机设 20 就够 | 系统是 v26（跑不动 wrangler），另备 v22 |
| Hugo | 0.168.0（主题不用 SCSS，标准版就够） | 本地已是 0.168.0 |
| 一个随机令牌 | 管理接口用，自己生成 | `openssl rand -hex 24` |

本地装 wrangler：

```bash
wrangler --version
```

这台机器已经装了（`/usr/sbin/wrangler`，4.149.0）。**但系统自带的 Node 26 一跑就崩**，报：

```
Fatal process out of memory: Failed to reserve virtual memory for CodeRange
```

不是装坏了，是 `ulimit -v` 被限在 4GB，V8 预留不下地址空间。这个限制提不上去（硬限制），只能换 Node 版本绕：

```bash
# 一次性：下 Node 22 到 /tmp（约 27MB）
curl -fsSL -o /tmp/node22.tar.xz https://nodejs.org/dist/v22.23.4/node-v22.23.4-linux-x64.tar.xz
tar -xf /tmp/node22.tar.xz -C /tmp

# 每次开新终端都要跑这两行
export PATH=/tmp/node-v22.23.4-linux-x64/bin:$PATH
export NODE_OPTIONS="--disable-wasm-trap-handler"

wrangler --version   # 应输出 4.149.0
```

`/tmp` 重启会被清掉，重新解压一遍就行。

> 还有一条走不通的：`wrangler d1 execute --local` 和 `wrangler pages dev` 要起 `workerd`，它撞的是同一堵墙（`Received signal #6: Aborted`）。所以本地调试一律用 `npm run dev`（node:sqlite 版），行为一致。**`pages functions build`、`d1 ... --remote`、`pages deploy`、`secret put` 这些不启动 workerd 的命令都正常。**

---

## 2. 本地先跑通，别直接上云

上云之后排查问题要看 Cloudflare 日志，很慢。先在本地把三件事验证掉。

```bash
cd ~/Projects/weiqiang.org

npm test          # 57 项，全绿才继续
npm run build     # 评论直出 + hugo 构建
npm run dev       # http://127.0.0.1:8788/
```

**期望看到**

- `npm test` 最后一行：`57 项通过，0 项失败`
- `npm run build` 里有 `Total in xxxx ms`，没有 `ERROR`
- `npm run dev` 后浏览器打开文章页，评论区能显示、能发、刷新还在

本地用的是 `node:sqlite` 顶替 D1，跑的是同一份 `cf/schema.sql`，所以本地通 = 线上大概率通。

> 本地库文件在 `.preview/comments.db`，**空库第一次启动会把 `data/comments.json` 灌进去**。想重置就删掉这个文件。
>
> 仓库快照现在是空的（0 条），所以默认本地打开评论区是「还没有评论」。想拿之前那 17 条演示数据看效果：
>
> ```bash
> COMMENTS_SNAPSHOT=.preview/comments.json npm run dev
> ```

再补一条**不需要登录**的离线自检，把 `functions/` 按线上规则编译一遍：

```bash
npx wrangler pages functions build --outdir=/tmp/fnbuild
```

期望最后一行 `✨ Compiled Worker successfully`。这一步能提前抓出函数里的语法错、错误的 import、用了线上不支持的内置模块 —— 等推到 Cloudflare 再发现就要浪费一次构建额度。

---

## 3. 建 D1 数据库

```bash
npx wrangler login
```

浏览器会弹授权页，点 Allow。

```bash
npx wrangler d1 create weiqiang-comments --location apac --update-config
```

两个参数都值钱，别省：

| 参数 | 为什么 |
| --- | --- |
| `--location apac` | 主库放亚太。默认是 `wnam`（美西），国内读者每查一次评论要多跨一次太平洋。可选值：`apac` / `weur` / `eeur` / `enam` / `wnam` / `oc` |
| `--update-config` | 想把 `database_id` 自动写回 `wrangler.toml` 就加。**实测不靠谱**：它只把建议片段打印出来，文件没动 —— 还是得手动填 |

跑完**打开 `wrangler.toml` 看一眼** `[[d1_databases]]`：`binding` 必须还是 `DB`，`database_id` 换成真 id。注意 wrangler 输出里建议的 binding 是从库名推导的 `weiqiang_comments`（下划线），**跟代码里的 `env.DB` 对不上，别照抄**。

不用 `--update-config` 的话，输出里会给你这段，手动替换掉占位的那串 0：

```toml
[[d1_databases]]
  binding = "DB"
  database_name = "weiqiang-comments"
  database_id = "a1b2c3d4-5678-90ab-cdef-1234567890ab"   # ← 换成你的
```

id 不改的话，后面所有命令都会报 `database not found`。

### 建表

```bash
npx wrangler d1 execute weiqiang-comments --remote --file=cf/schema.sql
```

**验证**

```bash
npx wrangler d1 execute weiqiang-comments --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table';"
```

应该看到 `comments`、`rate_hits`、`meta` 三张表。少一张就是语句没跑完，重跑上面那条 `--file` 命令（建表语句是 `IF NOT EXISTS`，重复跑没事）。

---

## 4. 把代码推到 GitHub

Cloudflare 要从 GitHub 拉代码。**这一步最容易漏东西**：构建时要读 `data/`，漏了就变成「页面没评论」。

先看一眼要提交什么：

```bash
git status --short
```

**必须进仓库的**

```
cf/                          接口、schema、本地服务、测试
functions/api/               三个接口入口
scripts/comments-prerender.mjs   构建时直出（构建机要跑）
scripts/comments-sync.mjs        同步脚本
wrangler.toml                Pages + D1 绑定
package.json                 构建命令
hugo.toml                    评论 provider = json
layouts/partials/comments/   评论模板与静态渲染
assets/js/ assets/css/       前端
static/_headers              Cache-Control 规则
static/_routes.json          只让 /api/* 走函数
static/avatars/              站内头像
data/comments.json           ★ 快照，构建时直出用
data/avatars.json            ★ 头像映射
data/lastmod.json            ★ 页脚「本页最近更新」的数据源（9 条真修改记录）
scripts/gen-lastmod.py       ★ 生成上面那份表，本地发版前跑
```

> **`data/lastmod.json` 为什么必须进仓库：** Cloudflare Pages 构建时是 `depth=1` 的浅克隆，
> 拿不到 git 历史，脚本在它上面跑不出任何东西。所以这份表必须在**本地**生成后提交。
> 脚本里已经加了浅克隆保护——检测到历史不全就直接退出，不会用空表覆盖仓库里那份。
> `npm run build` 的 `prebuild` 会顺手跑一次，Pages 上失败了也不影响构建。

**不要进仓库的**

```
data/commenttrees.json       构建产物，每次 build 重新生成
.preview/                    本地库和预览数据
_legacy/                     归档的旧方案
public/                      构建产物
node_modules/
```

`.gitignore` 里已经配好了，正常 `git add -A` 不会误收。

**老脚本已经清理完了。** 迁移时删掉了这 8 个（全部由 Node 构建流程取代）：

```
scripts/artalk-migrate.py    scripts/build.sh          scripts/gen-slugs.py
scripts/normalize-tags.py    scripts/optimize-assets.py scripts/org-migrate.py
scripts/org-to-md.py         scripts/serve.sh
```

**`scripts/gen-lastmod.py` 不在删除之列** —— 它是活的，页脚「本页最近更新」靠它生成
`data/lastmod.json`。`scripts/*` 被 gitignore 忽略，所以 `.gitignore` 里给它留了白名单：

```
!scripts/gen-lastmod.py
```

以后发版前手动跑一次，或直接 `npm run build`（`prebuild` 会自动跑）：

```bash
npm run lastmod        # → data/lastmod.json
```

> **⚠️ 别让 ox-hugo / 导出脚本把 `lastmod` 写回 front matter。** 2026-10-11 那次全站
> `.org → .md` 转换，把 397 篇文章的 `lastmod` 全写成了 `2026-10-11T18:06~18:07`——
> 两分钟内几百个文件，是文件 mtime 被批量重置的结果，不是真改过。front matter 里的
> `lastmod` **优先级高于** `data/lastmod.json`，所以那 397 篇的页脚全卡在 2026-10-11。
> 这批假值已经清掉（页脚改回各篇真实发布日期），保留 5 条真手改的。重新导出时如果
> 发现页脚日期又变成同一天，先查 front matter：

```bash
grep -rhE "^lastmod *[:=]" content --include="*.md" | sort | uniq -c | sort -rn | head
```

再提交：

```bash
git add -A
git commit -m "feat: 评论系统迁到 Cloudflare Pages + D1"
git push github main
```

> 你的 `origin` 指向 Codeberg，`github` 是另一个 remote。Cloudflare 只认 GitHub/GitLab，所以推 `github`。想两边都留一份就 `git push origin main && git push github main`。

---

## 5. 建 Pages 项目

**先记住一条，能省掉一次拆了重建**：Pages 项目分两种类型 —— Direct Upload（`wrangler pages project create` 建的）和 Git 集成（Dashboard 建的）。官方明确写了：

> You cannot switch to Git integration later. If you choose Direct Upload, you cannot switch to Git integration later. You will have to create a new project with Git integration.

也就是说**先跑了 CLI 那条路，以后就再也连不上 Git**，只能删项目重建。想自动部署就别碰 `project create`，直接从 Dashboard 走。

### 路线 A：连 Git 自动构建（推荐，本机唯一可行）

Dashboard → **Workers & Pages** → **Create application** → **Pages** → **Connect to Git**

第一次用会让你授权 GitHub，选「只授权这一个仓库」就行，别给全账号权限。

依次填：

| 项 | 值 | 说明 |
| --- | --- | --- |
| 选仓库 | `wejanz/weiqiang.org` | 就是刚推的那个（旧名 `shujiaccn/weborg` 已重定向过来） |
| Project name | `weiqiang-org` | ★ 必须和 `wrangler.toml` 的 `name` 一致，否则 `wrangler pages ... --project-name` 找不到项目 |
| Production branch | `main` | |
| Framework preset | `None` | 别选 Hugo，它自带的命令不合我们的需要 |
| Build command | `npm run build` | 先直出评论再跑 hugo |
| Build output directory | `public` | |
| Root directory | 留空 | 仓库根就是站点根 |

**环境变量**（Advanced → Environment variables，Production 和 Preview 都加上）：

| 变量 | 值 |
| --- | --- |
| `HUGO_VERSION` | `0.168.0` |
| `NODE_VERSION` | `20` |
| `TZ` | `Asia/Shanghai` |

`TZ` 不是可有可无：构建时生成评论日期用的是构建机时区，不设的话东八区的评论会显示成前一天。

点 **Save and Deploy**，等第一次构建。日志里应该能看到：

```
评论预渲染：N 个页面 / M 条评论 → data/commenttrees.json
Total in 3xxx ms
Success: Your site was deployed!
```

### 路线 B：本地构建 + 命令行直传（这台机器跑不通）

```bash
npm run build
npx wrangler pages project create weiqiang-org --production-branch main
npx wrangler pages deploy public --project-name weiqiang-org
```

`wrangler.toml` 里的 `[[d1_databases]]` 会被自动带上（`pages_build_output_dir = "public"` 也是给这条命令用的）。**但构建命令不会** —— Cloudflare 的 Pages 配置只认 `name` / `pages_build_output_dir` / `compatibility_date` / 各类绑定，`[build]` 段 Pages 根本不读，写进去也是白写。

⚠️ **两个实测结论，别在这上面浪费时间**：

1. **建了 Direct Upload 项目就再也连不了 Git**。删项目重建是唯一出路，D1 库和密钥不跟着项目走（密钥要重设）。
2. 本站构建产物 841 个文件 / 48MB，在这台机器（`ulimit -v` 4GB）上传到 `Uploading... (0/839)` 就会 `terminate called after throwing an instance of 'std::bad_alloc'`。只有 1 个文件的目录能传成功 —— 说明卡在文件数量和体积，不是配置错。
   机器地址空间正常的话这条路线没问题，也可以用来做「只传一个小页面验证接口」的临时部署。

以后每次发版就是三步（`npm run build` → `deploy`）。CLI 直传不占 Cloudflare 的 500 次/月构建额度，但每次都要本地等一遍 Hugo。

---

## 6. 绑定 D1

路线 B 用 `wrangler.toml` 会自动带；**路线 A 必须在界面上点一次**，配置文件管不到 Dashboard 建的项目。

Dashboard → 你的项目 → **Settings** → **Bindings**（旧界面叫 Functions → D1 database bindings）→ **Add** → **D1 database**

| 项 | 值 |
| --- | --- |
| Variable name | `DB` ★ 必须叫这个，代码里就是 `env.DB` |
| D1 database | `weiqiang-comments` |

**Production 和 Preview 两栏都要加一遍**。只加 Production 的话，推分支生成的预览部署会 503 —— 预览站也是拿 `functions/api/*.js` 跑的，一样要 `env.DB`。

保存后**需要重新部署一次**才生效：Deployments → 最新那条 → ⋯ → **Retry deployment**。

---

## 7. 设密钥和环境变量

```bash
# 管理接口令牌：先自己生成一串
openssl rand -hex 24

# 把它设进去（会提示粘贴）
npx wrangler pages secret put COMMENTS_ADMIN_TOKEN --project-name weiqiang-org

# IP 哈希的盐，随便一串长随机值
npx wrangler pages secret put COMMENTS_SALT --project-name weiqiang-org
```

| 变量 | 不给会怎样 |
| --- | --- |
| `COMMENTS_ADMIN_TOKEN` | 管理接口整个关闭：导数据、审核、删除、pull 全用不了 |
| `COMMENTS_SALT` | 用默认盐算 IP 哈希，限流照样能用，但换了盐历史记录失效 |

**★ 这步有个坑**：`secret put` 之后已有的部署不会自动读到新值，必须再触发一次部署（Retry deployment 或 push 一个空提交）。忘了这步，`/api/health` 会一直显示 `"admin": false`。

可选变量（Settings → Environment variables）：

| 变量 | 作用 |
| --- | --- |
| `COMMENTS_MODERATE=1` | 先审后发，新评论记 `pending`，前台看不见 |
| `COMMENTS_GRAVATAR=0` | 不下发邮箱 MD5，头像只剩站内图和色块 |
| `COMMENTS_SITE=https://weiqiang.org` | 日志和同步脚本显示用 |

---

## 8. 绑域名

Dashboard → 项目 → **Custom domains** → **Set up a domain** → 填 `weiqiang.org`

- 域名已经托管在 Cloudflare：DNS 记录自动建好，等状态变成 **Active**（通常一两分钟）。
- 域名在别家：按提示去原注册商加 CNAME。

**绑完立刻做一件事：把老站关掉**。Codeberg Pages 或旧服务器如果还在对外服务，会出现「有时候是新站、有时候是老站」，加上 DNS 缓存，排查起来非常费劲。

`hugo.toml` 里 `baseURL = "https://weiqiang.org/"` 已经对上了，不用改。

---

## 9. 上线验收（照着打勾）

```bash
# 1. 探活
curl https://weiqiang.org/api/health
```

期望（`stats` 的数字按你的实际数据）：

```json
{ "ok": true, "backend": "d1", "moderate": false, "gravatar": true,
  "admin": true, "stats": { "total": 0, "visible": 0, "pages": 0 },
  "time": "2026-10-25T13:42:48.357Z" }
```

逐条确认：

- [ ] `ok` 是 `true` —— 否则看下面的排错表
- [ ] `backend` 是 `d1` —— 本地开发时会看到 `sqlite`，线上必须是 `d1`
- [ ] `admin` 是 `true` —— 是 `false` 就是第 7 步的密钥没生效，重部署一次
- [ ] 打开任意文章页，评论区正常显示（哪怕显示「还没有评论」）
- [ ] 发一条测试评论 → 立刻出现在列表里 → 刷新还在
- [ ] 再发一条带回复的，缩进正常
- [ ] 换个浏览器（无痕窗口）能看到刚才两条 —— 证明写进了 D1，不是只在本地内存
- [ ] 手机用 4G 打开一次，感受一下真实速度

命令行确认数据真的落库了：

```bash
npx wrangler d1 execute weiqiang-comments --remote \
  --command "SELECT id, page, name, status, created FROM comments ORDER BY created_ts DESC LIMIT 5;"
```

---

## 10. 把旧评论导进来

如果之前有评论（旧 JSON、Artalk 导出等），先整理成 `data/comments.json` 的格式：

```json
{
  "version": 1,
  "updated": "2026-10-25T12:00:00+08:00",
  "comments": [
    {
      "id": "c20261025abc123",
      "page": "/zh/2026/fdrz-260324/",
      "parent": "",
      "name": "某某",
      "email": "",
      "website": "",
      "content": "评论正文",
      "created": "2026-10-25T12:00:00+08:00"
    }
  ]
}
```

`page` 用站内路径（以 `/` 开头和结尾），和前端提交时用的 `location.pathname` 一致，否则导进去也匹配不上页面。

> **想先把本地预览的那 17 条测试数据搬上线**，直接拿它当快照推上去，再把线上那份拉回来当新快照：
>
> ```bash
> cp .preview/comments.json data/comments.json
> COMMENTS_URL=https://weiqiang.org COMMENTS_ADMIN_TOKEN=xxx npm run comments:push
> COMMENTS_URL=https://weiqiang.org COMMENTS_ADMIN_TOKEN=xxx npm run comments:pull
> ```
>
> `push` 是 merge，线上已有的不会被动；`pull` 回来的是线上真实那份（含 id 和之后新增的），提交进 git 就是最新快照。

整理好之后导入线上：

```bash
COMMENTS_URL=https://weiqiang.org \
COMMENTS_ADMIN_TOKEN=你设的那串 \
npm run comments:push
```

默认是 **merge**：按 `id` 去重，线上已有的跳过，不会覆盖。输出形如 `推送完成（merge）：8 个页面，新增 8 条`。

真要整份覆盖（**会删掉线上不在快照里的评论**）：

```bash
COMMENTS_URL=https://weiqiang.org COMMENTS_ADMIN_TOKEN=你设的那串 npm run comments:push:replace
```

它有 5 秒倒计时，来得及 Ctrl-C。

---

## 11. 日常怎么用

### 发新文章

```bash
# 想让文章首屏就带上最新评论，先拉一次快照
COMMENTS_URL=https://weiqiang.org COMMENTS_ADMIN_TOKEN=xxx npm run comments:pull
git add data/comments.json && git commit -m "chore: sync comments"
git push github main
```

不拉也能发，只是新评论要等读者浏览器的 JS 起来才补上，首屏少几条而已。建议**每次发版前拉一次**，顺手就提交了。

### 审核 / 删除

```bash
TOKEN=你设的那串

# 通过
curl -X POST https://weiqiang.org/api/comments-admin \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"action":"status","id":"c2026...","status":"approved"}'

# 标记垃圾
... -d '{"action":"status","id":"c2026...","status":"spam"}'

# 删除（删根评论会连带删掉它下面整串回复）
... -d '{"action":"delete","id":"c2026..."}'
```

`status` 只有 `approved` / `pending` / `spam` 三种。

### 看实时日志

```bash
npx wrangler pages deployment tail --project-name weiqiang-org
```

发一条评论，看有没有 5xx、`hint` 里写了什么。

---

## 12. 出问题怎么退

### 代码退回去

Dashboard → Deployments → 找上一个正常的那条 → ⋯ → **Rollback to this deployment**。静态文件立刻回到那一版，不用等构建。

命令行也行：

```bash
git revert <坏的那次 commit>
git push github main
```

### 数据退回去

**最可靠的是你自己**：`npm run comments:pull` 出来的 `data/comments.json` 提交进 git，每次提交就是一个备份点，任何时候都能 `git show <commit>:data/comments.json` 取回。

另外 D1 控制台有 **Time Travel**（D1 → 选库 → Backups），能回到某个时间点，保留窗口以控制台显示为准。恢复前先 `pull` 一份当前数据，别把「想救的」和「想丢的」一起盖掉。

### 整个项目不要了

```bash
npx wrangler pages project delete weiqiang-org
npx wrangler d1 delete weiqiang-comments
```

删之前务必先 `npm run comments:pull`，D1 一删评论就没了。

---

## 13. 排错表

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `Wrangler requires at least Node.js v22` | 本地 Node 太旧 | 换 Node 22 LTS 以上；Cloudflare 构建机的 `NODE_VERSION=20` 不受影响（那边只跑 hugo） |
| `Fatal process out of memory: Failed to reserve virtual memory` | 机器地址空间被限死（`ulimit -v` 小） | `export NODE_OPTIONS="--disable-wasm-trap-handler"`，仍不行就换 Node 22 |
| `Cannot allocate Wasm memory for new instance` | 同上，WASM 申请不到地址 | 同上 |
| `workerd` 报 `Received signal #6: Aborted` | 同上，跑本地 D1/`pages dev` 时遇到 | 绕不过去就用 `npm run dev`（node:sqlite 版，行为一致） |
| `Uploading... (0/839)` 之后 `std::bad_alloc` | 产物太大（841 文件 / 48MB）+ 地址空间不足 | 改走 Git 集成；或压图（源图里有多张 1MB 以上） |
| `git push` 提示 repository moved | 仓库改名或转移了 | `git remote set-url github <新地址>` |
| 项目建好了却找不到「连 Git」的入口 | Direct Upload 类型不能转 Git | 删项目，从 Dashboard 的 Connect to Git 重建 |
| `/api/health` 返回 503，带 `hint` | 表没建，或没绑 D1 | 回第 3 步建表；检查绑定名是不是 `DB` |
| `admin: false` | 令牌没设，或设了没重新部署 | 第 7 步，然后 Retry deployment |
| 页面能看，发评论 500 | 函数没拿到 `env.DB` | Settings → Bindings 确认 `DB` → 重新部署 |
| 构建日志 `hugo: command not found` | 构建镜像没装 Hugo | 加环境变量 `HUGO_VERSION=0.168.0` |
| 构建日志说版本不存在 / 安装失败 | 指定的 Hugo 版本镜像拉不到 | 换成镜像里有的版本；实在不行去掉 `HUGO_VERSION` 用默认版本 |
| 部署报 `database_id ... not found` | `wrangler.toml` 还是占位符 | 第 3 步，换成真 id |
| `wrangler pages ...` 说找不到项目 | 项目名和 `wrangler.toml` 的 `name` 不一致 | 统一成 `weiqiang-org` |
| 首屏没评论，转圈一下才出来 | 快照是空的 / 没提交 `data/comments.json` | 第 11 步 pull 一次并提交 |
| 评论在预览站发得出去，正式站看不到 | 预览部署和生产连的是同一个库，也可能各连各的 | 看绑定时两栏填的是不是同一个 `weiqiang-comments`；别在预览站发测试数据 |
| 预览部署（PR 分支）一打开就 503 | Preview 环境没绑 D1 | 第 6 步，Preview 栏也加一遍 `DB` |
| 头像全变回色块 | `data/avatars.json` 没提交，或路径写了 `/avatars/x.png` | 站内图标相对路径 `avatars/x.png`，构建时按 baseURL 补前缀 |
| 时间差一天 | 快照里是 `+08:00`，浏览器按本地时区渲染 | 数据没问题，排序用时间戳不受影响；检查构建机 `TZ` |
| 改了代码但线上没变 | 推到了 Codeberg（origin），没推 GitHub | `git push github main` |
| 改 `wrangler.toml` 的构建命令没反应 | Pages 不读 `[build]` 段 | 构建命令只能在 Dashboard 配 |
| 构建次数用完了 | 免费 500 次/月 | 等下月，或改用路线 B 本地 `wrangler pages deploy` 不占构建额度 |

---

## 14. 额度与成本

免费版就够，正常写博客几十年碰不到线：

| 项目 | 免费额度 | 一页 8 条评论大概用掉 |
| --- | --- | --- |
| Pages 静态请求 / 带宽 | 不限 | — |
| Pages 构建 | 500 次/月 | 一次 push 算一次 |
| Functions 请求 | 100,000 次/天 | 1 次（页面加载后拉一次） |
| Functions CPU | 10 ms/次 | 1–3 ms |
| D1 读 | 5,000,000 行/天 | 十几行 |
| D1 写 | 100,000 行/天 | 发一条约 3 行 |
| D1 存储 | 5 GB | 一万条约几 MB |

**先用完的一定是构建次数**（500 次 ≈ 每天 16 次），所以别在 `main` 上反复试错：推分支看预览部署，确认了再合并。

---

## 15. 一页速查

```bash
# 一次性
npx wrangler login
npx wrangler d1 create weiqiang-comments --location apac --update-config
npx wrangler d1 execute weiqiang-comments --remote --file=cf/schema.sql
git push github main                              # 到 Dashboard 连 Git 建项目
npx wrangler pages secret put COMMENTS_ADMIN_TOKEN --project-name weiqiang-org
npx wrangler pages secret put COMMENTS_SALT        --project-name weiqiang-org
# 绑 DB → 绑域名 → Retry deployment → 验 /api/health

# 部署前自检（不用登录）
npx wrangler pages functions build --outdir=/tmp/fnbuild

# 每次发版
npm test
COMMENTS_URL=https://weiqiang.org COMMENTS_ADMIN_TOKEN=xxx npm run comments:pull
git add -A && git commit -m "post: xxx" && git push github main

# 本地
npm run build && npm run dev        # http://127.0.0.1:8788/
npm test                            # 57 项
```

---

详细的额度分析、为什么不用大 JSON、国内访问速度的实话，都在 `cf/README.md`。
