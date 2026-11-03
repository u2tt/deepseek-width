(function () {
    var seq = [100, 85, 60, 40, 30];
    var results = { win: window.innerWidth, steps: [], errors: [] };
    var host = null, sroot = null;

    function q(id) { return document.getElementById(id); }

    function measure(tag) {
        var col = q('col'), iw = q('inputwrap'), main = q('main'), narrow = document.querySelector('.narrow');
        var colW = col.getBoundingClientRect().width;
        var mainW = main.getBoundingClientRect().width;
        return {
            tag: tag,
            win: window.innerWidth,
            main: Math.round(mainW),
            col: Math.round(colW),
            input: Math.round(iw.getBoundingClientRect().width),
            colComputedMax: getComputedStyle(col).maxWidth,
            ratio: Math.round(colW / mainW * 1000) / 10,
            narrow: Math.round(narrow.getBoundingClientRect().width),
            modal: Math.round(q('modal').getBoundingClientRect().width),
            modalTagged: q('modal').hasAttribute('data-dsw-col') || q('modal').hasAttribute('data-dsw-uncap'),
            tagged: document.querySelectorAll('[data-dsw-col]').length,
            uncapped: document.querySelectorAll('[data-dsw-uncap]').length,
            wrap: Math.round(q('wrap1280').getBoundingClientRect().width),
            wrapMax: getComputedStyle(q('wrap1280')).maxWidth,
            panelVal: sroot ? sroot.getElementById('val').textContent : null
        };
    }

    function setPct(p) {
        var r = sroot.getElementById('range');
        r.value = String(p);
        r.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function clickQuick(label) {
        var btns = sroot.getElementById('quick').getElementsByTagName('button');
        for (var i = 0; i < btns.length; i++) {
            if (btns[i].textContent === label) { btns[i].click(); return true; }
        }
        return false;
    }

    function report() {
        var pre = document.createElement('pre');
        pre.id = 'dsw-out';
        pre.textContent = 'DSWJSON=' + JSON.stringify(results);
        document.body.appendChild(pre);
    }

    function boot() {
        // 面板改成按需打开：先按一次 Alt+Shift+W 把它建出来。
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'W', altKey: true, shiftKey: true, bubbles: true }));
        host = document.getElementById('dsw-host');
        if (!host || !host.shadowRoot) {
            results.errors.push('panel host missing');
            report();
            return;
        }
        sroot = host.shadowRoot;
        var i = 0;
        function next() {
            if (i >= seq.length) { tail(); return; }
            var p = seq[i++];
            try { setPct(p); } catch (e) { results.errors.push('setPct ' + p + ': ' + e.message); }
            if (p === 60) { try { q('overlay').classList.add('open'); } catch (e) {} }
            setTimeout(function () {
                results.steps.push(measure('pct' + p));
                next();
            }, 130);
        }
        function tail() {
            // 原生模式
            try { clickQuick('原生'); } catch (e) { results.errors.push('native: ' + e.message); }
            setTimeout(function () {
                results.steps.push(measure('native'));
                try { clickQuick('满宽'); } catch (e) { results.errors.push('full: ' + e.message); }
                setTimeout(function () {
                    results.steps.push(measure('back-to-100'));
                    liveResize();
                }, 160);
            }, 160);
        }
        // 同一页面内改变主容器宽度（等价于浏览器窗口变窄/变宽），验证宽度自动跟随
        function liveResize() {
            setPct(60);
            var main = q('main');
            main.style.flex = 'none';
            var sizes = [700, 1000, 500];
            var k = 0;
            function step() {
                if (k >= sizes.length) {
                    main.style.flex = '';
                    main.style.width = '';
                    report();
                    return;
                }
                var w = sizes[k++];
                main.style.width = w + 'px';
                setTimeout(function () {
                    var m = measure('resize-' + w);
                    m.expect = Math.round(w * 0.6 * 10) / 10;
                    m.pass = Math.abs(m.col * 10 - m.expect * 10) <= 20;
                    results.steps.push(m);
                    step();
                }, 140);
            }
            step();
        }
        next();
    }

    setTimeout(boot, 700);
})();
