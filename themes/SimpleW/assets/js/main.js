/* ==========================================================================
   SimpleW — main.js
   Deliberately tiny: no framework, no dependencies.
   ========================================================================== */
(function () {
  "use strict";

  var STORAGE_KEY = "simplew-scheme";
  var root = document.documentElement;

  /* ----------------------------------------------------------------------
     1. Theme toggle
     Only rendered when params.colorScheme = "auto", but the logic is a no-op
     when the button is absent.
     ---------------------------------------------------------------------- */
  function currentScheme() {
    return root.dataset.theme === "dark" ? "dark" : "light";
  }

  function paint(scheme) {
    root.dataset.theme = scheme;
    document.querySelectorAll("[data-theme-toggle]").forEach(function (btn) {
      btn.textContent = scheme === "dark" ? "\u25D0" : "\u25D1";
      btn.setAttribute("aria-pressed", scheme === "dark" ? "true" : "false");
    });
  }

  function store(scheme) {
    try {
      window.localStorage.setItem(STORAGE_KEY, scheme);
    } catch (e) {
      /* private mode — the toggle still works, it just will not persist */
    }
  }

  function readStored() {
    try {
      var v = window.localStorage.getItem(STORAGE_KEY);
      return v === "dark" || v === "light" ? v : null;
    } catch (e) {
      return null;
    }
  }

  document.addEventListener("click", function (ev) {
    var btn = ev.target.closest("[data-theme-toggle]");
    if (!btn) return;
    var next = currentScheme() === "dark" ? "light" : "dark";
    paint(next);
    store(next);
  });

  /* Follow the OS while the visitor has not made an explicit choice. */
  if (window.matchMedia) {
    var mq = window.matchMedia("(prefers-color-scheme: dark)");
    var onChange = function (e) {
      if (readStored()) return;
      paint(e.matches ? "dark" : "light");
    };
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  paint(currentScheme());

  /* Wide tables and external-link attributes are handled in CSS / render hooks.
     Keeping those concerns out of JavaScript makes the page usable before this
     file loads and avoids two implementations drifting apart. */

  /* ----------------------------------------------------------------------
     2. Article TOC scrollspy
     Keep the right-hand directory focused on the heading nearest the top.
     ---------------------------------------------------------------------- */
  document.querySelectorAll("[data-scrollspy]").forEach(function (toc) {
    var links = Array.prototype.slice.call(toc.querySelectorAll("a[href^='#']"));
    var items = links.map(function (link) {
      var hash = link.getAttribute("href").slice(1);
      var id;
      try {
        id = decodeURIComponent(hash);
      } catch (e) {
        id = hash;
      }
      return { link: link, heading: document.getElementById(id) };
    }).filter(function (item) {
      return item.heading;
    });

    if (!items.length) return;

    var activeLink = null;
    var ticking = false;

    /* 长目录要跟着读的位置走。
       《医家千字文注》这种页面有上百个标题，目录被 max-height 截断后内部
       自己能滚，但页面往下滚时目录是钉住的 —— 正在读的那一节早就跑出可视
       区了，高亮也看不见。这里在切换高亮项时把它拉回目录可视区。
       带 overflow 的是 .toc 自己（CSS 给它 max-height + overflow:auto），
       而不是外层的 .post-toc 浮层。 */
    var box = toc.querySelector(".toc") || toc;
    var holdFollow = false;

    function revealInBox(link) {
      if (holdFollow || !box) return;
      if (box.scrollHeight <= box.clientHeight + 4) return; // 没溢出就别动它
      var linkTop = link.getBoundingClientRect().top;
      var boxTop = box.getBoundingClientRect().top;
      var view = box.clientHeight;
      var margin = view * 0.25; // 上下都留点上下文，别把当前项贴到边上
      var delta = linkTop - boxTop;
      if (delta < margin || delta > view - margin) {
        box.scrollTop += delta - margin;
      }
    }

    function activate(link) {
      if (activeLink === link) return;
      links.forEach(function (candidate) {
        candidate.classList.toggle("is-active", candidate === link);
        if (candidate === link) candidate.setAttribute("aria-current", "location");
        else candidate.removeAttribute("aria-current");
      });
      activeLink = link;
      revealInBox(link);
    }

    function updateActiveHeading() {
      var marker = window.scrollY + Math.min(180, window.innerHeight * 0.22);
      var current = items[0];
      items.forEach(function (item) {
        if (item.heading.offsetTop <= marker) current = item;
      });
      activate(current.link);
      ticking = false;
    }

    function requestUpdate() {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(updateActiveHeading);
    }

    /* 鼠标/键盘落到目录里时把滚动权交回用户 —— 否则刚滚到想看的条目
       就被自动跟随拽走了。离开目录后恢复跟随。 */
    toc.addEventListener("mouseenter", function () { holdFollow = true; });
    toc.addEventListener("mouseleave", function () { holdFollow = false; });
    toc.addEventListener("focusin", function () { holdFollow = true; });
    toc.addEventListener("focusout", function () { holdFollow = false; });

    links.forEach(function (link) {
      link.addEventListener("click", function () {
        activate(link);
      });
    });
    var header = document.getElementById("top");

    /* 目录吸顶后离视口顶端多远。
       只有当顶栏真的固定在顶上（params.header.sticky = true）时才需要躲开它；
       本站顶栏是普通流里的（sticky = false），滚动时它就跟着页面走了，
       那时目录应该直接贴到最上边 —— 只留一点点呼吸，不留一整条顶栏的高度。
       否则目录会一直悬在半空，跟顶部隔着一个「顶栏」的空白。 */
    function syncTop() {
      var gap = 10;
      if (header) {
        var pos = window.getComputedStyle(header).position;
        if (pos === "sticky" || pos === "fixed") {
          gap = header.offsetHeight + 20;
        }
      }
      document.documentElement.style.setProperty("--toc-offset", gap + "px");
    }

    window.addEventListener("scroll", requestUpdate, { passive: true });
    window.addEventListener("resize", requestUpdate);
    window.addEventListener("resize", syncTop);
    window.addEventListener("load", syncTop);
    syncTop();
    updateActiveHeading();
  });

  /* TOC positioning stays in CSS:
        .post-toc 是铺满整篇文章高度的绝对定位浮层，里面的 .toc 用
        position:sticky 吸在 --toc-offset（顶栏下方）。滚动时目录到顶
        就不再动，一直跟到文章末尾。脚本不再插手，避免两套定位逻辑
        互相打架（曾用 JS 切成 fixed，出入边界时会跳一下）。
     ---------------------------------------------------------------------- */

  /* ----------------------------------------------------------------------
     3. Calendar heatmap — mouse and keyboard activate the selected day.
     The compact row list remains the complete text alternative below it.
     ---------------------------------------------------------------------- */
  document.querySelectorAll(".listing-calendar .heat-day[data-href]").forEach(function (cell) {
    function openDay() {
      var href = cell.getAttribute("data-href");
      if (href) window.location.href = href;
    }

    cell.addEventListener("click", openDay);
    cell.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        openDay();
      }
    });
  });
})();
