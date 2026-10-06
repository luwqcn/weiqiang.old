# SimpleW

Hugo 主题本体。安装说明、配置总览、写作与迁移指南都在仓库根目录的
[`README.md`](../../README.md)。

一句话索引：

| 想改什么 | 去哪儿 |
| --- | --- |
| 增删栏目 | 站点 `hugo.toml` 的 `[[params.sections]]` |
| 主页排版 | 站点 `hugo.toml` 的 `[[params.home.blocks]]` |
| 分类页列表风格 | 注册表的 `style`，或 `content/<dir>/_index.md` 的 front matter |
| 评论引擎 | `params.comments.provider` |
| 评论模板 | `params.comments.template`，或覆盖 `layouts/partials/comments/*.html` |
| 文末「上一篇 / 下一篇」 | `params.post.showPrevNext`（默认 true）；仅栏目内的文章显示，根目录独立页面永远不显示 |
| 文末相关文章数量 | `params.post.relatedCount`（默认 5，设 0 关闭）；同上，仅文章显示 |
| 文末标签 | `params.post.showTags`（默认 true），显示在正文之后、上一篇/下一篇之上；来源依次为 `#+FILETAGS` → `#+KEYWORDS` → front matter tags，都可点开 `/tags/<词>/`（`[permalinks] keywords` 把地址改到了 /tags/）；独立页面不显示 |
| 字数 / 阅读时间 | 按中文字数统计；`params.post.wordsPerMinute`（默认 400 字/分钟）调阅读时间 |
| 文章目录 | `params.toc.enabled` / `params.toc.open`（宽屏显示在正文右侧） |
| 标题锚点（悬停出现 #） | 有目录的页面自动加；样式在 `assets/css/extras.css` 的 `.heading-anchor` |
| 评论框开关 | 文章默认显示；站点根目录的独立页面默认不显示；`[[params.sections]]` 该栏目那条写 `comments = false` 可整栏关闭（子栏目再单列一条 `key = "xy/dian"` 可覆盖）；单篇头信息 `comments: true/false` 优先级最高 |
| 栏目页不列文章 / 挂右侧目录 | `[[params.sections]]` 的 `hideList`（如 /xy/ 只作导览）与 `toc`（页面自身没标题时不会出现空框） |
| 配色 / 字体 / 栏宽 | 站点 `assets/css/custom.css` 里的 `:root` 变量 |
| 任何模板 | 在站点同名路径放一份文件即可遮挡主题版本 |

主题源码布局：

```
assets/css/     base(令牌·排版) layout(骨架) components(组件) extras(新增件) utils(响应式·打印) chroma(高亮)
assets/js/      main.js —— 主题切换、目录高亮、少量增强（目录吸顶是纯 CSS）
layouts/
  baseof.html                      文档外壳
  home.html                        首页（积木调度）
  section.html term.html
  taxonomy.html list.html page.html 404.html
  _markup/                         代码块 / 图片 / 标题 / 链接 render hook
  partials/
    func/sections.html             栏目注册表（增删分类的核心）
    func/section-meta.html         单个列表页的元信息解析
    func/section-comments.html     按栏目解析评论开关
    blocks/                        主页积木
    comments/                      评论引擎 + 自定义模板入口
    components/entry-row.html      索引行
    entry-list.html                三种列表风格
    listing.html                   所有分类页共用的骨架
    head.html header.html footer.html scripts.html toc.html pagination.html
  shortcodes/callout.html
i18n/          zh-cn.toml en.toml
```

许可：MIT。
