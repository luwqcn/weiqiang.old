# 部署手册 · Hugo 静态站 → Cloudflare Pages

站点是**纯静态**的：Hugo 生成 `public/`，Cloudflare Pages 托管。
没有 Functions、没有数据库、没有需要维护的服务端。

评论是外挂的：页面里只放一个前端组件，数据存在 `cwd.weiqiang.org` 那套
Cloudflare Workers + D1 上，跟这个 Pages 项目互不相干。

> 2026-10-26 曾把一套 Pages Functions + D1 的自建评论整体下线，
> 现在换成 provider 结构（见第 5 节）。旧方案的状态存档在 git tag 里。

---

## 1. 本地跑

```bash
npm run dev      # hugo server，http://127.0.0.1:1313/
npm run build    # 产出 public/
```

`npm run build` 走 `scripts/build.mjs`，它会：

1. 看本机 `hugo` 版本，≥ 0.158 直接用；
2. 不够就按 `HUGO_VERSION`（默认 0.168.0）从 GitHub Releases 下载到 `.hugo/` 再跑；
3. 把 `TZ` 钉成 `Asia/Shanghai`，日期不会因为机器时区差一天。

所以本地装没装对版本的 Hugo 都不影响结果。

## 2. Cloudflare Pages 项目设置

Dashboard → Workers & Pages → `weiqiang-org` → Settings → Build

| 项 | 值 |
| --- | --- |
| Build command | `npm run build` |
| Build output directory | `public` |
| Framework preset | `None` |
| Root directory | 留空 |

**环境变量一个都不用设。** Hugo 版本由构建脚本自己保证，时区也在脚本里定了。

> 历史背景：Cloudflare 构建镜像自带 Hugo 0.147.7，而主题用了 `{{ return 值 }}`
> （0.148+，12 处）和 `site.Language.Locale`（0.158+）。官方说设 `HUGO_VERSION`
> 环境变量就能换版本，但本项目实测设了不生效（日志里一直是 0.147.7，还带一行
> `Build environment variables: (none found)`），所以才改成脚本自管。

## 3. 发布

推 `main` 分支就自动构建：

```bash
git push github main
```

GitHub 仓库是 `wejanz/weiqiang.org`（旧名 `shujiaccn/weborg` 已重定向）。

看构建结果：

```bash
wrangler pages deployment list --project-name weiqiang-org
```

`Active` 就是成功，`Failure` 去 Dashboard 看日志。

## 4. 验站点

```bash
curl -s --http1.1 -o /dev/null -w "%{http_code}\n" https://weiqiang-org.pages.dev/
```

> **`--http1.1` 别省。** 本机走 HTTP/2 经代理访问 `*.pages.dev` 会稳定返回 522
> （Cloudflare 边缘错误页），加了这个参数就是 200，不是站点挂了。

想用命令行发布（不占构建额度）：

```bash
npm run build
wrangler pages deploy public --project-name weiqiang-org
```

> **本机不建议用这条**：841 个文件 / 48MB 上传时会在 C++ 层 `std::bad_alloc`
> ——这台机器 `ulimit -v` 只有 4GB。走 Git 自动构建没这个问题。

## 5. 评论

文章页底部是一个标签页组：**网络提及 / 评论 / 邮件**。结构在
`themes/SimpleW/layouts/partials/comments.html`，三个标签各由自己的开关决定
出不出现，都不可用时回落成一句「评论功能未启用」。

| 标签 | 来源 | 配置 |
| --- | --- | --- |
| 网络提及 | webmention.io 的提及 | `[params.webmention]` |
| 评论 | 下面 `provider` 指定的引擎 | `[params.comments]` + `[params.comments.<名字>]` |
| 邮件 | `mailto:` 链接 | `[params.comments] email`，留空则不出现 |

换引擎只改一行：

```toml
[params.comments]
  provider = "cwd"   # cwd | twikoo | artalk | giscus | disqus | waline | utterances | custom | none
```

各引擎的配置块在 `hugo.toml` 里都留着（`twikoo` / `artalk` / `giscus` 已填原来的值，
`giscus` 还差 repoId）。切过去只要填对应那块，模板不用动。

### CWD（当前用的）

