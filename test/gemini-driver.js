(function () {
  function box(sel) {
    var n = document.querySelector(sel);
    if (!n) return null;
    var r = n.getBoundingClientRect();
    return { x: Math.round(r.x), w: Math.round(r.width), y: Math.round(r.y), h: Math.round(r.height) };
  }
  window.__run = async function () {
    var __miss = [];
    var _box0 = box;
    box = function (sel) { var b = _box0(sel); if (!b) __miss.push(sel); return b; };
    try { var r = await _run(); r.diag = window.__diag; return r; } finally { window.__miss = __miss; }
  };
  var _run = async function () {
    var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    // 无头 Chrome 里 rAF 不触发，用定时器代表「两帧」
    var de = document.documentElement;
    var diag = []; window.__diag = diag;
    var res = { mode: window.__mode, vw: window.innerWidth, sbW: Math.round((document.querySelector('bard-sidenav-content')||{getBoundingClientRect:function(){return {width:0}}}).getBoundingClientRect().width) };

    // 1. 原生对照：摘掉开关
    de.classList.remove('gw-on');
    de.style.removeProperty('--gw-k');
    await wait(120);
    res.native = { chat: box('chat-window'), zs: box('.zero-state-container'), conv: box('chat-window .chat-history .conversation-container > user-query:first-child'), ia: box('.input-area-container') };
    de.classList.add('gw-on');
    await wait(120);

    // 2. Alt+Shift+W 打开面板
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'W', altKey: true, shiftKey: true, bubbles: true }));
    await wait(120);
    var host = document.getElementById('gw-host');
    if (!host) return { error: 'panel missing' };
    var $ = function (id) { return host.shadowRoot.getElementById(id); };
    res.panel = host.style.display;

    var snap = function () {
      return {
        chat: box('chat-window'), sab: box('bard-sidenav-content'), zs: box('.zero-state-container'), conv: box('.conversation-container'),
        ia: box('.input-area-container'), disc: box('hallucination-disclaimer'),
        k: de.style.getPropertyValue('--gw-k'), val: $('val').textContent
      };
    };
    var step = async function (pct) {
      var range = $('range');
      range.value = String(pct);
      range.dispatchEvent(new Event('input', { bubbles: true }));
      window.dispatchEvent(new Event('gw:resize'));
      await wait(160);
      var cw = document.querySelector('chat-window');
      diag.push(pct + ':' + Math.round(cw.getBoundingClientRect().width) + ':' + getComputedStyle(cw).flex + ':' + getComputedStyle(cw).width + ':' + de.style.getPropertyValue('--gw-k') + ':css=' + (function(){var t=document.getElementById('gw-style');return t?(t.textContent.match(/chat-window\{[^}]*\}/)||[''])[0].slice(0,60):'nostyle';})());
      return snap();
    };

    de.classList.remove('gw-on'); de.style.removeProperty('--gw-k');
    await wait(160);
    res.nativeOn = { chat: box('chat-window'), conv: box('.conversation-container') };
    de.classList.add('gw-on'); await wait(120);
    res.s100 = await step(100);
    res.s80 = await step(80);

    // 3. 「原生」按钮
    $('quick').querySelector('[data-pct="native"]').click();
    await wait(160);
    res.nativeBtn = { on: de.classList.contains('gw-on'), chat: box('chat-window'), val: $('val').textContent };

    // 4. 回到 80%
    res.back = await step(80);

    // 5. 折叠侧栏：内容区变宽，calc(比例 x 100%) 跟着变，列宽按比例重算
    document.getElementById('toggle-side').click();
    await wait(200);
    res.collapsed = { conv: box('chat-window .chat-history .conversation-container > user-query:first-child'), side: box('bard-sidenav'), sab: box('bard-sidenav-content'), chat: box('chat-window'), ia: box('.input-area-container') };
    document.getElementById('toggle-side').click();
    await wait(200);
    res.expanded = { conv: box('chat-window .chat-history .conversation-container > user-query:first-child'), side: box('bard-sidenav'), sab: box('bard-sidenav-content'), chat: box('chat-window'), ia: box('.input-area-container') };

    // 6. Esc 关面板，再按一次重新打开
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(80);
    res.closed = host.style.display;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'W', altKey: true, shiftKey: true, bubbles: true }));
    await wait(80);
    res.reopen = host.style.display + ':' + $('val').textContent;

    // 7. 窗口变窄：百分比自动跟随，不需要脚本重算
    document.body.classList.add('narrow');
    await wait(250);
    res.narrow = { sab: box('bard-sidenav-content'), chat: box('chat-window'), conv: box('.conversation-container'), ia: box('.input-area-container') };
    document.body.classList.remove('narrow');
    await wait(250);
    res.wide = { sab: box('bard-sidenav-content'), chat: box('chat-window'), conv: box('.conversation-container'), ia: box('.input-area-container') };

    // 8. 收窄后回滚：末态必须与原生布局一致（输入框不许留在上面）
    res.rollback = await window.__rollback();
    de.classList.remove('gw-on'); de.style.removeProperty('--gw-k');
    await wait(160);
    res.rollbackNative = { ic: box('.input-container'), ia: box('.input-area-container') };
    de.classList.add('gw-on'); await wait(120);
    return res;
  };
})();
