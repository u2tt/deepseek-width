#!/usr/bin/env node
// 生成 test/mock-gemini-run.html：把当前 userscript 全文内嵌成 text/plain，
// 由外壳页在 iframe 里 eval。每次改脚本都要重新生成，否则测的还是旧代码。
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const us = fs.readFileSync(path.join(root, 'content-width.user.js'), 'utf8');

const head = `<!doctype html><html><head><meta charset="utf-8"><title>gw-test</title></head>
<body style="margin:0">
<pre id="out">PENDING</pre>
<!-- 用 text/plain 承载脚本源码，避开父页 CSP -->
<script id="us" type="text/plain">`;

const tail = `</script>
<iframe id="host" style="border:0;width:1400px;height:1000px"></iframe>
<script>
(async function () {
  var host = document.getElementById('host'), out = document.getElementById('out');
  function fail(m) { var bad = 'GWJSON=' + JSON.stringify({ error: String(m) }); out.textContent = bad; document.title = bad; }
  try {
    var mode = (location.search.match(/[?&]mode=([a-z]+)/) || [])[1] || 'conv';
    host.src = 'mock-gemini.html?mode=' + encodeURIComponent(mode);
    await new Promise(function (r, j) { host.onload = r; host.onerror = j; setTimeout(r, 5000); });
    var win = host.contentWindow;
    // 模拟页跑在 127.0.0.1 上，域名不匹配，用测试钩子指定实现
    win.__usImpl = 'gemini';
    win.eval(document.getElementById('us').textContent);
    win.eval('(function(){window.__gwCheck=1;})();');
    var drv = await (await fetch('gemini-driver.js')).text();
    win.eval(drv);
    await new Promise(function (r) { setTimeout(r, 250); });
    var marks = { script: !!win.__gwCheck, run: typeof win.__run, cls: win.document.documentElement.className };
    if (typeof win.__run !== 'function') throw new Error('driver missing ' + JSON.stringify(marks));
    var res = {};
    try { res = await win.__run(); } catch (e) { res = { error: String(e && e.message) }; }
    res.marks = marks; res.miss = win.__miss; res.wantMode = mode;
    var line = 'GWJSON=' + JSON.stringify(res);
    out.textContent = line; document.title = line;
  } catch (e) { fail(((e && e.message) || e) + ' @ ' + String((e && e.stack || '').split('\\n').slice(0,3).join(' | '))); }
})();
</script>
</body></html>
`;

fs.writeFileSync(path.join(root, 'test/mock-gemini-run.html'), head + us + tail);
console.log('mock-gemini-run.html 已按 content-width.user.js 重新生成');

