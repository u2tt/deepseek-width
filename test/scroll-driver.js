(function () {
    // 滚动锚定回归测试：改宽度后，视口中心那一行文字必须还在原处。
    var results = { win: window.innerWidth, steps: [], resizeSteps: [], errors: [] };
    var host = null, sroot = null, sc = null;

    function q(id) { return document.getElementById(id); }

    function fill() {
        var col = q('col');
        // 每条消息拆成几段（真实页面的正文也是按段排的）：参照要能落到"贴着这一行"的段落上，
        // 整条消息是一个几百像素高的块时，它的顶边在视口外，拿它做参照量不准。
        var html = [];
        var line = '这是一段用来制造换行的正文，宽度变化时它的行数会变，所以下面内容的纵向位置也会跟着变。';
        for (var i = 1; i <= 24; i++) {
            var ps = ['<b>消息 ' + i + '</b>'];
            for (var j = 1; j <= (i % 3) + 3; j++) {
                ps.push('<p>' + line.repeat((i + j) % 3 + 1) + ' 段标 ' + i + '-' + j + '。</p>');
            }
            html.push('<div class="msg">' + ps.join('') + '</div>');
        }
        col.innerHTML = html.join('');
    }

    function setPct(p) {
        var r = sroot.getElementById('range');
        r.value = String(p);
        r.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function centerOf() {
        var r = sc.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), st: Math.round(sc.scrollTop) };
    }

    function textAt(pt) {
        var el = document.elementFromPoint(pt.x, pt.y);
        if (!el) return '';
        return ((el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()).slice(0, 46);
    }

    // 贴着这一行的最小盒子才是有效参照：消息块可能有几百像素高，
    // 它的 top 和视口中间那一行的位置不是一回事。和脚本里的取法一致。
    function anchorAt(pt) {
        var el = document.elementFromPoint(pt.x, pt.y);
        if (!el) return null;
        var cur = el, guard = 0;
        while (cur && cur.firstElementChild && guard++ < 30) {
            var best = null, bestH = Infinity;
            for (var i = 0; i < cur.children.length; i++) {
                var ch = cur.children[i], r = ch.getBoundingClientRect();
                if (r.height < 6) continue;
                if (r.top > pt.y || r.bottom < pt.y || r.left > pt.x || r.right < pt.x) continue;
                if (r.height < bestH) { bestH = r.height; best = ch; }
            }
            if (!best) break;
            cur = best;
        }
        return { el: cur, top: cur.getBoundingClientRect().top };
    }

    function report() {
        var pre = document.createElement('pre');
        pre.id = 'dsw-out';
        pre.textContent = 'DSWANCHOR=' + JSON.stringify(results);
        document.body.appendChild(pre);
    }

    function boot() {
        // 面板改成按需打开：先按一次 Alt+Shift+W 把它建出来。
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'W', altKey: true, shiftKey: true, bubbles: true }));
        host = q('dsw-host');
        if (!host || !host.shadowRoot) { results.errors.push('panel host missing'); report(); return; }
        sroot = host.shadowRoot;
        sc = q('scroll');
        fill();

        setPct(100);
        // 等 setPct 的几段补位移都跑完再滚到中间，否则脚本会把位置摆回改宽度之前那块。
        setTimeout(function () {
            sc.scrollTop = 1200;
            // 再等一下，让脚本的 scroll 防抖（180ms）重新记参照。
            setTimeout(base, 420);
        }, 950);

        var cur = null;

        function base() {
            var pt = centerOf();
            cur = anchorAt(pt);
            cur.text = textAt(pt);
            cur.st0 = pt.st;
            results.base = { pct: 100, st: pt.st, text: cur.text, top: Math.round(cur.top) };
            runNext(0);
        }

        // 模拟"拖浏览器窗口"：改主区宽度（比例宽度会跟着变）再派发脚本监听的 resize 事件。
        // 要求：每次变化后参照行留在原处（同步就读到对齐后的位置），140ms 后也不能再动。
        // 主区宽度按窗口宽度算，不能写死：窗口只有 1024 时给个 1240 的主区会横向溢出，
        // 那已经不是被测的行为。侧栏按 260 算。
        var b0 = Math.max(600, window.innerWidth - 260);
        var rseq = [b0, b0 - 140, b0 - 240, b0 - 340, b0 - 240, b0 - 140, b0];
        function resizing(i) {
            if (i >= rseq.length) { report(); return; }
            var m = q('main');
            m.style.flex = '0 0 ' + rseq[i] + 'px';
            window.dispatchEvent(new Event('dsw:resize'));
            var pt = centerOf();
            var rec = {
                w: rseq[i],
                topSync: Math.round(cur.el.getBoundingClientRect().top),
                stSync: pt.st
            };
            setTimeout(function () {
                var pt2 = centerOf();
                rec.topLate = Math.round(cur.el.getBoundingClientRect().top);
                rec.stLate = pt2.st;
                rec.colW = Math.round(q('col').getBoundingClientRect().width);
                rec.pass = Math.abs(rec.topLate - cur.top) <= 2 && Math.abs(rec.topSync - cur.top) <= 2;
                results.resizeSteps.push(rec);
                resizing(i + 1);
            }, 140);
        }

        var seq = [55, 80, 100, 40];
        function runNext(i) {
            if (i >= seq.length) { resizing(0); return; }
            var p = seq[i];
            var trace = [];
            // 参照每次改宽度前重新取一次：正文换行会让离锚点较远的块自己也移动几十像素，
            // 那不是抖动。脚本承诺的是"视口中间这一块留在原处"，就量这个。
            var pt0 = centerOf();
            var ref = anchorAt(pt0);
            var top0 = ref.top;
            var txt0 = textAt(pt0);
            setPct(p);
            // 0ms 这一笔是同步读：补位移必须和改宽度在同一帧里完成，晚一帧就是一帧错位。
            [0, 60, 200, 420, 700].forEach(function (ms) {
                setTimeout(function () {
                    trace.push(ms + ':' + (ref.el && document.contains(ref.el) ?
                        Math.round(ref.el.getBoundingClientRect().top - top0) : 'gone'));
                }, ms);
            });
            // 锚定补帧在 90/260/650ms 各复查一次，这里等过最后一帧再量。
            setTimeout(function () {
                var pt = centerOf();
                var delta = (ref.el && document.contains(ref.el)) ? Math.round(ref.el.getBoundingClientRect().top - top0) : null;
                var nowText = textAt(pt);
                var step = {
                    pct: p,
                    st: pt.st,
                    delta: delta,
                    textSame: nowText === txt0,
                    textNow: nowText,
                    colW: Math.round(q('col').getBoundingClientRect().width),
                    scrollW: Math.round(sc.getBoundingClientRect().width),
                    trace: trace.join(' '),

                };
                step.pass = (delta !== null && Math.abs(delta) <= 2 && step.textSame);
                results.steps.push(step);
                runNext(i + 1);
            }, 900);
        }

        results.resize = null;
    }

    setTimeout(boot, 800);
})();