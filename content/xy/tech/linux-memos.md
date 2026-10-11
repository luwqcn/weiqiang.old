---
title: "Linux Memos(备忘)"
date: 2017-07-12
author: "落为匠"
description: "记录使用Linux过程中的一些小问题、小技巧。多为copy & paste。"
tags: ["Linux", "Archlinux", "Tips"]
language: "zh-CN"
email: "luplus.zju@gmail.com"
options: "h:4 toc:nil num:3"
startup: "showall"
---

使用Linux已经有段时间，都是断断续续，没有很好地将这一过程中的知识积累和更新，所以基本没有进步。年过三十，已知积累之重要，知识持续更新之难能，因此立此文件以为积累更新之用，名之曰：Memos。

## Linux basic {#headline-1}

### 目录操作 {#headline-2}

1. cd

用来切换目录，用法：

```
cd (选项) (参数)
```

### DDE(deepin-desktop-environment) {#headline-3}

1. caps ctrl swap (ctrl和caps互换)

```shell
gsettings set com.deepin.dde.keybinding.mediakey capslock ""
gsettings set com.deepin.dde.keyboard layout-options "['ctrl:swapcaps']"
```

## 一些实用工具及用法 {#headline-4}

记录一些日常可能用到的小工具。

### 将 Markdown 文件转为 Org 文件 {#headline-5}

使用 pandoc 这个工具来转换，代码：

```shell
pandoc -f markdown -t org -o new-org-file-name.org origin-markdown-file.md
```

### base64解码 {#headline-6}

看到有博客留邮箱用的一串码，说明是要base64解码的，百度了一下，使用方法如下(macos下)：

```shell
echo "需解码的字符" | base64 -D  #解码
echo "需加码的字符" | base64
```

另一种方法(看到评论说有缺陷)， chromium 内核的浏览器自带，打开开发者工具， Console 下输入：

```shell
btoa('hello,world')  #编码
//'aGVsbG8sd29ybGQ='
atob('aGVsbG8sd29ybGQ=')  #解码
//'hello,world'
```

base64是什么：

> Base64是一种用64个字符来表示任意二进制数据的方法。

### Mac OS {#headline-7}

解决 .DS_Store 文件问题：
禁止生成使用下列代码

```shell
defaults write com.apple.desktopservices DSDontWriteNetworkStores -bool TRUE
```

重新生成使用下列代码

```shell
defaults write com.apple.desktopservices DSDontWriteNetworkStores -bool FALSE
```

删除文件夹下 .DS_Store 文件：

```shell
find . -name ‘.DS_Store’ -type f -delete / find ~ -name ".DS_Store" -delete
```

### SSH 免密登录 {#headline-8}

SSH 登录： ssh 用户名@目标主机ip/域名，此时回车后一般需要输入密码验证通过才能登录。

目标：本地主机 A 免密登录目标主机 B；方式：本地主机上生成公钥文件与私钥文件，传递公钥文件到目标主机，实现免密登录。

步骤：
1. 本地主机上生成密钥对： `ssh-keygen` ；
2. 拷贝公钥到目标主机： `ssh-copy-id 目标主机ip` ，会在目标主机生成 `.ssh/authorized_keys` 文件；
3. 直接登录： `ssh 用户名@目标主机ip` 。

### 文本替换 {#headline-9}

把 org 文件中的 `原文本` 替换为 `现文本` ，使用 `find`, `xargs` 和 `sed` 实现。

```shell
find . -name "*.org" | xargs sed -i 's/原文本/现文本/g'
```

### git 相关 {#headline-10}

创建 submodule

```shell
git submodule add <submodule_url> path # git submodule add git@github.com:username/xxx.git path
```

获取 submodule

```shell
cd path
git clone url --recurse-submodules
```

或者

```shell
git submodule init
git submodule update
```

### rsync 文件同步 {#headline-11}

<https://www.ruanyifeng.com/blog/2020/08/rsync.html>

```shell
$ rsync -av --delete source/ destination
```

将 source 文件夹内容同步到 destination 文件夹内。 `--delete` 参数会使 destination 成为 source 的一个镜像。
