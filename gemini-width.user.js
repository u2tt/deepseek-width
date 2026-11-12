// ==UserScript==
// @name         Gemini 内容宽度调节
// @name:en      Gemini Content Width Tuner
// @namespace    https://github.com/u2tt/gemini-width
// @version      1.0.1
// @description  按相对比例调节 Gemini 网页端对话列与输入框的宽度（随浏览器窗口自适应），面板不常驻，从油猴菜单打开设置
// @description:en Tune the conversation column and input box width of Gemini by a relative percentage that follows the window size. No resident panel — open settings from the userscript menu.
// @author       chenxinyu
// @license      MIT
// @homepageURL  https://github.com/u2tt/gemini-width
// @supportURL   https://github.com/u2tt/gemini-width/issues
// @match        *://gemini.google.com/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    var CFG = {
        storeKey: 'gw.width.state.v1',
        cls: 'gw-on',
        hostId: 'gw-host',
        styleId: 'gw-style',
        min: 30,
        max: 100,
        def: 100,
        // Gemini 原生输入框上限 760px；比例 100% 就等于它，页面回到原样。
        maxCol: 760,
        // 侧栏宽度（展开态）。折叠态由 measureSidebar() 实测覆盖。
        sbW: 288,
        // 自测用：模拟"浏览器窗口变化"的事件名（真窗口变化走 resize）。
        event: 'gw:resize'
    };

    var state = { pct: CFG.def };
    var host = null;
    var root = null;
    var els = {};
    var themeDark = true;
    var sbPx = CFG.sbW;
    var resizeRaf = 0;

    /* ================= 状态存取 ================= */

    function clampPct(v) {
        v = Math.round(Number(v));
        if (!isFinite(v)) v = CFG.def;
        return Math.min(CFG.max, Math.max(CFG.min, v));
    }

    function loadState() {
        var raw = '';
        try {
            if (typeof GM_getValue === 'function') raw = GM_getValue(CFG.storeKey, '') || '';
            else raw = window.localStorage.getItem(CFG.storeKey) || '';
        } catch (e) { raw = ''; }
        if (!raw) return;
        try {
            var o = JSON.parse(raw);
            if (o && typeof o.pct === 'number') state.pct = clampPct(o.pct);
        } catch (e) {}
    }

    function saveState() {
        var raw;
        try { raw = JSON.stringify(state); } catch (e) { return; }
        try {
            if (typeof GM_setValue === 'function') GM_setValue(CFG.storeKey, raw);
            else window.localStorage.setItem(CFG.storeKey, raw);
        } catch (e) {}
    }

    /* ================= 样式规则 =================
       三条结构事实（2026-11 在 gemini.google.com 真实页面实测）：
       1. 消息与零态首页都挂在 chat-window > .chat-container 里，chat-window 是
          display:flex、justify-content:center 的行容器——所以把 .chat-container
          居中要靠「宽度 + 左右 auto 外边距」，它自己会用 justify-content 居中。
       2. 输入框 .input-area-container 原生是 position:absolute + transform，
          宽度被 660px 的上限锁死；必须改成 position:static 才吃得到父级居中，
          再由 input-container 的 align-items:center 把它拉到正中。
       3. 全部宽度用 vw 计算：浏览器窗口一变，列宽自动跟着变，不需要脚本重算。
    */
    function styleText() {
        var col = 'calc((100vw - var(--gw-sb,288px)) * var(--gw-k,1))';
        return [
            'html.' + CFG.cls + ' chat-window{justify-content:center!important}',
            'html.' + CFG.cls + ' .chat-container{width:100%!important;' +
                'max-width:' + col + '!important;' +
                'margin-left:auto!important;margin-right:auto!important;box-sizing:border-box!important}',
            'html.' + CFG.cls + ' .input-area-container{width:calc(var(--gw-k,1) * ' + CFG.maxCol + 'px)!important;' +
                'max-width:' + CFG.maxCol + 'px!important;position:static!important;' +
                'top:auto!important;bottom:auto!important;margin:0!important;transform:none!important;' +
                'box-sizing:border-box!important}',
            'html.' + CFG.cls + ' input-container{display:flex!important;flex-direction:column!important;' +
                'align-items:center!important}',
            'html.' + CFG.cls + ' hallucination-disclaimer{width:' + col + '!important;' +
                'max-width:' + CFG.maxCol + 'px!important;box-sizing:border-box!important}'
        ].join('\n');
    }

    function injectStyle() {
        var st = document.getElementById(CFG.styleId);
        if (!st) {
            st = document.createElement('style');
            st.id = CFG.styleId;
            var head = document.head || document.documentElement;
            if (!head) return;
            head.appendChild(st);
        }
        st.textContent = styleText();
    }

    function applyVar() {
        var de = document.documentElement;
        if (!de) return;
        de.style.setProperty('--gw-k', String(state.pct / 100));
        de.style.setProperty('--gw-sb', sbPx + 'px');
    }

    // 覆盖总开关：摘掉它就回到 Gemini 原生宽度。
    function setOn(on) {
        var de = document.documentElement;
        if (!de || !de.classList) return;
        if (on) de.classList.add(CFG.cls);
        else de.classList.remove(CFG.cls);
    }

    /* ================= 侧栏宽度 ================= */
    // 侧栏展开 288px、折叠 52px，收起之后内容区跟着变宽。
    // 不实测的话，折叠状态下所有列都会整体右偏。
    function measureSidebar() {
        var nav = document.querySelector('bard-sidenav');
        if (!nav) return;
        var w = 0;
        try { w = nav.getBoundingClientRect().width || 0; } catch (e) { w = 0; }
        // 面板隐藏或侧栏还没布局时量到 0，保留上一次的值，避免列宽跟着跳成满宽。
        if (!(w > 0 && w < window.innerWidth * 0.6)) return;
        w = Math.round(w);
        if (w === sbPx) return;
        sbPx = w;
        if (isOn()) applyVar();
    }

    function isOn() {
        var de = document.documentElement;
        return !!(de && de.classList && de.classList.contains(CFG.cls));
    }
    /* ================= 面板 ================= */

    // 面板 DOM 全部用 createElement 搭出来。Gemini 启用了 Trusted Types，
    // shadowRoot.innerHTML 会直接抛「This document requires 'TrustedHTML' assignment」。
    var PANEL_CSS = [
        '*{box-sizing:border-box;margin:0;padding:0}',
        '.wrap{all:initial;display:block;box-sizing:border-box;width:268px;overflow:hidden;',
        '  font:400 12px/1.45 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;',
        '  color:var(--fg);background:var(--bg);border:1px solid var(--bd);border-radius:12px;',
        '  box-shadow:0 8px 28px rgba(0,0,0,.3);-webkit-backdrop-filter:saturate(180%) blur(16px);',
        '  backdrop-filter:saturate(180%) blur(16px);user-select:none;-webkit-user-select:none}',
        '.bar{display:flex;align-items:center;gap:7px;padding:9px 8px 9px 11px;cursor:grab}',
        '.bar:active{cursor:grabbing}',
        '.dot{width:7px;height:7px;border-radius:50%;background:var(--acc);flex:none}',
        '.ttl{font-size:12px;font-weight:600;letter-spacing:.2px;white-space:nowrap}',
        '.val{margin-left:auto;font-size:12px;font-weight:600;color:var(--acc);',
        '  font-variant-numeric:tabular-nums;white-space:nowrap}',
        '.x{width:22px;height:22px;flex:none;border:0;border-radius:6px;background:transparent;',
        '  color:var(--sub);font:400 14px/1 sans-serif;cursor:pointer}',
        '.x:hover{background:var(--btnh);color:var(--fg)}',
        '.body{padding:0 11px 11px}',
        'input[type=range]{-webkit-appearance:none;appearance:none;display:block;width:100%;height:20px;',
        '  background:transparent;outline:none;cursor:pointer}',
        'input[type=range]::-webkit-slider-runnable-track{height:4px;border-radius:2px;background:var(--trk)}',
        'input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;',
        '  margin-top:-5px;border-radius:50%;background:var(--acc);border:2px solid var(--thumbbd);',
        '  box-shadow:0 1px 4px rgba(0,0,0,.35)}',
        'input[type=range]:focus-visible::-webkit-slider-thumb{box-shadow:0 0 0 4px var(--focus)}',
        '.quick{display:flex;gap:6px;margin-top:8px}',
        '.quick button{flex:1;height:26px;border:1px solid var(--bd);border-radius:7px;background:var(--btn);',
        '  color:var(--fg);font:400 11px/1 inherit;cursor:pointer}',
        '.quick button:hover{background:var(--btnh)}',
        '.quick button[data-on="1"]{background:var(--acc);border-color:var(--acc);color:#fff}',
        '.act{margin-top:8px;display:flex;gap:6px}',
        '.act button{flex:1;height:26px;border:1px solid var(--bd);border-radius:7px;background:var(--btn);',
        '  color:var(--fg);font:400 11px/1 inherit;cursor:pointer}',
        '.act button:hover{background:var(--btnh)}',
        '.tip{margin-top:8px;font-size:10px;color:var(--sub);line-height:1.5}',
        'b{color:var(--fg);font-weight:600;opacity:.85}'
    ].join('\n');

    // 只在需要时用 Trusted Types 策略生成 HTML，用不到就不建。
    function htmlToNode(html) {
        var tt = window.trustedTypes;
        if (tt && tt.createPolicy) {
            try {
                var p = tt.createPolicy('gw-html', { createHTML: function (s) { return s; } });
                html = p.createHTML(html);
            } catch (e) {}
        }
        var box = document.createElement('div');
        box.innerHTML = html;
        return box;
    }

    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
    }

    function buildPanelDom(sh) {
        var st = document.createElement('style');
        st.textContent = PANEL_CSS;
        sh.appendChild(st);

        var wrap = el('div', 'wrap');
        wrap.id = 'wrap';
        var bar = el('div', 'bar');
        bar.id = 'bar';
        var val = el('span', 'val', '100%');
        val.id = 'val';
        var close = el('button', 'x', '×');
        close.id = 'close';
        close.title = '关闭 (Esc)';
        bar.appendChild(el('span', 'dot'));
        bar.appendChild(el('span', 'ttl', '内容宽度'));
        bar.appendChild(val);
        bar.appendChild(close);

        var body = el('div', 'body');
        body.id = 'body';
        var range = document.createElement('input');
        range.id = 'range';
        range.type = 'range';
        range.min = String(CFG.min);
        range.max = String(CFG.max);
        range.step = '1';
        range.value = String(CFG.def);

        var quick = el('div', 'quick');
        quick.id = 'quick';
        var qs = [['100', '满宽'], ['90', '90%'], ['75', '75%'], ['60', '60%'], ['native', '原生']];
        for (var i = 0; i < qs.length; i++) {
            var b = el('button', null, qs[i][1]);
            b.setAttribute('data-pct', qs[i][0]);
            quick.appendChild(b);
        }

        var act = el('div', 'act');
        var mb = el('button', null, '重新测量侧栏');
        mb.id = 'btn-measure';
        act.appendChild(mb);

        var tip = el('div', 'tip');
        tip.id = 'tip';
        tip.appendChild(el('b', null, '滚轮微调 · 拖标题移动'));

        body.appendChild(range);
        body.appendChild(quick);
        body.appendChild(act);
        body.appendChild(tip);
        wrap.appendChild(bar);
        wrap.appendChild(body);
        sh.appendChild(wrap);
        return { wrap: wrap, bar: bar, val: val, range: range, tip: tip, close: close, quick: quick, measure: mb };
    }

    function detectTheme() {
        try {
            var de = document.documentElement;
            var flag = (de.getAttribute('data-theme') || '') + ' ' +
                (de.getAttribute('class') || '') + ' ' +
                ((document.body && document.body.getAttribute('class')) || '');
            if (/dark/i.test(flag)) return true;
            if (/light/i.test(flag)) return false;
            var bg = window.getComputedStyle(document.body || de).backgroundColor || '';
            var m = bg.match(/rgba?\(([^)]+)\)/);
            if (m) {
                var parts = m[1].split(',');
                var a = parts.length > 3 ? parseFloat(parts[3]) : 1;
                if (a > 0.2) {
                    var lum = (0.2126 * parseFloat(parts[0]) + 0.7152 * parseFloat(parts[1]) + 0.0722 * parseFloat(parts[2])) / 255;
                    return lum < 0.5;
                }
            }
            return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
        } catch (e) { return true; }
    }

    function refreshTheme() {
        themeDark = detectTheme();
        if (!els.wrap) return;
        var t = themeDark ? {
            bg: 'rgba(30,31,34,.94)', fg: '#e6e8eb', sub: '#9aa0a6', bd: 'rgba(255,255,255,.12)',
            btn: 'rgba(255,255,255,.06)', btnh: 'rgba(255,255,255,.14)', trk: 'rgba(255,255,255,.18)',
            thumbbd: '#1e1f22', focus: 'rgba(77,107,254,.35)'
        } : {
            bg: 'rgba(255,255,255,.97)', fg: '#1f2329', sub: '#6b7280', bd: 'rgba(0,0,0,.10)',
            btn: 'rgba(0,0,0,.04)', btnh: 'rgba(0,0,0,.09)', trk: 'rgba(0,0,0,.14)',
            thumbbd: '#ffffff', focus: 'rgba(77,107,254,.28)'
        };
        t.acc = '#4d6bfe';
        for (var k in t) els.wrap.style.setProperty('--' + k, t[k]);
    }

    function buildPanel() {
        if (host || !document.body) return;
        host = document.createElement('div');
        host.id = CFG.hostId;
        // 面板不常驻：建好先藏着，由菜单/快捷键打开。
        host.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483646;display:none;';
        root = host.attachShadow({ mode: 'open' });
        // Trusted Types 下 shadowRoot 不允许 innerHTML 赋值，DOM 逐个创建。
        els = buildPanelDom(root);
        document.body.appendChild(host);

        els.range.addEventListener('input', function (e) { setPctLive(e.target.value); });
        els.range.addEventListener('change', function (e) { setPctLive(e.target.value); });
        els.close.addEventListener('click', function (e) { e.stopPropagation(); closePanel(); });
        els.measure.addEventListener('click', function (e) {
            e.stopPropagation();
            remeasure(true);
        });
        els.quick.addEventListener('click', function (e) {
            var b = e.target && e.target.closest ? e.target.closest('button') : null;
            if (!b) return;
            e.stopPropagation();
            var v = b.getAttribute('data-pct');
            if (v === 'native') setNative();
            else setPct(v);
        });
        host.addEventListener('wheel', onWheel, { passive: false });
        makeDraggable();
        refreshTheme();
    }

    function onWheel(e) {
        if (!host || host.style.display === 'none') return;
        e.preventDefault();
        var step = e.shiftKey ? 10 : (e.altKey ? 5 : 1);
        setPctLive(state.pct + (e.deltaY < 0 ? step : -step));
    }

    // 设置面板：默认不显示，从油猴菜单或 Alt+Shift+W 打开，× 或 Esc 关闭。
    function openPanel() {
        if (!document.body) return;
        if (!host) buildPanel();
        if (!host) return;
        host.style.display = 'block';
        refreshTheme();
        syncUI();
    }

    function closePanel() {
        if (host) host.style.display = 'none';
    }

    function togglePanel() {
        if (host && host.style.display !== 'none') closePanel();
        else openPanel();
    }

    function makeDraggable() {
        var sx = 0, sy = 0, ox = 0, oy = 0, moved = 0, dragging = false;

        function onMove(e) {
            if (!dragging) return;
            var dx = e.clientX - sx;
            var dy = e.clientY - sy;
            moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
            if (moved <= 3) return;
            var w = host.getBoundingClientRect().width || 268;
            var left = Math.min(Math.max(ox + dx, 4), window.innerWidth - w - 4);
            var top = Math.min(Math.max(oy + dy, 4), window.innerHeight - 44);
            host.style.left = left + 'px';
            host.style.top = top + 'px';
            host.style.right = 'auto';
            host.style.bottom = 'auto';
        }

        function onUp() {
            document.removeEventListener('mousemove', onMove, true);
            document.removeEventListener('mouseup', onUp, true);
            dragging = false;
        }

        els.bar.addEventListener('mousedown', function (e) {
            if (e.button !== 0) return;
            if (e.target && e.target.closest && e.target.closest('.x')) return;
            var r = host.getBoundingClientRect();
            dragging = true;
            moved = 0;
            sx = e.clientX;
            sy = e.clientY;
            ox = r.left;
            oy = r.top;
            e.preventDefault();
            document.addEventListener('mousemove', onMove, true);
            document.addEventListener('mouseup', onUp, true);
        });
    }

    /* ================= 交互 ================= */

    var liveFrame = 0;
    var liveDirty = false;
    var liveSaveTimer = 0;

    function syncUI() {
        if (!els.val) return;
        els.val.textContent = isOn() ? (state.pct + '%') : '原生';
        els.range.value = String(state.pct);
        var btns = els.quick.getElementsByTagName('button');
        for (var i = 0; i < btns.length; i++) {
            var v = btns[i].getAttribute('data-pct');
            var on = (v === 'native') ? !isOn() : (isOn() && String(state.pct) === v);
            if (on) btns[i].setAttribute('data-on', '1');
            else btns[i].removeAttribute('data-on');
        }
        if (els.tip) {
            els.tip.innerHTML = '<b>滚轮微调 · 拖标题移动</b>　侧栏 ' + sbPx + 'px';
        }
    }

    // 滑块/滚轮：同一帧里多次变化只改一次 CSS 变量，状态存盘放到手势停下之后。
    function setPctLive(v) {
        state.pct = clampPct(v);
        setOn(true);
        liveDirty = true;
        if (liveFrame) return;
        liveFrame = window.setTimeout(function () {
            liveFrame = 0;
            if (!liveDirty) return;
            liveDirty = false;
            applyVar();
            syncUI();
        }, 16);
        if (liveSaveTimer) window.clearTimeout(liveSaveTimer);
        liveSaveTimer = window.setTimeout(function () { liveSaveTimer = 0; saveState(); }, 320);
    }

    function setPct(v) {
        state.pct = clampPct(v);
        setOn(true);
        measureSidebar();
        applyVar();
        syncUI();
        saveState();
    }

    function setNative() {
        setOn(false);
        syncUI();
        saveState();
    }

    function remeasure(force) {
        if (force) sbPx = 0;
        measureSidebar();
        if (!sbPx) sbPx = CFG.sbW;
        applyVar();
        syncUI();
    }

    /* ================= 启动 ================= */

    function boot() {
        loadState();
        injectStyle();
        setOn(true);
        remeasure(false);
        syncUI();
    }

    boot();
    window.addEventListener('resize', function () {
        if (resizeRaf) return;
        resizeRaf = window.requestAnimationFrame(function () {
            resizeRaf = 0;
            measureSidebar();
            injectStyle();
        });
    });
    window.addEventListener('DOMContentLoaded', boot, { once: true });
    window.addEventListener('load', function () { measureSidebar(); injectStyle(); }, { once: true });
    // Gemini 是 SPA：换会话、开关侧栏、进入设置都会重排，定期复查侧栏宽度与样式表是否还在。
    window.setInterval(function () {
        measureSidebar();
        if (!document.getElementById(CFG.styleId)) injectStyle();
    }, 1200);
    // 菜单项只有一条：打开设置面板。其余操作都在面板里。
    try {
        if (typeof GM_registerMenuCommand === 'function') {
            GM_registerMenuCommand('⚙ 打开设置面板', openPanel);
        }
    } catch (e) {}

    document.addEventListener('keydown', function (e) {
        if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && (e.key === 'W' || e.key === 'w' || e.code === 'KeyW')) {
            e.preventDefault();
            togglePanel();
        } else if (e.key === 'Escape' && host && host.style.display !== 'none') {
            closePanel();
        }
    }, true);

    // 模拟窗口变化的测试钩子：只改 vw 的值，列宽应自动跟着变，无需重算。
    window.addEventListener(CFG.event, function () {
        injectStyle();
        applyVar();
        syncUI();
    });
})();