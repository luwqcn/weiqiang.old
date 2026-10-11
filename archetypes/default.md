+++
date = '{{ .Date }}'
slug = '{{ replaceRE "^[0-9]{4}-[0-9]{2}-[0-9]{2}-" "" .File.ContentBaseName }}'
draft = true
title = '{{ replace .File.ContentBaseName "-" " " | title }}'
+++
