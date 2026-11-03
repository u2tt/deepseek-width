// ==UserScript==
// @name         DeepSeek 内容宽度调节
// @name:en      DeepSeek Content Width Tuner
// @namespace    https://github.com/u2tt/deepseek-width
// @version      2.1.0
// @description  无级调节 DeepSeek 网页端内容宽度（按相对比例缩放、随窗口自适应），可自动收起思考过程；面板不常驻，从油猴菜单打开设置
// @description:en Steplessly tune the content width of chat.deepseek.com by a relative percentage that follows the window size; optionally auto-collapse thinking blocks. No resident panel — open settings from the userscript menu.
// @author       chenxinyu
// @license      MIT
// @homepageURL  https://github.com/u2tt/deepseek-width
// @supportURL   https://github.com/u2tt/deepseek-width/issues
// @match        *://chat.deepseek.com/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    var CFG = {
        storeKey: 'dsw.width.state.v1',
        attr: 'data-dsw-col',
        hostId: 'dsw-host',
        styleId: 'dsw-style',
        min: 30,
        max: 100,
        def: 100,
        uncapAttr: 'data-dsw-uncap',
        // 思考块：站点把「已思考（用时 N 秒）」放在消息的第一个子元素里。
        // 这个标记只用来快速找到块，不再用它做 CSS 隐藏。
        thinkAttr: 'data-dsw-think',
        tiers: [480, 360, 280, 220],
        // 自测用：模拟"浏览器窗口变化"的事件名（真窗口变化走 resize）。
        event: 'dsw:resize'
    };

    var state = { pct: CFG.def, on: true, hideThink: true };
    var host = null;
    var root = null;
    var els = {};
    var themeDark = true;

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
            if (o && typeof o.on === 'boolean') state.on = !!o.on;
            if (o && typeof o.hideThink === 'boolean') state.hideThink = !!o.hideThink;
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

    /* ================= 宽度应用 ================= */

    // 覆盖规则挂在 html.dsw-on 上：识别容器时要先把开关摘掉量原生几何，
    // 量完在同一个任务里挂回去（浏览器不会画出中间状态，所以不会闪）。
    // 不这么做的话，被我们拉宽的那一层就不再满足"居中定宽列"的判定，
    // 下一次重扫会改选别的元素，来回换 → 宽度比例对不上、页面一闪一闪。
    var STYLE_TEXT =
        'html.dsw-on [data-dsw-col]{box-sizing:border-box!important;max-width:none!important;' +
        'width:var(--dsw-pct,100%)!important;padding-left:0!important;padding-right:0!important;' +
        'margin-left:auto!important;margin-right:auto!important;}' +
        'html.dsw-on [data-dsw-uncap]{max-width:none!important;}';

    function injectStyle() {
        if (document.getElementById(CFG.styleId)) return;
        var st = document.createElement('style');
        st.id = CFG.styleId;
        st.textContent = STYLE_TEXT;
        var head = document.head || document.documentElement;
        if (head) head.appendChild(st);
    }

    function applyVar() {
        document.documentElement.style.setProperty('--dsw-pct', state.pct + '%');
    }


    // 覆盖总开关：摘掉它页面就完全回到原生宽度。
    function setOn(on) {
        state.on = !!on;
        var de = document.documentElement;
        if (!de || !de.classList) return;
        if (state.on) de.classList.add('dsw-on');
        else de.classList.remove('dsw-on');
    }

    // ---- 自动收起思考过程 ----
    // 不隐藏内容，而是模拟原版手动点一下标题的效果：只留「已思考（用时 N 秒）›」这一行，
    // 想读的时候点一下照样能展开。折叠动作交给站点自己做（点它的标题行，走它自己的收起逻辑），
    // 脚本不写 display、不写高度，所以样式和展开动画跟原版完全一致。
    var THINK_HEAD = /^(已思考|思考中|正在思考|思考完成|Thought for|Thinking)/i;
    // 还在输出中的思考块不碰：这时站点自己也不允许收起。
    var THINK_STREAM = /^(思考中|正在思考|Thinking)/i;

    // 已经替用户收起过的标题。用 Set 而不是 WeakSet：关开关时要把它们全部展开回去。
    var foldedHeads = new Set();
    // 用户自己点过的块，之后不再动它，免得跟用户抢。
    var userTouched = typeof WeakSet === 'function' ? new WeakSet() : null;
    // 每个标题点过几次、上次点的时间：站点有时还没挂上点击处理，需要重试。
    var foldTry = typeof WeakMap === 'function' ? new WeakMap() : null;

    // 消息里第一个子元素是思考块时返回 { blk, head }，head 是那一行可点的标题。
    function thinkBlocks() {
        var out = [];
        var msgs = document.querySelectorAll('.ds-message');
        for (var i = 0; i < msgs.length; i++) {
            var kids = msgs[i].children;
            // 只有一条子元素时可能是纯思考消息、或者回答还没到，不动，免得把回答藏掉。
            if (kids.length < 2) continue;
            for (var j = 0; j < kids.length && j < 2; j++) {
                var k = kids[j];
                var t = (k.textContent || '').replace(/^\s+/, '');
                if (!t || !THINK_HEAD.test(t)) continue;
                var head = k.firstElementChild;
                if (!head) continue;
                if (!k.hasAttribute(CFG.thinkAttr)) k.setAttribute(CFG.thinkAttr, '');
                out.push({ blk: k, head: head, stream: THINK_STREAM.test(t) });
            }
        }
        return out;
    }

    // 收起后整块只剩标题那一行高，正文子元素高度都是 0。不看类名，只量高度。
    function thinkFolded(b) {
        var kids = b.blk.children, extra = 0;
        for (var i = 0; i < kids.length; i++) {
            if (kids[i] === b.head) continue;
            var h = kids[i].getBoundingClientRect().height;
            if (h > 2) extra += h;
        }
        return extra < 4;
    }

    function clickThinkHead(b, attempt) {
        // 第一次点标题行本身（真实页的点击处理挂在这一层）；还收不起来就退到里面那层文字行再试。
        var t = b.head;
        if (attempt >= 2 && t.firstElementChild) t = t.firstElementChild;
        try { t.click(); return true; } catch (e) { return false; }
    }

    // 收起会让下面的内容整体上移，先记下视口正中那一行，等站点重渲染完再补回来。
    function scheduleFoldFix(anc) {
        if (!anc) return;
        var times = [0, 60, 180, 420, 900];
        for (var i = 0; i < times.length; i++) {
            (function (ms) { setTimeout(function () { fixAnchor(anc, true); }, ms); })(times[i]);
        }
        try { requestAnimationFrame(function () { fixAnchor(anc, true); }); } catch (e) {}
    }

    function pruneFolded() {
        foldedHeads.forEach(function (el) { if (!el.isConnected) foldedHeads.delete(el); });
    }

    // 把还开着的思考块逐个收起来，返回这次收起了几个。
    function foldThink() {
        if (!state.hideThink) return 0;
        var list = thinkBlocks(), n = 0, now = Date.now(), anc = null;
        for (var i = 0; i < list.length; i++) {
            var b = list[i];
            if (userTouched && userTouched.has(b.head)) continue;
            if (thinkFolded(b)) { foldedHeads.add(b.head); continue; }
            if (b.stream) continue;
            var rec = (foldTry && foldTry.get(b.head)) || { n: 0, at: 0 };
            if (rec.n >= 3) continue;
            // 站点重渲染要时间，同一块 700ms 内不重复点，否则点两下又展开回去了。
            if (now - rec.at < 700) continue;
            rec.n++; rec.at = now;
            if (foldTry) foldTry.set(b.head, rec);
            if (!anc) anc = captureAnchor();
            clickThinkHead(b, rec.n);
            foldedHeads.add(b.head);
            n++;
        }
        if (n) scheduleFoldFix(anc);
        pruneFolded();
        return n;
    }

    // 关掉开关时，把脚本收起过的那些展开回去。
    function unfoldThink() {
        var n = 0;
        foldedHeads.forEach(function (head) {
            if (!head.isConnected || !head.parentElement) return;
            var b = { blk: head.parentElement, head: head };
            if (!thinkFolded(b)) return;
            try { head.click(); n++; } catch (e) {}
        });
        foldedHeads.clear();
        return n;
    }

    // 用户自己点过思考块（真机上是 pointerdown，脚本的 .click() 不触发它），之后不再管这一块。
    function watchThinkTouch() {
        document.addEventListener('pointerdown', function (e) {
            var t = e.target;
            if (!t || t.nodeType !== 1 || !t.closest) return;
            var blk = t.closest('[' + CFG.thinkAttr + ']');
            if (!blk) return;
            var head = blk.firstElementChild;
            if (head && userTouched) userTouched.add(head);
        }, true);
    }

    function setHideThink(on) {
        state.hideThink = !!on;
        if (state.hideThink) foldThink();
        else {
            var anc = captureAnchor();
            if (unfoldThink()) scheduleFoldFix(anc);
        }
        saveState();
        syncUI();
    }

    // 摘掉开关 → 跑 fn（这时量到的是原生几何）→ 挂回去。
    // 全在同一个任务里完成，浏览器不会画出中间那一帧。
    function withNativeGeometry(fn) {
        var de = document.documentElement;
        var had = !!(de && de.classList && de.classList.contains('dsw-on'));
        if (had) de.classList.remove('dsw-on');
        try { return fn(); }
        finally { if (had) de.classList.add('dsw-on'); }
    }

    function isPanelNode(el) {
        if (!el || el.nodeType !== 1) return false;
        if (el.id === CFG.hostId) return true;
        try { return !!(el.closest && el.closest('#' + CFG.hostId)); } catch (e) { return false; }
    }

    // 居中弹窗/浮层也常常是"居中定宽"，但它们不该被拉伸，这里排掉。
    function inOverlay(el) {
        var n = el, d = 0;
        while (n && n.nodeType === 1 && d++ < 5) {
            if (n.getAttribute) {
                if (n.getAttribute('aria-modal') === 'true' || n.getAttribute('role') === 'dialog') return true;
            }
            if (window.getComputedStyle(n).position === 'fixed') return true;
            n = n.parentElement;
        }
        return false;
    }

    // 父容器内容盒宽度（clientWidth 去掉左右内边距与滚动条）。
    function parentBox(parent) {
        var pcs = window.getComputedStyle(parent);
        return parent.clientWidth - parseFloat(pcs.paddingLeft) - parseFloat(pcs.paddingRight);
    }

    // 内容列判定：明显窄于父内容盒、且在父内容盒里水平居中的块。
    // 不要求 max-width 是像素值——真实站点常用「定宽 width + 大左右内边距」实现居中列。
    function isColumn(el, min) {
        if (!el || el.nodeType !== 1) return false;
        if (isPanelNode(el)) return false;
        if (el.offsetWidth < min) return false;
        var cs = window.getComputedStyle(el);
        if (cs.position === 'fixed' || cs.position === 'absolute') return false;
        var parent = el.parentElement;
        if (!parent) return false;
        var pbox = parentBox(parent);
        if (!(pbox > 0)) return false;
        if (!(el.offsetWidth < pbox - 8)) return false;
        var er = el.getBoundingClientRect();
        var pr = parent.getBoundingClientRect();
        var pcs = window.getComputedStyle(parent);
        var boxL = pr.left + parseFloat(pcs.borderLeftWidth) + parseFloat(pcs.paddingLeft);
        var boxR = pr.right - parseFloat(pcs.borderRightWidth) - parseFloat(pcs.paddingRight);
        var gapL = er.left - boxL;
        var gapR = boxR - er.right;
        if (Math.abs(gapL - gapR) > Math.max(30, pbox * 0.08)) return false;
        if (inOverlay(el)) return false;
        return true;
    }

    // 先按 480px 阈值找；一个都没找到时逐级放宽。
    // 再按文本量过滤：真实页面里候选会嵌套很多更小的居中块（段落、空容器），
    // 承载内容的那一个文本量远大于其余，用它把噪音剔掉；同宽的兄弟（输入框包裹层）保留。
    function pickCandidates() {
        var all = document.body.getElementsByTagName('*');
        for (var t = 0; t < CFG.tiers.length; t++) {
            var cands = [], i;
            for (i = 0; i < all.length; i++) {
                if (isColumn(all[i], CFG.tiers[t])) cands.push(all[i]);
            }
            if (!cands.length) continue;
            var maxText = 0, k;
            for (k = 0; k < cands.length; k++) {
                var tl = (cands[k].textContent || '').length;
                if (tl > maxText) maxText = tl;
            }
            var strong = [], strongW = [];
            for (k = 0; k < cands.length; k++) {
                if (maxText > 0 && (cands[k].textContent || '').length >= maxText * 0.4) {
                    strong.push(cands[k]);
                    strongW.push(cands[k].offsetWidth);
                }
            }
            if (!strong.length) return cands;
            var keep = [];
            for (k = 0; k < cands.length; k++) {
                if (strong.indexOf(cands[k]) >= 0) { keep.push(cands[k]); continue; }
                for (var m = 0; m < strongW.length; m++) {
                    if (Math.abs(strongW[m] - cands[k].offsetWidth) <= 2) { keep.push(cands[k]); break; }
                }
            }
            return keep.length ? keep : strong;
        }
        return [];
    }

    // 只给最内层命中元素设百分比宽度；它的外层命中元素解除 max-width，
    // 否则外层上限会压低内层可达的最大宽度，且百分比会被层层相乘。
    function mark(cands) {
        // 所有最内层候选都要记下来：以前只记最后一个，dropStaleMarks() 会把其余
        // 已打上的标记当成陈旧标记摘掉，于是正文列和输入框只有其中一个生效。
        var cols = [];
        var uncap = [];
        for (var k = 0; k < cands.length; k++) {
            var el = cands[k];
            var inner = true;
            for (var j = 0; j < cands.length; j++) {
                if (j !== k && el.contains(cands[j])) { inner = false; break; }
            }
            if (!inner) { el.setAttribute(CFG.uncapAttr, ''); uncap.push(el); continue; }
            el.setAttribute(CFG.attr, '');
            cols.push(el);
            // 祖先里还有像素 max-width 的，一并解除，否则内层百分比仍被外层上限压住。
            var p = el.parentElement, d = 0;
            while (p && p.nodeType === 1 && d++ < 8) {
                if (isPanelNode(p)) break;
                var pmw = window.getComputedStyle(p).maxWidth;
                if (pmw && pmw.slice(-2) === 'px') { p.setAttribute(CFG.uncapAttr, ''); uncap.push(p); }
                p = p.parentElement;
            }
        }
        tagCache = cols.length ? { cols: cols, col: cols[0], uncap: uncap } : null;
    }

    // 记住上一次真正打上标记的容器；结构没变就复用它。
    var tagCache = null;
    var lastHref = location.href;

    // 缓存的容器还值不值得信：得仍在文档里、可见、有像样的尺寸，
    // 并且视口中间那几行确实落在它里面。
    // 虚拟列表这类页面会把消息区整个换成新节点，老节点有时仍挂在文档里，
    // 只看 isConnected 会把宽度设到一个已经没人看的容器上，表现就是"拖了没反应"。
    function cachedCols() {
        if (!tagCache || !tagCache.cols || !tagCache.cols.length) return null;
        return tagCache.cols;
    }

    function cacheStillRight() {
        var cols = cachedCols();
        if (!cols) return false;
        for (var k = 0; k < cols.length; k++) {
            var col = cols[k];
            if (!col || !col.isConnected || !document.contains(col)) return false;
            if (isPanelNode(col)) return false;
            var cs;
            try { cs = window.getComputedStyle(col); } catch (e) { return false; }
            if (cs.display === 'none' || cs.visibility === 'hidden') return false;
            if (col.offsetWidth < 120 || col.offsetHeight < 40) return false;
        }
        var ys = [0.5, 0.28, 0.72], hitAny = false, hitSome = false;
        for (var i = 0; i < ys.length; i++) {
            var hit = null;
            try {
                hit = document.elementFromPoint(Math.round(window.innerWidth / 2), Math.round(window.innerHeight * ys[i]));
            } catch (e) { hit = null; }
            if (!hit || hit.nodeType !== 1) continue;
            hitSome = true;
            if (isPanelNode(hit)) { hitAny = true; continue; }
            for (var j = 0; j < cols.length; j++) {
                if (cols[j].contains(hit)) { hitAny = true; break; }
            }
        }
        if (!hitSome) return true;
        return hitAny;
    }

    // 缓存仍在文档里就直接重新打标记。
    // 这样做的原因：老流程是"先解除全部标记再重新识别"，解除的那一瞬间页面会按原生宽度重排，
    // 拖动滑块时每次重扫都会闪一下原生宽度，看起来就是宽度在跳。
    function applyCache() {
        var cols = cachedCols();
        if (!cols) return false;
        var i;
        for (i = 0; i < cols.length; i++) {
            if (!cols[i] || !cols[i].isConnected || !document.contains(cols[i])) { tagCache = null; return false; }
        }
        for (i = 0; i < tagCache.uncap.length; i++) {
            var u = tagCache.uncap[i];
            if (u && cols.indexOf(u) < 0 && u.isConnected && document.contains(u)) u.setAttribute(CFG.uncapAttr, '');
        }
        for (i = 0; i < cols.length; i++) cols[i].setAttribute(CFG.attr, '');
        // 旧结构留下的、这次缓存里没有的标记要摘掉，否则两边同时被覆盖。
        dropStaleMarks();
        return true;
    }

    function scan() {
        // 思考块和宽度无关，恢复原生宽度时也要继续收起。
        if (state.hideThink) foldThink();
        if (!state.on) return count();
        if (!document.body) return 0;
        // 切换会话/分享页后旧容器可能还挂在文档里，路由器一换就得重新识别。
        if (location.href !== lastHref) { lastHref = location.href; tagCache = null; untagAll(); }
        withNativeGeometry(function () {
            if (cacheStillRight() && applyCache()) return;
            var cands = pickCandidates();
            // 一个候选都没识别到就保持现状：先摘标记再找会让页面按原生宽度重排一下。
            if (!cands || !cands.length) return;
            // 先打新标记再摘旧标记：反过来也会闪一下。
            mark(cands);
            dropStaleMarks();
        });
        refreshLive();
        return count();
    }

    // 摘掉这次没被打上标记的旧标记（新的已经写进 tagCache）。
    // 用数组比对而不是对象键：元素的字符串键是同一个 "[object HTMLDivElement]"，会撞。
    function dropStaleMarks() {
        var want = [], i;
        var cols = cachedCols();
        if (cols) { for (i = 0; i < cols.length; i++) want.push(cols[i]); }
        if (tagCache && tagCache.uncap) {
            for (i = 0; i < tagCache.uncap.length; i++) want.push(tagCache.uncap[i]);
        }
        var list = document.querySelectorAll('[' + CFG.attr + '],[' + CFG.uncapAttr + ']');
        for (i = 0; i < list.length; i++) {
            if (want.indexOf(list[i]) < 0) {
                list[i].removeAttribute(CFG.attr);
                list[i].removeAttribute(CFG.uncapAttr);
            }
        }
    }

    function count() {
        return document.querySelectorAll('[' + CFG.attr + ']').length;
    }

    function untagAll() {
        tagCache = null;
        var list = document.querySelectorAll('[' + CFG.attr + '],[' + CFG.uncapAttr + ']');
        for (var i = 0; i < list.length; i++) {
            list[i].removeAttribute(CFG.attr);
            list[i].removeAttribute(CFG.uncapAttr);
        }
    }

    /* ================= 滚动锚定 ================= */
    // 宽度一变，正文就按新宽度重新折行：同一行的文字被挤到别处，滚动位移不补偿的话
    // 视口里看到的整段内容会突然换掉（越靠近超长消息越明显）。这里的做法是：
    // 改宽度前记下视口中心那一行元素的位置，改完把位置差补回到滚动位移上，让它留在原处。

    // 正文所在的可滚动祖先。
    // 每个被标记的列各自往上找一个可滚动祖先（消息列和输入区可能是两棵独立的树）。
    function scrollHosts() {
        var cols = document.querySelectorAll('[' + CFG.attr + ']'), out = [];
        for (var i = 0; i < cols.length; i++) {
            var n = cols[i].parentElement, d = 0;
            while (n && n.nodeType === 1 && d++ < 20) {
                if (isPanelNode(n)) break;
                var cs = window.getComputedStyle(n);
                var oy = cs.overflowY;
                if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') &&
                    n.scrollHeight > n.clientHeight + 4) {
                    if (out.indexOf(n) < 0) out.push(n);
                    break;
                }
                n = n.parentElement;
            }
        }
        return out;
    }

    function scrollHost() {
        var list = scrollHosts();
        return list.length ? list[0] : null;
    }

    // 从命中元素往下钻到贴着这一行的最小盒子。助手消息正文是一个几万像素高的
    // 大容器，它的 top 和视口中间那一行没有关系，拿它做参照等于没补。
    function refineHit(el, x, y) {
        var cur = el, guard = 0;
        while (cur && cur.firstElementChild && guard++ < 30) {
            var best = null, bestH = Infinity;
            for (var i = 0; i < cur.children.length; i++) {
                var ch = cur.children[i], r = ch.getBoundingClientRect();
                if (r.height < 6) continue;
                if (r.top > y || r.bottom < y || r.left > x || r.right < x) continue;
                if (r.height < bestH) { bestH = r.height; best = ch; }
            }
            if (!best) break;
            cur = best;
        }
        return cur;
    }

    // 视口中心那一行。悬浮按钮之类的固定定位层会盖在正文上，命中它拿不到位移；
    // 中心点也可能落在两段之间的空隙里，钻下去只剩一个大容器。所以从正中上下
    // 各试几个点，取"离中心点最近的那个小盒子"；一个都没有时用最小的大容器兜底。
    // 不能取第一个命中的：中心点落在两条消息之间的空隙里时，先试的是上边那个点，
    // 参照就会落到上面那一条消息上，补完之后视口里的内容整体挪了一条消息的高度。
    function anchorHit(sc) {
        var tries = [], r = null, i;
        if (sc) {
            r = sc.getBoundingClientRect();
            var cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
            var offs = [0, -10, 10, -26, 26, -46, 46];
            for (i = 0; i < offs.length; i++) tries.push([cx, cy + offs[i]]);
            tries.push([Math.round(r.left + r.width * 0.38), cy], [Math.round(r.left + r.width * 0.62), cy]);
            tries.push([cx, cy - Math.round(r.height * 0.3)], [cx, cy + Math.round(r.height * 0.3)]);
        } else {
            tries.push([Math.round(window.innerWidth / 2), Math.round(window.innerHeight / 2)]);
        }
        // 超过一屏高的盒子当参照没意义：它的顶边在视口外，补位移补的是看不见的东西。
        // 一条比较长的回答本身就可能高过 0.4 屏，早先按 0.4 屏卡会把这类正常消息排除掉，
        // 转而取上一行，结果补完之后内容整体挪了一条消息的高度。
        var limit = (sc ? r.height : window.innerHeight);
        var cy0 = sc ? Math.round(r.top + r.height / 2) : Math.round(window.innerHeight / 2);
        var best = null, bestKey = Infinity, bestH = Infinity, big = null;
        for (i = 0; i < tries.length; i++) {
            var x = tries[i][0], y = tries[i][1];
            var el = document.elementFromPoint(x, y);
            if (!el || el.nodeType !== 1 || isPanelNode(el)) continue;
            if (sc && !sc.contains(el)) continue;
            if (!sc && el === document.documentElement) continue;
            if (window.getComputedStyle(el).position === 'fixed') continue;
            if (el.offsetHeight < 4) continue;
            var box = refineHit(el, x, y);
            var bx = box.getBoundingClientRect();
            if (bx.height < 6) continue;
            if (bx.height > limit) { if (bx.height < bestH) { bestH = bx.height; big = box; } continue; }
            // 离视口中心越近越优先，同距离取更矮的（更贴近那一行）。
            var dist = Math.max(0, bx.top - cy0) + Math.max(0, cy0 - bx.bottom);
            var key = dist * 1000 + bx.height;
            if (key < bestKey) { bestKey = key; best = box; }
        }
        return best || big;
    }

    // 从元素本身到滚动容器整条链的位置都记下来：虚拟列表重渲染会换掉中间节点，
    // 用"仍在文档中的最深那一层"做参照最稳。
    function captureAnchor() {
        try {
            var sc = scrollHost();
            var el = anchorHit(sc);
            if (!el) return null;
            var chain = [];
            var p = el, d = 0;
            while (p && p.nodeType === 1 && d++ < 60) {
                chain.push({ el: p, top: p.getBoundingClientRect().top });
                if (p === sc) break;
                p = p.parentElement;
            }
                var key = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24);
                return {
                    sc: sc, chain: chain, key: key.length >= 8 ? key : '',
                    keyTop: el.getBoundingClientRect().top,
                    expect: sc ? sc.scrollTop : (window.scrollY || 0)
                };
        } catch (e) { return null; }
    }

    // 虚拟列表重渲染会把行节点整批换掉，最深那一层断了以后，
    // 退到更上层的容器去量，那个容器往往不动，位移就量成 0（真实页窄列时下沉 90px 就是这个）。
    // 所以先按文字内容把同一段话找回来再量。
    var keyAt = 0;
    function findByKey(anc) {
        if (!anc || !anc.key) return null;
        // 全量扫一遍不便宜，虚拟列表重渲染时这个分支会频繁走到，限流到 120ms 一次。
        var now = Date.now();
        if (now - keyAt < 120) return null;
        keyAt = now;
        var sc = (anc.sc && document.contains(anc.sc)) ? anc.sc : scrollHost();
        if (!sc) return null;
        var all = sc.querySelectorAll('*'), hit = null, hh = Infinity;
        var n = Math.min(all.length, 4000);
        for (var i = 0; i < n; i++) {
            var n = all[i];
            if (n.children.length > 6) continue;
            var t = n.textContent || '';
            if (t.indexOf(anc.key) !== 0) continue;
            var h = n.getBoundingClientRect().height;
            if (h < hh) { hh = h; hit = n; }
        }
        return hit;
    }

    function anchorDelta(anc) {
        if (!anc) return null;
        var deep = anc.chain[0];
        if (deep && deep.el && !deep.el.isConnected) {
            var back = findByKey(anc);
            if (back) return back.getBoundingClientRect().top - anc.keyTop;
        }
        for (var i = 0; i < anc.chain.length; i++) {
            var c = anc.chain[i];
            if (c.el && c.el.isConnected && document.contains(c.el)) {
                return c.el.getBoundingClientRect().top - c.top;
            }
        }
        var again = findByKey(anc);
        if (again) return again.getBoundingClientRect().top - anc.keyTop;
        return null;
    }

    function fixAnchor(anc, guard) {
        if (!anc) return;
        var sc = (anc.sc && document.contains(anc.sc)) ? anc.sc : scrollHost();
        var cur = sc ? sc.scrollTop : (window.scrollY || 0);
        // 用户自己在滚，就别把位置抢回来。不能拿"滚动位置和上次不一样"当判据：
        // 内容变矮时浏览器会把 scrollTop 收回去，那样会被当成用户在滚而不补。
        if (guard && userScrollAt && Date.now() - userScrollAt < 600) return;
        var d = anchorDelta(anc);
        if (d === null) return;
        if (Math.abs(d) >= 1) {
            if (sc) sc.scrollTop = cur + d;
            else window.scrollBy(0, d);
        }
        anc.expect = sc ? sc.scrollTop : (window.scrollY || 0);
    }

    // 最近一次"视口中间那一行"的定位。改宽度时有改之前的状态可以对比，
    // 浏览器窗口被拖动时没有：重排由浏览器自己发起，脚本只能拿之前记下的位置把内容摆回去。
    var liveAnchor = null, liveTimer = null, resizeAt = 0, userScrollAt = 0, resizeRaf = 0;

    // 连续调节（拖滑块 / 滚轮微调）期间的合并状态。
    // 原来每次 input 都立刻改宽度、还排下三段补偿，快速拖动时几批补偿互相重叠，
    // 每批都要强制排版一次，页面就会一闪一闪。
    // 现在：手势开始时冻结一次参照，手势期间每帧最多改一次宽度、补一次位移，
    // 松手（最后一个 input 之后 260ms）再做一次多段收尾。
    var gesturing = false, gestAnc = null, gestTimer = 0, gestFrame = 0, gestDirty = false;

    // 窗口尺寸变化期间不要覆盖这份参照：重排和虚拟列表重测项高都要几百毫秒才收敛，
    // 中途换参照会把还没补完的位移当成新的基准。手势期间同理，用冻结的那份。
    function refreshLive() {
        if (Date.now() - resizeAt < 1600) return;
        if (gesturing) return;
        try { liveAnchor = captureAnchor(); } catch (e) {}
    }

    function refreshLiveLater(ms) {
        window.setTimeout(refreshLive, ms);
    }

    // 手势收尾：解冻参照，在随后几帧里把位移复查一遍（虚拟列表项高是异步重测的）。
    function endGesture() {
        gesturing = false;
        gestTimer = 0;
        var anc = gestAnc;
        gestAnc = null;
        if (anc) {
            var delays = [0, 90, 260, 650];
            for (var i = 0; i < delays.length; i++) {
                (function (ms) {
                    window.setTimeout(function () { fixAnchor(anc, true); }, ms);
                })(delays[i]);
            }
        }
        refreshLiveLater(760);
        saveState();
    }

    function beginGesture() {
        if (!gesturing) {
            gesturing = true;
            try { gestAnc = captureAnchor(); } catch (e) { gestAnc = null; }
            if (!liveAnchor) liveAnchor = gestAnc;
        }
        if (gestTimer) window.clearTimeout(gestTimer);
        gestTimer = window.setTimeout(endGesture, 260);
    }

    function cancelGesture() {
        if (gestFrame) { window.clearTimeout(gestFrame); gestFrame = 0; }
        if (gestTimer) { window.clearTimeout(gestTimer); gestTimer = 0; }
        gesturing = false;
        gestDirty = false;
        gestAnc = null;
    }

    // 手势期间：同一帧里的多次 input 只留最后一个值，每帧改一次宽度、补一次位移。
    function applyLive() {
        if (gestFrame) return;
        gestFrame = window.setTimeout(function () {
            gestFrame = 0;
            if (!gestDirty) return;
            gestDirty = false;
            applyVar();
            if (!count()) scheduleScan(80);
            if (gestAnc) fixAnchor(gestAnc, false);
            syncUI();
        }, 16);
    }

    // 滑块/滚轮走这条：只记目标值，真正的排版交给下一帧；状态存盘推迟到手势收尾。
    function setPctLive(v) {
        state.pct = clampPct(v);
        setOn(true);
        gestDirty = true;
        beginGesture();
        applyLive();
        syncUI();
    }

    // 改宽度统一走这里：同步补一次，再在随后几帧里复查。
    // 后几次是因为虚拟列表的项高是异步重测的，补完还会再动一下。
    function anchorChange(mutate) {
        cancelGesture();
        // 尽量沿用已经冻结的那份参照：每次改动都重新取一次，取到的可能是中心点附近
        // 另一个块（同一位置上下相邻的两条消息），补完之后看起来就"跳了一块"。
        // 只有这份参照已经不在文档里、或者用户自己滚过导致对不上了，才重新取。
        var anc = liveAnchor;
        if (anc) {
            var live = (anc.sc && document.contains(anc.sc)) || (!anc.sc && true);
            var d0 = anchorDelta(anc);
            if (!live || d0 === null || Math.abs(d0) > 8) anc = null;
        }
        if (!anc) anc = captureAnchor();
        mutate();
        if (!anc) { refreshLiveLater(760); return; }
        fixAnchor(anc, false);
        var delays = [90, 260, 650];
        for (var i = 0; i < delays.length; i++) {
            (function (ms) {
                window.setTimeout(function () { fixAnchor(anc, true); }, ms);
            })(delays[i]);
        }
        refreshLiveLater(760);
    }

    /* ================= 面板 ================= */

    var PANEL_HTML = [
        '<style>',
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
        '.tip{margin-top:8px;font-size:10px;color:var(--sub);line-height:1.5;cursor:pointer}',
        '.wc{color:var(--fg);opacity:.75}',
        '.sep{height:1px;background:var(--bd);margin:10px 0 9px}',
        '.row{display:flex;align-items:center;gap:8px;height:22px}',
        '.lb{font-size:11px;color:var(--fg);opacity:.9}',
        '.sw{position:relative;margin-left:auto;width:34px;height:19px;flex:none;border:0;border-radius:10px;',
        '  background:var(--trk);cursor:pointer;transition:background .15s}',
        '.sw::after{content:"";position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;',
        '  background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:transform .15s}',
        '.sw[data-on="1"]{background:var(--acc)}',
        '.sw[data-on="1"]::after{transform:translateX(15px)}',
        '.acts{display:flex;gap:6px;margin-top:9px}',
        '.acts button{flex:1;height:26px;border:1px solid var(--bd);border-radius:7px;background:var(--btn);',
        '  color:var(--fg);font:400 11px/1 inherit;cursor:pointer}',
        '.acts button:hover{background:var(--btnh)}',
        '</style>',
        '<div class="wrap" id="wrap">',
        '  <div class="bar" id="bar">',
        '    <span class="dot"></span>',
        '    <span class="ttl">内容宽度</span>',
        '    <span class="val" id="val">100%</span>',
        '    <button class="x" id="close" title="关闭 (Esc)">×</button>',
        '  </div>',
        '  <div class="body" id="body">',
        '    <input id="range" type="range" min="' + CFG.min + '" max="' + CFG.max + '" step="1" value="' + CFG.def + '">',
        '    <div class="quick" id="quick">',
        '      <button data-pct="100">满宽</button>',
        '      <button data-pct="90">90%</button>',
        '      <button data-pct="80">80%</button>',
        '      <button data-pct="70">70%</button>',
        '      <button data-pct="native">原生</button>',
        '    </div>',
        '    <div class="sep"></div>',
        '    <div class="row">',
        '      <span class="lb">自动收起思考过程</span>',
        '      <button class="sw" id="sw-think" data-on="0" title="只留「已思考（用时 N 秒）」这一行，点它仍可展开"></button>',
        '    </div>',
        '    <div class="acts">',
        '      <button id="btn-rescan">重新识别</button>',
        '      <button id="btn-diag">复制诊断</button>',
        '    </div>',
        '    <div class="tip" id="tip"><span class="wc">滚轮微调 · 拖标题移动</span></div>',
        '  </div>',
        '</div>'
    ].join('');

    function detectTheme() {
        try {
            var de = document.documentElement;
            var flag = (de.getAttribute('data-theme') || '') + ' ' +
                (de.getAttribute('class') || '') + ' ' +
                ((document.body && document.body.getAttribute('class')) || '');
            if (/dark/i.test(flag)) return true;
            if (/light/i.test(flag)) return false;
            var el = document.body || de;
            var bg = window.getComputedStyle(el).backgroundColor || '';
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
        root.innerHTML = PANEL_HTML;
        document.body.appendChild(host);

        els.wrap = root.getElementById('wrap');
        els.bar = root.getElementById('bar');
        els.val = root.getElementById('val');
        els.range = root.getElementById('range');
        els.tip = root.getElementById('tip');
        els.close = root.getElementById('close');
        els.swThink = root.getElementById('sw-think');
        els.rescan = root.getElementById('btn-rescan');
        els.diag = root.getElementById('btn-diag');
        els.quick = root.getElementById('quick');

        els.range.addEventListener('input', function (e) { setPctLive(e.target.value); });
        els.range.addEventListener('change', function (e) { setPctLive(e.target.value); });
        els.close.addEventListener('click', function (e) { e.stopPropagation(); closePanel(); });
        els.swThink.addEventListener('click', function (e) {
            e.stopPropagation();
            setHideThink(!state.hideThink);
        });
        els.rescan.addEventListener('click', function (e) {
            e.stopPropagation();
            untagAll();
            scan();
            updateTip();
        });
        els.diag.addEventListener('click', function (e) { e.stopPropagation(); diagnoseAndCopy(); });
        els.tip.addEventListener('click', function (e) { e.stopPropagation(); diagnoseAndCopy(); });
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

    /* ================= 交互入口 ================= */

    function syncUI() {
        if (!els.val) return;
        els.val.textContent = state.on ? (state.pct + '%') : '原生';
        els.range.value = String(state.pct);
        els.range.disabled = false;
        if (els.swThink) {
            if (state.hideThink) els.swThink.setAttribute('data-on', '1');
            else els.swThink.removeAttribute('data-on');
        }
        var btns = els.quick.getElementsByTagName('button');
        for (var i = 0; i < btns.length; i++) {
            var v = btns[i].getAttribute('data-pct');
            var on = (v === 'native') ? !state.on : (state.on && String(state.pct) === v);
            if (on) btns[i].setAttribute('data-on', '1');
            else btns[i].removeAttribute('data-on');
        }
        updateTip();
    }

    // 提示文字只有变了才重写：原来每次 input 都重写一次 innerHTML，
    // 拖动时面板自己也在闪。
    var tipText = '';

    function updateTip() {
        if (!els.tip) return;
        var n = count();
        var text = state.on
            ? (n ? ('已匹配 ' + n + ' 个容器') : '未识别到内容容器 · 点这行复制诊断信息')
            : '已恢复 DeepSeek 原始宽度';
        if (text === tipText) return;
        tipText = text;
        els.tip.innerHTML = '<span class="wc">' + text + ' · 滚轮微调 · 拖标题移动</span>';
    }

    function setPct(v) {
        var next = clampPct(v);
        anchorChange(function () {
            state.pct = next;
            setOn(true);
            applyVar();
            // 已经标记过就直接改 CSS 变量，拖动滑块时不必反复全页扫描；
            // 页面结构变化由 MutationObserver 触发重新扫描。
            if (!count()) scheduleScan(80);
        });
        syncUI();
        saveState();
    }

    function setNative() {
        anchorChange(function () {
            setOn(false);
            untagAll();
        });
        syncUI();
        saveState();
    }

    /* ================= 诊断 ================= */

    function clsOf(el) {
        var c = '';
        try { c = (el.className || '').toString().trim().replace(/\s+/g, '.'); } catch (e) { c = ''; }
        return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (c ? '.' + c.slice(0, 60) : '');
    }

    function descOf(el) {
        var cs = window.getComputedStyle(el);
        return clsOf(el) + ' w=' + el.offsetWidth + ' max=' + cs.maxWidth +
            ' pad=' + cs.paddingLeft + '/' + cs.paddingRight + ' pos=' + cs.position +
            ' txt=' + (el.textContent || '').length;
    }

    // 整理成一段可粘贴的文本：视口、匹配数、被匹配容器、以及视口中心的宽度链。
    function diagnose() {
        var lines = ['[DSW诊断] ' + location.href];
        lines.push('viewport ' + window.innerWidth + 'x' + window.innerHeight +
            ' pct ' + (state.on ? state.pct + '%' : 'native') + ' tagged ' + count());
        var rank = document.querySelectorAll('[' + CFG.attr + ']');
        for (var i = 0; i < rank.length; i++) lines.push('col ' + descOf(rank[i]));
        var col0 = document.querySelector('[' + CFG.attr + ']');
        var hit0 = document.elementFromPoint(Math.round(window.innerWidth / 2), Math.round(window.innerHeight / 2));
        lines.push('center ' + (hit0 ? descOf(hit0) : 'none') +
            ' inCol=' + (col0 && hit0 ? col0.contains(hit0) : 'n/a'));
        var el = hit0;
        var d = 0;
        while (el && el.nodeType === 1 && d++ < 10) {
            lines.push('chain ' + descOf(el));
            el = el.parentElement;
        }
        // 现在这一刻重新识别会选谁、跟当前标记对不对得上，一眼能看出来。
        var pick = [];
        try { pick = pickCandidates(); } catch (e) { pick = []; }
        lines.push('pick ' + pick.length);
        for (var k = 0; k < pick.length && k < 6; k++) {
            lines.push('pick#' + k + ' ' + descOf(pick[k]) + ' tagged=' + pick[k].hasAttribute(CFG.attr));
        }
        lines.push('elements ' + (document.body ? document.body.getElementsByTagName('*').length : 0));
        return lines.join('\n');
    }

    function diagnoseAndCopy() {
        var text = diagnose();
        var ok = false;
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text);
                ok = true;
            }
        } catch (e) { ok = false; }
        if (!ok) {
            try { console.log(text); } catch (e) {}
        }
        if (els.tip) {
            els.tip.textContent = ok ? '诊断信息已复制，可直接粘贴反馈' : '诊断信息已打印到控制台 (F12)';
            setTimeout(updateTip, 2600);
        }
    }

    /* ================= 监听 ================= */

    var scanTimer = null;
    function scheduleScan(delay) {
        if (scanTimer) return;
        scanTimer = setTimeout(function () {
            scanTimer = null;
            scan();
            updateTip();
        }, delay || 200);
    }

    function observe() {
        // 用户自己点思考块时记一笔，之后不再替这一块收起。
        watchThinkTouch();

        var mo = new MutationObserver(function (muts) {
            var dirty = false;
            for (var i = 0; i < muts.length && !dirty; i++) {
                var added = muts[i].addedNodes;
                for (var j = 0; j < added.length; j++) {
                    var n = added[j];
                    if (n.nodeType === 1 && !isPanelNode(n)) { dirty = true; break; }
                }
            }
            if (dirty) scheduleScan(200);
        });
        if (document.body) mo.observe(document.body, { childList: true, subtree: true });
        else mo.observe(document.documentElement, { childList: true, subtree: true });

        var moTheme = new MutationObserver(function () { refreshTheme(); });
        moTheme.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
        if (document.body) {
            moTheme.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme'] });
        }

        // 用户用滚轮/触控/键盘自己滚过的时间戳：补位置时避开这段，
        // 面板上的操作（拖滑块）不算，否则滑块会把自己锁住。
        var SCROLL_KEYS = { ArrowUp: 1, ArrowDown: 1, PageUp: 1, PageDown: 1, Home: 1, End: 1, ' ': 1, Spacebar: 1 };
        function markUserScroll(e) {
            var path = e.composedPath ? e.composedPath() : [e.target];
            for (var i = 0; i < path.length; i++) {
                if (path[i] === host) return;
            }
            // 只有翻页类按键算"用户在滚"，普通打字不算。
            if (e.type === 'keydown' && !SCROLL_KEYS[e.key]) return;
            userScrollAt = Date.now();
        }
        var userEvents = ['wheel', 'touchstart', 'touchmove', 'keydown', 'mousedown', 'pointerdown'];
        for (var ue = 0; ue < userEvents.length; ue++) {
            window.addEventListener(userEvents[ue], markUserScroll, { passive: true, capture: true });
        }

        // 用户自己滚动时记下当前位置，供窗口尺寸变化时摆回去用。
        window.addEventListener('scroll', function () {
            if (liveTimer) window.clearTimeout(liveTimer);
            liveTimer = window.setTimeout(function () { liveTimer = null; refreshLive(); }, 180);
        }, { passive: true, capture: true });

        // 窗口尺寸变化：重排由浏览器完成，这里把视口中间那一行摆回原处，
        // 再按新尺寸重新识别一次容器（原来的容器可能已经被换掉）。
        function onResize() {
            cancelGesture();
            if (!liveAnchor) { try { liveAnchor = captureAnchor(); } catch (e) {} }
            resizeAt = Date.now();
            // 这里必须同步补：resize 事件在浏览器完成排版之后、绘制之前派发，
            // 于是"读一次位置 + 写 scrollTop"都发生在同一帧内，画出来的就是对齐后的样子。
            // 放到 setTimeout 里补会晚一帧 —— 先画一遍错位的，再跳回原位，肉眼就是一跳一跳。
            fixAnchor(liveAnchor, true);
            scheduleScan(250);
            // 站点自己的虚拟列表会在 resize 之后异步重测行高，几百毫秒内还会再挪一次；
            // 只同步补一次不够，这里按帧补到收敛（位移为 0 时不写 scrollTop，只多读一次 rect）。
            if (resizeRaf) { window.cancelAnimationFrame(resizeRaf); resizeRaf = 0; }
            var until = resizeAt + 620;
            (function settle() {
                fixAnchor(liveAnchor, true);
                if (Date.now() < until) resizeRaf = window.requestAnimationFrame(settle);
                else resizeRaf = 0;
            })();
            var passes = [90, 320, 700, 1300];
            for (var i = 0; i < passes.length; i++) {
                window.setTimeout(function () { fixAnchor(liveAnchor, true); }, passes[i]);
            }
            window.setTimeout(function () { resizeAt = 0; refreshLive(); }, 1500);
        }
        window.addEventListener('resize', onResize, { passive: true });
        // 自测用：模拟页改完布局宽度后派发这个事件，走和真窗口变化同一条路。
        window.addEventListener(CFG.event, onResize);
        window.addEventListener('popstate', function () { scheduleScan(300); });
        window.addEventListener('hashchange', function () { scheduleScan(300); });

        document.addEventListener('keydown', function (e) {
            if (e.altKey && e.shiftKey && (e.key === 'W' || e.key === 'w' || e.code === 'KeyW')) {
                e.preventDefault();
                e.stopPropagation();
                togglePanel();
                return;
            }
            if (e.key === 'Escape' && host && host.style.display !== 'none') {
                e.preventDefault();
                closePanel();
            }
        }, true);
    }

    /* ================= 启动 ================= */

    function boot() {
        loadState();
        setOn(state.on);
        injectStyle();
        applyVar();
        syncUI();
        scan();
        updateTip();
        observe();
        setTimeout(function () { scan(); updateTip(); }, 800);
        setTimeout(function () { scan(); updateTip(); }, 2400);
        setTimeout(function () { scan(); updateTip(); }, 5000);
    }

    if (typeof GM_registerMenuCommand === 'function') {
        try {
            // 下拉框里只留一条入口，其余设置都在弹出的设置页里改。
            GM_registerMenuCommand('⚙ 打开设置面板', openPanel);
        } catch (e) {}
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
