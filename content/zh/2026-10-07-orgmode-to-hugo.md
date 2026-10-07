+++
title = "网站从 orgmode 导出迁移至 hugo 驱动"
author = ["LOWEJAN"]
date = 2026-10-07
lastmod = 2026-10-07T21:47:38+08:00
slug = "orgmode-to-hugo"
tags = ["hugo", "orgmode"]
keywords = ["hugo", "orgmode"]
categories = ["站务"]
draft = false
+++

这个国庆假没有外出，家里蹲。就花了点时间把 orgmode 站点迁移至 hugo 。

迁移的想法已经有点久了，但因为没有什么技术能力，一直没有动手。现在不一样了，智能体能力已经足够，所以用 workbuddy 做了整站迁移。


## 为什么要迁移 {#为什么要迁移}

迁移有两个原因：

一是 emacs orgmode 虽然用了很久，但一直浅尝辄止，运用的频率和技能都不怎么提升，站点调整的某些想法实现不了，学习成本太高了点，所以 orgmode 导出 html 静态站点的必要性不高了。

二是 hugo 生态足够丰富，看过不少用 hugo 驱动的个人博客，一直有使用的想法，而且使用起来相对方便，自己设计或者使用别人的主题即可。


## 迁移过程 {#迁移过程}

整个过程都通过 workbuddy 完成，把自己的需求提给 workbuddy 后，按站点目前的风格制作了一个 hugo 主题。因为 hugo 对 orgmode 文件也有支持，所以让 workbuddy 稍微作了调整，预览下来基本就可以了。

作了几个调整：

1.  固定链接调整成了 pretty url ，之前链接直接是文件名，带日期的，现在改成了 `year/slug/` ，去掉了 html 结尾。
2.  评论从 artalk 改成了 twikoo ，原本 artalk 是自己部署在 NAS 上，然后用 Cloudflare Tunnel 连通外网，偶尔会断线。现在改为用 netlify 部署 twikoo, 用了免费的额度。
3.  网志页风格调整成了按年份日历列表，都是用 workbuddy 做的。
4.  增加了深浅色两种风格。
5.  因为域名托管在 Cloudflare ，所以部署从 EdgeOne 调整到了 Cloudflare Pages ，实测下来浏览速度在晚上有点慢，没啥流量也无所谓了。
6.  页面右侧加了个目录。

其他还有一些风格上的微调不表。


## 遗留的问题 {#遗留的问题}

因为之前部署的 artalk 没有及时做备份，评论还没能迁移过来，这是最主要的问题。

另外的问题就是 Pages 的浏览速度了，不过这个也关系不大。

其他再慢慢看吧。现在有 workbuddy 在，有问题只需要提几个需求即可，完全不用懂技术，真真是这个时代的技术福利。
