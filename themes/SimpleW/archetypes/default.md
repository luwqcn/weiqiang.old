---
title: "{{ .File.ContentBaseName }}"
date: {{ .Date }}
lastmod: {{ .Date }}
slug: "{{ replaceRE "^[0-9]{4}-[0-9]{2}-[0-9]{2}-" "" .File.ContentBaseName }}"
draft: true
description: ""
subtitle: ""
tags: []
categories: []
# 单页可选：
# comments: false            # 关闭本页评论
# comments:
#   provider: giscus         # 单独指定评论引擎
# toc: false                 # 不显示目录
# cover: /images/xxx.jpg
---

正文从这里开始。
