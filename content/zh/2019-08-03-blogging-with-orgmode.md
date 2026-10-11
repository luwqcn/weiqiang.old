+++
title = "使用 Org Mode 写博客"
author = ["落为匠"]
description = "记录使用 Org Mode 写博客的几次折腾过程，并不详细。"
date = 2019-08-03T22:52:00+08:00
lastmod = 2026-10-11T18:07:06+08:00
slug = "blogging-with-orgmode"
tags = ["OrgMode", "博客", "Emacs"]
draft = false
+++

本篇略记博客/网站生成流程。本站使用 Emacs Orgmode 导出功能生成 html 文件，使用 Artalk 实现评论功能。


## <span class="section-num">1</span> 背景 {#背景}

自2016年离职后，一直静不下心，几近停止思考。翻翻以往文字，偶尔会有些感触。曾几何时，也是有一番立志，计划长久积累，此次聊记几笔，亦是作个见证。

写博客有些日子了，但好像都没能坚持下来。从刚开始的新浪、百度、博客大巴之类，到后来的所谓独立博客，使用 Wordpress、Typecho 搭建，域名换了又换，再到后来在 Github pages 上使用 Jekyll 搭了个简单的页面，再到今年前些时候决定重启博客，尝试了各种静态博客生成工具，最终还是选择了 Jekyll，折腾很久算是将简洁的风格确定了。但没写几篇，又改了主意。

此次，立志好好學習。使用 Emacs 和 Org Mode 搭建了个人页面，算是从头开始。


### <span class="section-num">1.1</span> 为什么这么折腾 {#为什么这么折腾}


#### <span class="section-num">1.1.1</span> 目标不明确 {#目标不明确}

1.  心未定。虽然知道博客有助于自身进步，从很多人的经历中，都可以看出其思想脉络和心路历程。但知易行难，心未定，则几经周折，不知所措。
2.  行不恒。持之以恒实在是件难事，虽然曾经坚持了两三年的 Typecho，后来生活中的各种忙碌之后，便也能不了了之。


#### <span class="section-num">1.1.2</span> 此次重启之原因 {#此次重启之原因}

实在是因为无论工作还是生活中，从日常阅读观察中，发现自身越来越不及这个时代的变迁，不及专业的能力，亦难以应对生活中的难处。不学习不足以应世事之变，不积累不足以成生活之美。

Emacs 被称为神之编辑器，Org Mode 是其内建的功能强大的管理工具。之所以选择这样的工具，实在是因为自己喜欢这种求新求变，富于挑战。有人说学习成本异常高，在搭建的过程中我也确实感受到了，以致于有人说“尽选hard模式”，想想其实也蛮可笑的。但，这是为了坚持。

-   凡事开头难：人生没有速成，只有不断积累，方能成就。所有文字以org文件管理，是积累的一部分，并有利于备份。
-   坚持最重要：曾经未能做到的，不羞于启齿，亦善于总结，重要的是坚持。


## <span class="section-num">2</span> Org project 搭建 {#org-project-搭建}

具体过程不再赘述，参考资料如下：