API 自建在 `https://cwd.weiqiang.org`（Cloudflare Workers + D1），
文档在 https://cwd.js.org 。配置：

```toml
[params.comments.cwd]
  api = "https://cwd.weiqiang.org"     # API 基础地址，末尾不带斜杠
  siteId = ""                          # 后台开了「多站点管理」才填站点 ID
  lang = "zh-CN"
  pageSize = 20
  postSlug = ""                        # 空 = 用页面路径（.RelPermalink）
  cdn = "https://cdn.jsdelivr.net/npm/cwd-widget@0.2.1/dist/cwd.umd.js"
```

几个容易踩的点：

- **评论按 `postSlug` 存**，默认就是页面路径（`/zh/2026/xxx/`）。改永久链接
  等于换了把钥匙，老评论查不出来。真要改 URL，先把 `postSlug` 固定成旧值。
- 组件有 393KB，所以 `layouts/partials/comments/cwd.html` 是**按需加载**：
  只有「评论」标签被选中时才插 `<script>`，默认停在别的标签就一个字节都不下。
- 组件用 Shadow DOM，本站 CSS 管不到它内部；要改外观只能用 `customCssUrl`。
- 标签上的条数徽标来自 `/api/comments` 的 `pagination.totalCount`（组件在
  Shadow DOM 里，数不到 DOM 节点）。
- 后端开了 Turnstile（`/api/config/comments` 能读到 siteKey），组件会自己加载
  人机验证，前端不用额外配。
- 文档里写的组件路径是 `dist/cwd.js`，npm 包里实际入口是 `dist/cwd.umd.js`；
  两个 CDN 上都取得到，配置里锁的是后者。

## 6. 排错

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 构建报 `can't evaluate field Locale` | Hugo 版本低于 0.158 | 正常不会出现；出现说明 Build command 不是 `npm run build` |
| 构建报 `wrong number of args for return` | Hugo 版本低于 0.148 | 同上 |
| 构建日志 `hugo: command not found` | 没经过 `scripts/build.mjs` | Build command 改回 `npm run build` |
| 构建日志 `Hugo 0.xxx 下载失败` | 构建机连不上 GitHub Releases | 重试；反复失败就在环境变量里设 `HUGO_VERSION` 换版本 |
| 线上 522 | 多半是本机代理的 HTTP/2 问题 | 先加 `--http1.1` 复测 |
| 改了代码线上没变 | 推到了 Codeberg（origin），没推 GitHub | `git push github main` |
| 页面日期全是同一天 | front matter 被批量写入了 lastmod | `grep -rhE "^lastmod *[:=]" content --include="*.md" \| sort \| uniq -c \| sort -rn \| head` |
| 评论区一片空白，控制台报 CORS | API 地址写错，或后端 `allowedDomains` 不含当前域名 | 核对 `[params.comments.cwd] api`；后端「功能设置」里放行域名 |
| 提示「评论脚本加载失败」 | CDN 取不到组件 | 查 `cdn` 里的版本号是否存在（当前 `0.2.1`），或换 `unpkg.com` 源 |
| 评论发出去了但页面没有 | 后端开了审核 | 管理后台把状态改成通过 |
| 换了域名后老评论不见了 | `postSlug` 默认取页面路径 | 用 `postSlug` 固定成旧路径，或迁移后端数据 |

## 7. 额度

免费版：静态请求和带宽不限，500 次构建/月。
按每天推 2～3 次算，够用。下载 `.hugo/` 不占额度，只占构建时长（每次十几秒）。

---

## 历史：评论系统

2026-10-26 之前，站点挂过一套自建评论（Cloudflare Pages Functions + D1，
前端 `assets/js/comments-json.js`，构建期直出到 HTML）。

那套已整体移除：代码、`functions/`、`cf/`、`data/comments.json`、D1 库、两个密钥。
现在恢复的是「主题原生 provider 结构 + 外部服务」，也就是说静态站这边什么都不用跑
（见第 5 节）。

要翻旧方案的话：

```bash
git tag -l "archive/*"                  # archive/comments-d1 = 下线前的完整状态
git checkout archive/comments-d1 -- .   # 或直接看那个提交
```

D1 数据在 `_legacy/comments-archive-20261026/`（3 条测试评论 + schema）。
那份导出不进仓库，只在本机。
