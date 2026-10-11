---
title: "Emacs 学习笔记"
date: 2019-07-18
author: "落为匠"
description: "Articles and notes for learning GNU Emacs and orgmode."
tags: ["emacs", "orgmode"]
language: "zh-CN"
options: "comment:nil pagenav:nil entrymeta:nil"
startup: "showall"
---

## Emacs tutorial 学习笔记 {#headline-1}

Learn emacs from tutorial. 学习emacs从内置指南开始。

### useful commands 快捷键 {#headline-2}

记录常用快捷键，C代表CTRL，M代表META/ALT。

#### 控制屏幕 {#headline-3}

C-v 下一屏
M-v 上一屏
C-l 清屏，以光标所在位置居中，再次按C-l，光标跳到屏幕顶端，接着再按C-l光标跳到屏幕底部

#### 控制光标 {#headline-4}

C-p 跳到上一行 Previous line
C-b 倒退一个字 Backward
C-f 向前一个字 Forward
C-n 跳到下一行 Next line
M-f 向前一个词
M-b 倒退一个词
C-a 移动到行首
C-e 移动到行末
M-a 移动到句首
M-e 移动到句末
M-&lt; 移动到文件开始处
M-> 移动到文件末尾处
C-u + 数字 + 快捷键 重复后面“快捷键”次数（数字） 对C-v M-v无效

#### 取消 {#headline-5}

C-g 停止或取消前次命令

#### 窗口(Windows) {#headline-6}

C-x 1 保留1个窗口（当前光标所在窗口），删除其他窗口

#### 插入和删除 {#headline-7}

<DEL> 删除光标前一个字符
C-d 删除光标后一个字符
M-<DEL> 删除光标前的字符（以下四个均是kill，保留在剪切版，还能插入，类似cut）
M-d 删除光标后的字符
C-k 删除光标所在位置到行末
M-k 删除光标所在位置到句末
C-y 在光标处插入之前剪切版的内容（yank，类似paste）
M-y 在光标处插入更早删除的内容

#### 撤销 {#headline-8}

C-/ 撤销
C-_ 同上
C-x u 同上

#### 文件 {#headline-9}

C-x C-f 文件名  打开文件，如果无该文件则新建
C-x C-s 保存

#### BUFFERS {#headline-10}

C-x C-b 显示buffer列表
C-x b buffer名称 <Enter> 进入buffer
C-x s 保存多个buffer

#### X command (extend) {#headline-11}

C-x 一个字符
M-x 一个名字（命令）
C-z suspends emacs
M-x recover-this-file <Return> 恢复文件

#### 搜索 {#headline-12}

C-s
C-r

#### 表格 {#headline-13}

表格功能强大，下面是快捷键。目前发现问题是无法对齐，不知道导出html时是什么情况。

| 快捷键 | 描述 |
|---|---|
| C-c l | 创建表格 |
| C-c C-c | 重新调整表格缩进 |
| Tab | 移动至下一个区域，必要时（行尾）创建一行 |
| S-Tab | 移动至上一个区域 |
| S-Enter | 移动至下一行，必要时（行尾）创建一行 |
| M-Left/Right | 移动列 |
| M-Up/Down | 移动行 |
| M-S-Left/Right | 删除/插入行 |
| M-S-Up/Down | 删除/插入列 |
| C-c - | 插入水平分割线 |
