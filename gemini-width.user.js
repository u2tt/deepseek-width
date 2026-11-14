// ==UserScript==
// @name         Gemini 内容宽度调节
// @name:en      Gemini Content Width Tuner
// @namespace    https://github.com/u2tt/gemini-width
// @version      2.0.3
// @description  按相对比例调节 Gemini 网页端整列内容的宽度（对话、回答、输入框、免责声明一起收窄并居中，随窗口自适应），设置面板从油猴菜单打开
// @description:en Tune the whole content column of Gemini (conversation, answers, input box, disclaimer) by a relative percentage that follows the window size. Open settings from the userscript menu.
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
        // 输入框自身的宽度上限（Gemini 原生值），不随比例缩放。
        maxCol: 660,
        // 自测用：模拟"浏览器窗口变化"的事件名（真窗口变化走 resize）。
        event: 'gw:resize'
    };

    // on=false 表示回到 Gemini 原生宽度（面板上的「原生」）。
    var state = { pct: CFG.def, on: true };
    var host = null;
    var root = null;
    var els = {};
    var themeDark = true;
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
            if (o && typeof o.on === 'boolean') state.on = o.on;
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
       结构事实（2026-11 在 gemini.google.com 真实页面实测 + 用户导出的完整 DOM 核对）：
       1. 侧栏 bard-sidenav 是 flex 兄弟项，占掉 288px（折叠 52px）；内容区
          bard-sidenav-content 的宽度就是「窗口宽 - 侧栏宽」，它不受 chat-window 影响。
       2. chat-window 是内容区里唯一的宽度承载层（780 行的零态/对话都挂在它下面）。
          直接给它 width 百分比会因为「子元素最小内容宽度」撑回去，所以改成
          bard-sidenav-content 当容器查询容器，chat-window 写 Ncqw —— cqw 只跟
          容器自身的宽度算，不会被内容撑大。
       3. 输入框 .input-area-container 原生 position:absolute、宽 660px 上限，
          input-container 是 flex 列容器。改成 static 之后由 input-container 居中，
          提示条 hallucination-disclaimer 也走同一套居中。
       4. 100% 就是 Gemini 原生宽度，之后只收窄，不再出现"只动输入框"的错位。
    */
    function styleText() {
        var cls = 'html.' + CFG.cls;
        return [
            // 主体：chat-window 自己的宽度 = 内容区 x 比例，水平居中，两侧留白
            // 比例必须是纯数字（0~1）再乘 100%：cqw 只在容器里成立，一旦内容区不是
            // chat-window 的包含块（成为高度受限的 flex 子项），cqw 与百分比一起失效，
            // 整列被撑成一条窄缝（已实测）。calc(比例 x 100%) 只依赖包含块宽度。
            cls + ' chat-window{flex:none!important;width:calc(var(--gw-k,1) * 100%)!important;max-width:none!important;' +
                'margin-left:auto!important;margin-right:auto!important;box-sizing:border-box!important}',

            // chat-container = chat-window 内部满宽
            cls + ' .chat-container{width:100%!important;max-width:100%!important;' +
                'margin-left:auto!important;margin-right:auto!important;box-sizing:border-box!important}',

            // 历史列表：外层容器原生的 max-width（约 724px）会锁死内部列，
            // 这里放开到 100%，列宽由 chat-window 决定。
            cls + ' chat-window .chat-history-scroll-container{width:100%!important;max-width:100%!important}',
            cls + ' chat-window infinite-scroller.chat-history{width:100%!important}',

            // 提问气泡 / 回答正文：原生 708px 上限；100% 时与原生一致（708 宽 + 16px 边距）
            cls + ' chat-window .conversation-container{max-width:100%!important;width:100%!important;' +
                'margin-left:0!important;margin-right:0!important;align-items:stretch!important}',
            cls + ' chat-window .conversation-container > user-query{max-width:100%!important;width:100%!important;' +
                'margin-left:0!important;margin-right:0!important}',
            cls + ' chat-window .conversation-container model-response{width:100%!important}',
            cls + ' chat-window .conversation-container model-response-disclaimers{max-width:100%!important;width:100%!important;' +
                'margin-inline:0!important}',

            // 输入区：脱离 absolute，交给 input-container 的居中
            cls + ' input-container{display:flex!important;flex-direction:column!important;' +
                'align-items:center!important;width:100%!important}',
            cls + ' .input-area-container{position:static!important;top:auto!important;bottom:auto!important;' +
                'left:auto!important;right:auto!important;margin:0!important;transform:none!important;' +
                'width:min(' + CFG.maxCol + 'px,100%)!important;max-width:' + CFG.maxCol + 'px!important;' +
                'box-sizing:border-box!important}',
            // 回到最新按钮原生是 absolute（不占位），保持，只把它按居中位置摆好
            cls + ' back-to-bottom-fab{position:absolute!important;left:50%!important;' +
                'margin-left:-20px!important;right:auto!important;top:auto!important;bottom:100%!important;' +
                'margin-bottom:8px!important}',

            // 底部免责声明 + 额度告警：与输入框同列居中
            cls + ' hallucination-disclaimer{width:100%!important;max-width:none!important;' +
                'margin-left:auto!important;margin-right:auto!important;box-sizing:border-box!important}',
            cls + ' gxu-usage-warning-disclaimer.above-input-area{width:100%!important;max-width:none!important;' +
                'margin-left:auto!important;margin-right:auto!important;box-sizing:border-box!important}',
            cls + ' .in-conv-flow-bar{max-width:100%!important;margin-left:0!important;margin-right:0!important}'
        ].join('\n');
    }

    function injectStyle() {
        var st = document.getElementById(CFG.styleId);
        if (!st) {
            if (!document.head && !document.documentElement) return;
            st = document.createElement('style');
            st.id = CFG.styleId;
            (document.head || document.documentElement).appendChild(st);
        }
        var css = styleText();
        if (st.textContent !== css) st.textContent = css;
    }

    // 唯一需要写在变量里的动态量：比例（0~1 的纯数字，CSS 里乘 100% 用）。
    // 不用 cqw / 百分比变量：容器查询只在元素是容器的后代时生效，失效时宽度会塌成窄缝。
    function applyVar() {
        var de = document.documentElement;
        if (!de) return;
        var k = state.pct / 100;
        de.style.setProperty('--gw-k', k);
    }

    // 覆盖总开关：摘掉它就回到 Gemini 原生宽度。
    function setOn(on) {
        var de = document.documentElement;
        if (!de || !de.classList) return;
        state.on = !!on;
        if (on) de.classList.add(CFG.cls);
        else de.classList.remove(CFG.cls);
        applyVar();
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

        var tip = el('div', 'tip');
        tip.id = 'tip';
        tip.appendChild(el('b', null, '滚轮微调 · 拖标题移动'));

        body.appendChild(range);
        body.appendChild(quick);
        body.appendChild(tip);
        wrap.appendChild(bar);
        wrap.appendChild(body);
        sh.appendChild(wrap);
        return { wrap: wrap, bar: bar, val: val, range: range, tip: tip, close: close, quick: quick };
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
        syncUI();
        saveState();
    }

    function setNative() {
        state.pct = CFG.def;
        setOn(false);
        syncUI();
        saveState();
    }

    /* ================= 启动 ================= */

    function boot() {
        loadState();
        injectStyle();
        setOn(state.on !== false);
        syncUI();
    }

    boot();
    window.addEventListener('resize', function () {
        if (resizeRaf) return;
        resizeRaf = window.requestAnimationFrame(function () {
            resizeRaf = 0;
            injectStyle();
        });
    });
    window.addEventListener('DOMContentLoaded', boot, { once: true });
    window.addEventListener('load', function () { injectStyle(); }, { once: true });
    // Gemini 是 SPA：换会话、开合侧栏都会重排 head，样式表被换掉时补回去。
    window.setInterval(function () {
        if (!document.getElementById(CFG.styleId)) injectStyle();
    }, 1500);
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

    // 模拟窗口变化的测试钩子。
    window.addEventListener(CFG.event, function () {
        injectStyle();
        applyVar();
        syncUI();
    });
})();