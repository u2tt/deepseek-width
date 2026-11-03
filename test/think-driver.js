(function () {
    var results = { steps: [], errors: [] };
    var host = null, sroot = null;

    function q(id) { return document.getElementById(id); }
    function wrap(i) { var m = q('m' + i); return m && m.querySelector('.thinkwrap'); }
    function folded(i) { var w = wrap(i); return !!(w && w.classList.contains('folded')); }
    function bodyDisp(i) { var w = wrap(i); return w ? getComputedStyle(w.querySelector('.tbody')).display : 'n/a'; }
    function headText(i) { var w = wrap(i); return w ? w.querySelector('.lb').textContent : 'n/a'; }
    function headH(i) { var w = wrap(i); return w ? Math.round(w.querySelector('.headrow').getBoundingClientRect().height) : -1; }
    function blkH(i) { var w = wrap(i); return w ? Math.round(w.getBoundingClientRect().height) : -1; }
    function ansDisp(i) { var m = q('m' + i); var a = m && m.querySelector('.ans'); return a ? getComputedStyle(a).display : 'n/a'; }
    function marked() { return document.querySelectorAll('[data-dsw-think]').length; }
    function hotkey() {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'W', altKey: true, shiftKey: true, bubbles: true }));
    }
    function esc() {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }
    function step(name, extra) {
        var o = { name: name };
        if (extra) for (var k in extra) o[k] = extra[k];
        results.steps.push(o);
    }
    function foldState(tag) {
        return {
            name: tag,
            m1: folded(1), m1body: bodyDisp(1), m1head: headText(1), m1headH: headH(1), m1blkH: blkH(1),
            m2: folded(2), m2body: bodyDisp(2),
            m3: folded(3), m3body: bodyDisp(3),
            marked: marked(),
            switchOn: sroot ? sroot.getElementById('sw-think').getAttribute('data-on') : null
        };
    }
    function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    function report() {
        var pre = document.createElement('pre');
        pre.id = 'dsw-out';
        pre.textContent = 'DSWTHINK=' + JSON.stringify(results);
        document.body.appendChild(pre);
    }

    async function boot() {
        // 1) 面板不常驻，但思考块应该已经被脚本收起来了
        var before = foldState('before-open');
        before.hostExists = !!document.getElementById('dsw-host');
        before.ansVisible = ansDisp(1);
        before.singleMsg = (function () {
            var msgs = document.querySelectorAll('.ds-message');
            var last = msgs[msgs.length - 1];
            return { kids: last.children.length, h: Math.round(last.getBoundingClientRect().height) };
        })();
        results.steps.push(before);

        // 2) 快捷键打开设置面板
        hotkey();
        host = document.getElementById('dsw-host');
        sroot = host && host.shadowRoot;
        if (!sroot) { results.errors.push('panel not built on hotkey'); report(); return; }
        step('opened', {
            display: getComputedStyle(host).display,
            title: sroot.querySelector('.ttl').textContent,
            switchLabel: sroot.querySelector('.row .lb').textContent,
            hasRange: !!sroot.getElementById('range'),
            switchOn: sroot.getElementById('sw-think').getAttribute('data-on'),
            quickBtns: sroot.getElementById('quick').getElementsByTagName('button').length,
            acts: sroot.querySelectorAll('.acts button').length
        });

        // 3) 关掉自动收起：思考正文应该回来
        sroot.getElementById('sw-think').click();
        await wait(200);
        var off = foldState('fold-off');
        off.stored = window.localStorage.getItem('dsw.width.state.v1') || '';
        results.steps.push(off);

        // 4) 再打开：重新收起
        sroot.getElementById('sw-think').click();
        await wait(300);
        results.steps.push(foldState('fold-on'));

        // 5) 用户自己点开某一块：脚本不该再把它收回去
        var head1 = wrap(1).querySelector('.headrow');
        head1.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
        head1.click();
        await wait(700);
        results.steps.push(foldState('user-expanded'));

        // 6) × 关闭面板
        sroot.getElementById('close').click();
        step('closed-by-x', { display: getComputedStyle(host).display });

        // 7) 打开后用 Esc 关闭
        hotkey();
        var opened2 = getComputedStyle(host).display;
        esc();
        step('esc', { afterOpen: opened2, afterEsc: getComputedStyle(host).display });

        // 8) 面板里的「重新识别」按钮
        hotkey();
        sroot.getElementById('btn-rescan').click();
        await wait(300);
        step('rescan', {
            tagged: document.querySelectorAll('[data-dsw-col]').length,
            colW: Math.round(q('col').getBoundingClientRect().width)
        });
        report();
    }

    setTimeout(function () { boot().catch(function (e) { results.errors.push(String(e)); report(); }); }, 800);
})();
