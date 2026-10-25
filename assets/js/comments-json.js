/* ==========================================================================
   评论区脚本（自建 JSON 版）—— weiqiang.org
   --------------------------------------------------------------------------
   配套：layouts/partials/comments/json.html、assets/css/comments-json.css
   接口：GET/POST /api/comments，实现在 comments-api/server.py

   几条原则：
   · 不引任何第三方库，一个 IIFE 走完；
   · 评论正文一律用 textContent 塞进 DOM，不拼 innerHTML —— 访客写什么就
     显示什么，不会变成标签；
   · 邮箱只在前端做必填校验并随请求发出，绝不回显，也不写进 localStorage
     以外的地方（localStorage 那份是访客自己下次填表用的，可随时清）；
   · 标签页没切到「评论」时不发请求，省一次往返（跟 Twikoo 那套一致）。
   ========================================================================== */
(function () {
  "use strict";

  var root = document.getElementById("cm-root");
  if (!root) return;

  var cfg = {
    endpoint: root.getAttribute("data-endpoint") || "/api/comments",
    page: root.getAttribute("data-page") || location.pathname,
    limit: parseInt(root.getAttribute("data-limit"), 10) || 200,
    max: parseInt(root.getAttribute("data-max"), 10) || 3000,
    base: root.getAttribute("data-base") || "/",
    avatars: {}
  };
  // 统一成以 / 结尾，拼站内地址时不用再判断
  if (cfg.base.charAt(cfg.base.length - 1) !== "/") cfg.base += "/";

  /* 头像映射由 Hugo 在构建时写进页面（昵称 -> 图片地址），
     后端不用读文件，改头像只跟构建走。 */
  try {
    var avEl = document.getElementById("cm-avatars");
    if (avEl) cfg.avatars = JSON.parse(avEl.textContent || "{}") || {};
  } catch (e) {
    cfg.avatars = {};
  }

  var listEl = root.querySelector("[data-cm-list]");
  var form = root.querySelector("[data-cm-form]");
  var countEl = root.querySelector("[data-cm-count]");
  var statusEl = root.querySelector("[data-cm-status]");
  var submitBtn = root.querySelector("[data-cm-submit]");
  var counterEl = root.querySelector("[data-cm-count-chars]");
  var textarea = form ? form.querySelector('[name="content"]') : null;
  var replyBar = root.querySelector("[data-cm-replying]");
  var replyNameEl = root.querySelector("[data-cm-replying-name]");
  var cancelReplyBtn = root.querySelector("[data-cm-cancel-reply]");
  var formTitleEl = root.querySelector("[data-cm-form-title]");

  var LS_AUTHOR = "wq.cm.author";
  var LS_DRAFT = "wq.cm.draft:" + cfg.page;

  // reply: 当前在回复谁 { id, name }；null 表示发一条新的
  var state = { comments: [], loading: false, posting: false, reply: null };

  /* ----------------------------------------------------------------------
     小工具
     ---------------------------------------------------------------------- */
  var EMAIL_RE = /^[^@\s<>"'`]+@[^@\s<>"'`]+\.[^@\s<>"'`]{2,}$/;

  function store(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
      return true;
    } catch (e) {
      return false;  // 隐私模式 / 关掉 cookie 时静默退化
    }
  }

  function load2(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  function pad(n) { return n < 10 ? "0" + n : String(n); }

  function relTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso || "";
    var diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 0) diff = 0;
    if (diff < 60) return "刚刚";
    if (diff < 3600) return Math.floor(diff / 60) + " 分钟前";
    if (diff < 86400) return Math.floor(diff / 3600) + " 小时前";
    if (diff < 86400 * 7) return Math.floor(diff / 86400) + " 天前";
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function fullTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso || "";
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  /* 头像底色：按昵称散列挑一个低饱和色相，浅色深色底上都压得住白字 */
  var HUES = [6, 24, 42, 92, 148, 188, 212, 262, 318];

  function avatarColor(name) {
    var h = 0;
    for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 100000;
    return "hsl(" + HUES[h % HUES.length] + " 32% 50%)";
  }

  function initial(name) {
    var s = (name || "").trim();
    if (!s) return "?";
    // 取第一个「字」：代理对（emoji）算一个
    var first = s.codePointAt(0);
    return String.fromCodePoint(first).toUpperCase();
  }

  /* 站内图片地址：子路径部署时要补上 /<仓库>/ 前缀。
     只认三种 —— http(s) 绝对地址、以 / 开头的站内路径、相对路径。
     javascript: / data: / //别的域名 一律不认：映射文件是手改的，
     手滑写错一个冒号不该变成脚本。 */
  function assetUrl(u) {
    u = String(u || "").trim();
    if (!u) return "";
    if (/^https?:\/\//i.test(u)) return u;
    if (u.charAt(0) === "/") {
      if (u.charAt(1) === "/") return "";                 // 协议相对，指向别家
      return cfg.base.replace(/\/+$/, "") + u;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return "";        // 其它协议
    return cfg.base + u.replace(/^\.?\//, "");
  }

  /* 头像三级：本地图 > Gravatar > 首字母色块。
     后一级必须兜得住前一级 —— 图 404、被墙、被隐私插件拦，都得还有东西显示。 */
  function avatarNode(c) {
    var box = document.createElement("div");
    box.className = "cm-avatar";
    box.setAttribute("aria-hidden", "true");

    var name = c.name || "匿名";

    function fallback() {
      while (box.firstChild) box.removeChild(box.firstChild);
      box.classList.remove("has-img");
      box.textContent = initial(name);
      box.style.backgroundColor = avatarColor(name);
    }

    // 本地图：优先用页面里带的映射（构建期写入），接口下发的 avatar 作为兼容兜底
    var src = assetUrl(cfg.avatars[name] || c.avatar);
    if (!src && c.avatar_hash) {
      // d=404：没注册 Gravatar 的直接 404，交给 fallback，不会显示默认灰头像
      src = "https://gravatar.com/avatar/" + encodeURIComponent(c.avatar_hash) +
            "?s=108&d=404&r=g";
    }
    if (!src) {
      fallback();
      return box;
    }

    box.classList.add("has-img");
    box.style.backgroundColor = avatarColor(name);  // 图带透明时底下也有个同色兜底

    var img = document.createElement("img");
    img.alt = "";
    img.width = 54;
    img.height = 54;
    img.loading = "lazy";
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    img.addEventListener("error", fallback);
    img.src = src;

    box.appendChild(img);
    return box;
  }

  /* 正文里裸露的网址变成可点链接。先按纯文本切，再生成节点，
     全程不碰 innerHTML，所以 "<script>" 之类只会原样显示。 */
  function linkify(text) {
    var frag = document.createDocumentFragment();
    var re = /https?:\/\/[^\s<>"'）】」》]+/g;
    var last = 0;
    var m;
    while ((m = re.exec(text)) !== null) {
      var token = m[0];
      var tailMatch = token.match(/[.,;:!?、，。；：！？)）】」》]+$/);
      var tail = tailMatch ? tailMatch[0] : "";
      var href = tail ? token.slice(0, token.length - tail.length) : token;

      if (m.index > last) {
        frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      }

      if (href.length > 10 && /^https?:\/\/[^/\s]+/i.test(href)) {
        var a = document.createElement("a");
        a.href = href;
        a.textContent = href;
        a.rel = "nofollow ugc noopener noreferrer";
        a.target = "_blank";
        frag.appendChild(a);
        if (tail) frag.appendChild(document.createTextNode(tail));
      } else {
        frag.appendChild(document.createTextNode(token));
      }
      last = m.index + token.length;
    }
    if (last < text.length) {
      frag.appendChild(document.createTextNode(text.slice(last)));
    }
    return frag;
  }

  function httpMessage(code) {
    if (code === 404) return "评论接口没接上（404），看看 nginx 有没有把 /api/comments 反代过去。";
    if (code === 413) return "内容太长了，精简一点。";
    if (code === 429) return "发得有点快，缓一会儿再来。";
    if (code >= 500) return "评论服务打了个盹，稍后再试。";
    return "请求失败（" + code + "）。";
  }

  function api(url, opts) {
    opts = opts || {};
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 15000) : null;

    var init = {
      method: opts.method || "GET",
      headers: { "Accept": "application/json" },
      credentials: "same-origin"
    };
    if (controller) init.signal = controller.signal;
    if (opts.body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }

    return fetch(url, init).then(function (res) {
      return res.text().then(function (raw) {
        var data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (e) { /* 非 JSON，按状态码兜底 */ }
        if (!res.ok) {
          var err = new Error((data && data.error) || httpMessage(res.status));
          err.status = res.status;
          throw err;
        }
        return data;
      });
    }).catch(function (err) {
      if (err && err.name === "AbortError") {
        throw new Error("等太久了，检查一下网络再试。");
      }
      // fetch 自己抛的（没有 status）：连不上、跨域被拦、混合内容。
      // 浏览器给的是 "NetworkError when attempting to fetch resource." 这种
      // 英文原文，摆给访客看没意义 —— 换成中文，细节丢控制台，排错时能看。
      if (!err || !err.status) {
        if (window.console && console.warn) {
          console.warn("[评论] 请求失败：" + url, err);
        }
        throw new Error("连不上评论服务，稍后再试。");
      }
      throw err;
    }).finally(function () {
      if (timer) clearTimeout(timer);
    });
  }

  /* ----------------------------------------------------------------------
     列表渲染
     ---------------------------------------------------------------------- */
  function setCount(n) {
    if (countEl) {
      countEl.textContent = String(n);
      countEl.hidden = n <= 0;
    }
    // 顺手把标签上那个条数徽标也点亮（comments.html 里那个 data-count-comments）
    var badges = document.querySelectorAll("[data-count-comments]");
    for (var i = 0; i < badges.length; i++) {
      badges[i].textContent = String(n);
      badges[i].hidden = n <= 0;
    }
  }

  function itemNode(c, replyTo) {
    var item = document.createElement("article");
    item.className = "cm-item";
    item.setAttribute("data-cm-id", c.id || "");

    var av = avatarNode(c);

    var body = document.createElement("div");
    body.className = "cm-body";

    var meta = document.createElement("div");
    meta.className = "cm-meta";

    // 只认 http/https：数据文件是手改的，里面万一混进 javascript: 也别让它变成链接
    var nameEl;
    if (c.website && /^https?:\/\//i.test(c.website)) {
      nameEl = document.createElement("a");
      nameEl.href = c.website;
      nameEl.rel = "nofollow ugc noopener noreferrer";
      nameEl.target = "_blank";
    } else {
      nameEl = document.createElement("span");
    }
    nameEl.className = "cm-name";
    nameEl.textContent = c.name || "匿名";

    var timeEl = document.createElement("time");
    timeEl.className = "cm-time";
    timeEl.dateTime = c.created || "";
    timeEl.textContent = relTime(c.created);
    timeEl.title = fullTime(c.created);

    meta.appendChild(nameEl);
    meta.appendChild(timeEl);

    // 回复的不是这一串的根（也就是「回复的回复」），标一句指向谁
    if (replyTo) {
      var toEl = document.createElement("span");
      toEl.className = "cm-reply-to";
      toEl.appendChild(document.createTextNode("回复 "));
      var toName = document.createElement("b");
      toName.textContent = replyTo.name || "匿名";
      toEl.appendChild(toName);
      meta.appendChild(toEl);
    }

    if (c.id) {
      var replyBtn = document.createElement("button");
      replyBtn.type = "button";
      replyBtn.className = "cm-reply";
      replyBtn.setAttribute("data-cm-reply", c.id);
      replyBtn.textContent = "回复";
      meta.appendChild(replyBtn);
    }

    var textEl = document.createElement("div");
    textEl.className = "cm-text";
    textEl.appendChild(linkify(c.content || ""));

    body.appendChild(meta);
    body.appendChild(textEl);

    item.appendChild(av);
    item.appendChild(body);
    return item;
  }

  /* 按回复关系排成两层：根评论按时间往下排，同一串的回复都挂在自己的根
     下面、也按时间排。父级找不到（被删了 / 还在审核）就自己当根 —— 一条
     评论都不会因为父级没了而消失。 */
  function buildTree() {
    var byId = {};
    for (var i = 0; i < state.comments.length; i++) {
      if (state.comments[i].id) byId[state.comments[i].id] = state.comments[i];
    }

    function rootOf(c) {
      var cur = c;
      var hops = 0;
      while (cur.parent && byId[cur.parent] && hops < 20) {
        var next = byId[cur.parent];
        if (next === c) break;          // 数据被改出环了，别转死
        cur = next;
        hops++;
      }
      return cur;
    }

    var roots = [];
    var kids = {};
    for (var j = 0; j < state.comments.length; j++) {
      var c = state.comments[j];
      var r = rootOf(c);
      if (r === c) {
        roots.push(c);
      } else {
        (kids[r.id] = kids[r.id] || []).push(c);
      }
    }
    return { roots: roots, kids: kids, byId: byId };
  }

  function render() {
    listEl.textContent = "";
    if (!state.comments.length) {
      var empty = document.createElement("p");
      empty.className = "cm-empty";
      empty.textContent = "还没有人说话，来坐第一个。";
      listEl.appendChild(empty);
      setCount(0);
      return;
    }

    var tree = buildTree();
    var frag = document.createDocumentFragment();
    for (var i = 0; i < tree.roots.length; i++) {
      var rootComment = tree.roots[i];
      var node = itemNode(rootComment, null);
      var children = tree.kids[rootComment.id] || [];

      if (children.length) {
        var box = document.createElement("div");
        box.className = "cm-replies";
        for (var k = 0; k < children.length; k++) {
          var child = children[k];
          var parent = child.parent ? tree.byId[child.parent] : null;
          // 父级是根就不必再标「回复 @根」，缩进已经说明白了
          box.appendChild(itemNode(child, parent && parent.id !== rootComment.id ? parent : null));
        }
        node.querySelector(".cm-body").appendChild(box);
      }
      frag.appendChild(node);
    }
    listEl.appendChild(frag);
    setCount(state.comments.length);
  }

  function showState(text, isError) {
    listEl.textContent = "";
    var p = document.createElement("p");
    p.className = "cm-state" + (isError ? " is-error" : "");
    p.appendChild(document.createTextNode(text));
    if (isError) {
      var retry = document.createElement("button");
      retry.type = "button";
      retry.className = "cm-retry";
      retry.textContent = "重试";
      retry.addEventListener("click", load);
      p.appendChild(retry);
    }
    listEl.appendChild(p);
  }

  /* 静态直出的内容在列表里（构建时写好的 HTML）。接口成功后才替换它；
     接口失败就留着 —— 读者照样能看评论，只是看不到最新几条。 */
  function hasStatic() {
    return listEl.getAttribute("data-cm-static") === "1";
  }

  function clearNotes() {
    var notes = listEl.querySelectorAll("[data-cm-note]");
    for (var i = 0; i < notes.length; i++) notes[i].parentNode.removeChild(notes[i]);
  }

  function noteStatic(text) {
    clearNotes();
    var p = document.createElement("p");
    p.className = "cm-state is-error";
    p.setAttribute("data-cm-note", "1");
    p.appendChild(document.createTextNode(text + " "));
    var retry = document.createElement("button");
    retry.type = "button";
    retry.className = "cm-retry";
    retry.textContent = "重试";
    retry.addEventListener("click", load);
    p.appendChild(retry);
    listEl.appendChild(p);
  }

  function load() {
    if (state.loading) return;
    state.loading = true;

    var keepStatic = hasStatic();
    clearNotes();
    if (!state.comments.length && !keepStatic) showState("正在读取评论…", false);

    api(cfg.endpoint + "?page=" + encodeURIComponent(cfg.page) + "&limit=" + cfg.limit)
      .then(function (data) {
        state.comments = (data && data.comments) || [];
        // 拿到线上的了，静态那份就可以让位
        listEl.removeAttribute("data-cm-static");
        render();
      })
      .catch(function (err) {
        var msg = err.message || "评论没读出来。";
        if (keepStatic) noteStatic("暂时没连上评论服务，下面是上次构建时的评论。");
        else showState(msg, true);
      })
      .finally(function () {
        state.loading = false;
      });
  }

  /* ----------------------------------------------------------------------
     表单
     ---------------------------------------------------------------------- */
  function field(name) { return form ? form.querySelector('[name="' + name + '"]') : null; }

  function setError(name, message) {
    var input = field(name);
    var box = root.querySelector('[data-cm-err="' + name + '"]');
    if (input) {
      if (message) input.setAttribute("aria-invalid", "true");
      else input.removeAttribute("aria-invalid");
    }
    if (box) {
      box.textContent = message || "";
      box.hidden = !message;
    }
  }

  function clearErrors() {
    ["name", "email", "website", "content"].forEach(function (n) { setError(n, ""); });
  }

  function showStatus(text, kind) {
    if (!statusEl) return;
    statusEl.textContent = text || "";
    statusEl.hidden = !text;
    statusEl.className = "cm-status" + (kind ? " is-" + kind : "");
  }

  function updateCounter() {
    if (!counterEl || !textarea) return;
    var n = textarea.value.length;
    counterEl.textContent = n + " / " + cfg.max;
    counterEl.className = "cm-count" + (n >= cfg.max ? " is-over" : "");
  }

  /* ----------------------------------------------------------------------
     回复
     ---------------------------------------------------------------------- */
  function commentById(id) {
    for (var i = 0; i < state.comments.length; i++) {
      if (state.comments[i].id === id) return state.comments[i];
    }
    return null;
  }

  function startReply(id) {
    var c = commentById(id);
    if (!c || !form) return;
    state.reply = { id: c.id, name: c.name || "匿名" };
    if (replyNameEl) replyNameEl.textContent = state.reply.name;
    if (replyBar) replyBar.hidden = false;
    if (formTitleEl) formTitleEl.textContent = "回复 " + state.reply.name;
    showStatus("", "");
    if (textarea) {
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }
    // 表单在列表下面，点了「回复」得让人看得见光标落在哪儿
    if (form.scrollIntoView) {
      try { form.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
      catch (e) { form.scrollIntoView(false); }
    }
  }

  function cancelReply() {
    state.reply = null;
    if (replyBar) replyBar.hidden = true;
    if (formTitleEl) formTitleEl.textContent = "说两句";
  }

  function collect() {
    return {
      name: (field("name").value || "").trim(),
      email: (field("email").value || "").trim(),
      website: (field("website").value || "").trim(),
      content: (field("content").value || "").trim(),
      company: (field("company").value || "")
    };
  }

  function validate(v) {
    clearErrors();
    var firstBad = null;

    if (!v.name) {
      setError("name", "昵称要填一下。");
      firstBad = firstBad || "name";
    } else if (v.name.length > 40) {
      setError("name", "昵称别超过 40 个字。");
      firstBad = firstBad || "name";
    }

    if (!v.email) {
      setError("email", "邮箱要填一下（不会公开）。");
      firstBad = firstBad || "email";
    } else if (!EMAIL_RE.test(v.email)) {
      setError("email", "邮箱格式看着不对。");
      firstBad = firstBad || "email";
    }

    if (v.website) {
      var probe = v.website.indexOf("://") === -1 ? "https://" + v.website : v.website;
      if (!/^https?:\/\/[^\s/]+\.[^\s/]+/i.test(probe)) {
        setError("website", "网址看着不太对，检查一下。");
        firstBad = firstBad || "website";
      }
    }

    if (!v.content) {
      setError("content", "写两句再发吧。");
      firstBad = firstBad || "content";
    } else if (v.content.length < 2) {
      setError("content", "太短了，多说两个字。");
      firstBad = firstBad || "content";
    }

    if (firstBad) {
      var el = field(firstBad);
      if (el) el.focus();
      return false;
    }
    return true;
  }

  function rememberAuthor(v) {
    store(LS_AUTHOR, JSON.stringify({ name: v.name, email: v.email, website: v.website }));
    store(LS_DRAFT, null);
  }

  function restoreAuthor() {
    var raw = load2(LS_AUTHOR);
    if (raw) {
      try {
        var a = JSON.parse(raw);
        if (a && a.name) field("name").value = a.name;
        if (a && a.email) field("email").value = a.email;
        if (a && a.website) field("website").value = a.website;
      } catch (e) { /* 存的东西坏了就当没有 */ }
    }
    var draft = load2(LS_DRAFT);
    if (draft) {
      textarea.value = draft;
      updateCounter();
    }
  }

  function submit(e) {
    if (e) e.preventDefault();
    if (!form || state.posting) return;

    var v = collect();
    if (!validate(v)) return;

    state.posting = true;
    submitBtn.disabled = true;
    var original = submitBtn.textContent;
    submitBtn.textContent = "发送中…";
    showStatus("", "");

    api(cfg.endpoint, {
      method: "POST",
      body: { page: cfg.page, name: v.name, email: v.email, website: v.website,
              content: v.content, company: v.company,
              parent: state.reply ? state.reply.id : "" }
    }).then(function (data) {
      rememberAuthor(v);
      textarea.value = "";
      updateCounter();

      if (data && data.pending) {
        cancelReply();
        showStatus(data.message || "已提交，等站长过一眼就会显示。", "ok");
        return;
      }
      if (data && data.comment) {
        var wasReply = !!state.reply;
        state.comments.push(data.comment);
        cancelReply();
        render();
        var node = listEl.querySelector('[data-cm-id="' + data.comment.id + '"]');
        if (node) {
          node.classList.add("is-new");
          setTimeout(function () { node.classList.remove("is-new"); }, 1600);
          if (node.scrollIntoView) node.scrollIntoView({ block: "nearest" });
        }
        showStatus(wasReply ? "回复成功。" : "发表成功，谢谢。", "ok");
      }
    }).catch(function (err) {
      showStatus(err.message || "没发出去，稍后再试。", "err");
    }).finally(function () {
      state.posting = false;
      submitBtn.disabled = false;
      submitBtn.textContent = original;
    });
  }

  function bindForm() {
    if (!form) return;
    restoreAuthor();
    updateCounter();

    form.addEventListener("submit", submit);

    ["name", "email", "website", "content"].forEach(function (n) {
      var el = field(n);
      if (!el) return;
      el.addEventListener("input", function () {
        if (el.getAttribute("aria-invalid") === "true") setError(n, "");
        if (n === "content") {
          updateCounter();
          if (textarea.value.trim()) store(LS_DRAFT, textarea.value);
          else store(LS_DRAFT, null);
        }
      });
      // 失焦时顺手纠一个明显的错，别等按发送才说
      el.addEventListener("blur", function () {
        if (n === "email" && el.value.trim() && !EMAIL_RE.test(el.value.trim())) {
          setError("email", "邮箱格式看着不对。");
        }
      });
    });

    if (textarea) {
      textarea.addEventListener("keydown", function (ev) {
        if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") {
          ev.preventDefault();
          submit();
        }
        // Esc 退出「回复某人」，回到普通发言
        if (ev.key === "Escape" && state.reply) {
          ev.preventDefault();
          cancelReply();
        }
      });
    }

    if (cancelReplyBtn) {
      cancelReplyBtn.addEventListener("click", function () {
        cancelReply();
        if (textarea) textarea.focus();
      });
    }

    // 列表是每次渲染整块重建的，所以「回复」按钮用事件委托挂在容器上
    listEl.addEventListener("click", function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest("[data-cm-reply]") : null;
      if (!btn) return;
      ev.preventDefault();
      startReply(btn.getAttribute("data-cm-reply"));
    });
  }

  /* ----------------------------------------------------------------------
     启动：等「评论」标签真的被选中再拉数据
     ---------------------------------------------------------------------- */
  function whenShown(cb) {
    var radio = document.getElementById("ct-comments");
    if (root.offsetParent !== null || !radio) {
      cb();
      return;
    }
    if (radio.checked) {
      cb();
      return;
    }
    var on = function () {
      if (radio.checked) {
        radio.removeEventListener("change", on);
        cb();
      }
    };
    radio.addEventListener("change", on);
  }

  bindForm();
  whenShown(load);
})();
