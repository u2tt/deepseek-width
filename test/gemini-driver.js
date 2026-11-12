(function () {
  function box(sel) {
    var n = document.querySelector(sel);
    if (!n) return null;
    var r = n.getBoundingClientRect();
    return { x: Math.round(r.x), w: Math.round(r.width), y: Math.round(r.y), h: Math.round(r.height) };
  }
  window.__run = async function () {
    var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    // 无头 Chrome 里 rAF 不触发，用定时器代表「两帧」；mock 页没有异步重排，等一拍就稳定
    var frame = function () { return wait(35); };
    var de = document.documentElement;
    var res = { mode: window.__mode, on: de.classList.contains('gw-on'), vw: window.innerWidth };

    // 1. 原生宽度：摘掉开关量一次
    de.classList.remove('gw-on');
    await frame();
    res.native = { chat: box('.chat-container'), conv: box('.conversation-container'), ia: box('.input-area-container'), zs: box('.zero-state-container') };
    de.classList.add('gw-on');
    await frame();

    // 2. Alt+Shift+W 打开面板
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'W', altKey: true, shiftKey: true, bubbles: true }));
    await wait(80);
    var host = document.getElementById('gw-host');
    if (!host) return { error: 'panel missing' };
    var $ = function (id) { return host.shadowRoot.getElementById(id); };
    res.panel = host.style.display;

    var step = async function (pct) {
      var range = $('range');
      range.value = String(pct);
      range.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(80);
      return { chat: box('.chat-container'), conv: box('.conversation-container'), ia: box('.input-area-container'), zs: box('.zero-state-container'), val: $('val').textContent };
    };
    res.s100 = await step(100);
    res.s70 = await step(70);
    res.s40 = await step(40);

    // 3. 「原生」按钮
    $('quick').querySelector('[data-pct="native"]').click();
    await wait(80);
    res.nativeBtn = { on: de.classList.contains('gw-on'), chat: box('.chat-container'), val: $('val').textContent };

    // 4. 回到 70%
    res.back = await step(70);

    // 5. 折叠侧栏：列宽应变宽（脚本 1.2s 轮询实测侧栏宽度）
    document.getElementById('toggle-side').click();
    await wait(1500);
    res.collapsed = { side: box('bard-sidenav'), chat: box('.chat-container'), sab: de.style.getPropertyValue('--gw-sb') };
    document.getElementById('toggle-side').click();
    await wait(1500);
    res.expanded = { side: box('bard-sidenav'), chat: box('.chat-container'), sab: de.style.getPropertyValue('--gw-sb') };

    // 6. Esc 关面板，再按一次重新打开
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(60);
    res.closed = host.style.display;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'W', altKey: true, shiftKey: true, bubbles: true }));
    await wait(60);
    res.reopen = host.style.display + ':' + $('val').textContent;

    // 7. 内容区变窄（模拟拖动浏览器窗口）：列宽按 vw 自动跟着变，脚本不重算
    document.body.classList.add('narrow');
    await frame();
    await wait(120);
    res.narrow = { body: box('body'), chat: box('.chat-container'), ia: box('.input-area-container'), val: $('val').textContent };
    document.body.classList.remove('narrow');
    await frame();
    await wait(120);
    res.wide = { body: box('body'), chat: box('.chat-container'), ia: box('.input-area-container') };
    return res;
  };
})();