-   org-tutorial: [Publish org-mode files to html](http://orgmode.org/worg/org-tutorials/org-publish-html-tutorial.html)
-   Dayigu's Basket: [为什么用 org-mode 写 blog？](http://dayigu.github.io/WhyUseOrgModeToWriteBlog.html)  （已无法访问<span class="timestamp-wrapper"><span class="timestamp">&lt;2021-02-27 六&gt;</span></span>）
-   pank.eu: [Blogging with ORG](https://pank.eu/blog/blog-setup.html) **主要参考此篇** 。

从网络中收集了部分使用 Emacs 和 Org Mode 构建的网站（博客），详见 [使用 Emacs 和 Org Mode 生成的网站]({{< relref "2019-08-14-sites-with-orgmode" >}})。


### <span class="section-num">2.1</span> Deployment 部署 {#deployment-部署}

起初直接在本地使用 M-x org-publish-all 导出 html 文件后 git push 至 Github，使用 Github pages。后来感觉麻烦，搜索之后找到 Gitlab pages，能直接自动编译后部署。 Gitlab 的好处是测试方便，缺点是速度有些慢，绑定独立域名有些欠缺。最后，找到 Netlify，与 Gitlab 一样可以自动编译部署，还自带CDN，速度快，绑定独立域名也方便，网上推荐说点几下就搞定，的确如此。


## <span class="section-num">3</span> UPDATE {#update}

<span class="timestamp-wrapper"><span class="timestamp">&lt;2021-02-27 六&gt;</span></span>

继续折腾 Org Mode 导出，这次通过万能的 Github ，找到了一些可用的代码，实现如下功能：

-   类似博客的 Index 页面，通过自定义 sitemap-format 实现；

-   以文件夹来分类，每个分类下自动生成 index 页面，通过 auto-sitemap 来实现，虽然比较弱智，但够用；

-   博客内容集中在 content 文件夹下，与其他如 image, CSS 之类文件分开，看起来比较简单些，目前目录结构类似如下：

<!--listend-->

```text
├── README.org
├── assets
│   ├── css/
│   ├── favicon.ico
│   └── images/
├── content
│   ├── about.org
│   ├── blog/
│   ├── index.org
├── publish.el
├── templates
```

-   `Blog` 分类下生成 rss.xml 文件，可用于 RSS 订阅；

-   生成最新文章列表并通过 `include` 添加到主页内，实现「最近更新」栏目。

`assets` 放置静态文件， `content` 放置 org 文件， `templates` 放置 header/footer 等随时可变更的文件（类似于模板）了， `publish.el` 为 emacs 用以导出 html 文件的代码。大致就是以上这些，另外借用了 [ORGCSS](https://github.com/gongzhitaao/orgcss) 的配色风格，最终就是网站现在的样子了。

**特别说明：** 每个 Org 文件的 Front Matter 必须包含 `#+DESCRIPTION` 和 `#+KEYWORDS` ，如果没有的话 blog 的 Index 页会显示 nil 。


### <span class="section-num">3.1</span> Export {#export}

_publish.el_ 文件是用来导出 html 的，详见[这里](https://github.com/lowejan/orgsitedemo/blob/main/publish.el)。在 Github 上放了一个 [Demo](https://github.com/lowejan/orgsitedemo) 可供参考。

在项目文件夹下使用如下命令（也是在 Netlify 中配置的 Build command）：

```shell
emacs --batch --no-init-file --load publish.el --funcall org-publish-all
```

当前文件夹中的 public 文件夹内即为导出的 html 文件。


### <span class="section-num">3.2</span> Update {#update}

<span class="timestamp-wrapper"><span class="timestamp">&lt;2021-03-07 日&gt;</span></span>: 使用 Github Actions 导出 html 文件至 gh-pages 分支，通过 [Vercel](https://vercel.com) 部署。

<span class="timestamp-wrapper"><span class="timestamp">&lt;2021-03-13 六&gt;</span></span>: 使用 Cloudflare Pages 直接抓取 Github 仓库部署，速度似乎要快了些。

<span class="timestamp-wrapper"><span class="timestamp">&lt;2021-11-28 日&gt;</span></span>: Orgmode 更新后，[Cloudflare Pages](https://pages.cloudflare.com/) 构建失败，尝试后发现本地是没有问题的，找不到原因也解决不了，重新使用 [Github Actions](https://docs.github.com/en/actions) 自动发布 html 文件到新的仓库，再使用 Cloudflare Pages 部署，算是比较顺利。顺便这周末把10年开始留存至今的org域名转到了 Cloudflare ，本来在阿里云的，结果找不到，查了很久发现要转到阿里云国际了，折腾了不少时间。

<span class="timestamp-wrapper"><span class="timestamp">&lt;2021-12-25 六&gt;</span></span>: 评论系统调整为 Twikoo, 按官方教程申请了 MongoDB 并部署到 Vercel 上。

<span class="timestamp-wrapper"><span class="timestamp">&lt;2022-01-01 六&gt;</span></span>: Github repo 设置为 public（内容 content 文件夹放在私有 repo 内），使用 Github Actions 导出 html 文件至 gh-pages 分支，再部署到 Vercel 上。同时，更改评论系统为 Waline 。

<span class="timestamp-wrapper"><span class="timestamp">&lt;2023-07-25 二&gt;</span></span>: 一年余未有记录，想重启时发现 Github 经常抽风，甚是恼人，遂转移至 Gitlab 并直接使用 Gitlab Pages 构建，自己浏览速度尚可。

<span class="timestamp-wrapper"><span class="timestamp">&lt;2023-09-30 六&gt;</span></span>: 目前工作流为：本地通过 Emacs Orgmode 导出 html 文件，部署至局域网 nginx 服务器，通过 Cloudflare Tunnels 内网穿透实现公网访问。日志栏内每篇文章增加“上一篇、下一篇”功能，复制的[jgkamat](https://jgkamat.gitlab.io/blog/website1.html)的代码，不懂 elisp，改了一个多小时居然成功，但效率一般，导出一篇目测需要1秒（龙芯3A5000电脑），但于我而言无甚影响。
