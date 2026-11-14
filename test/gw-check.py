#!/usr/bin/env python3
"""Gemini 宽度脚本的断言：把 GWJSON 变成逐条 pass/fail。
用法：gw-check.py <conv|zero> < GWJSON...
"""
import json
import sys

mode = sys.argv[1] if len(sys.argv) > 1 else 'conv'
raw = sys.stdin.read().strip()
raw = raw.split('GWJSON=')[1] if 'GWJSON=' in raw else raw
raw = raw.split('\n')[0].strip()
if not raw:
    print('GWFAIL={"error":"empty output"}')
    sys.exit(0)
try:
    d = json.loads(raw)
except Exception as e:  # noqa: BLE001
    print('GWFAIL={"error":"bad json","detail":"%s"}' % str(e)[:120])
    sys.exit(0)

checks = []


def add(name, ok, detail):
    checks.append({'name': name, 'pass': bool(ok), 'detail': detail})


if 'error' in d:
    add('driver', False, d['error'])
else:
    nat = d.get('native') or {}
    s100 = d.get('s100') or {}
    s80 = d.get('s80') or {}
    back = d.get('back') or {}
    col = 'conv' if mode == 'conv' else 'chat'
    sab_w = d.get('sbW') or 0

    add('panel', d.get('panel') == 'block', d.get('panel'))

    # 100% 时列宽等于原生内容区宽度（整列铺满 bard-sidenav-content）
    if mode == 'conv':
        c = s100.get('conv')
        add('100=满宽', c and abs(c['w'] - sab_w) <= 4, {'conv': c, 'sabW': sab_w})
        n = nat.get('conv')
        n100 = (d.get('nativeOn') or {}).get('conv')
        add('80 < 满宽', s80.get('conv') and s80['conv']['w'] < sab_w - 100, {'s80': s80.get('conv'), 'sabW': sab_w})
        add('80 居中', s80.get('conv') and abs((s80['conv']['x'] - 288) - (sab_w - s80['conv']['w']) / 2) <= 6,
            s80.get('conv'))
    else:
        z = s100.get('chat')
        add('100=满宽', z and abs(z['w'] - sab_w) <= 4, {'chat': z, 'sabW': sab_w})
        z80 = s80.get('chat')
        add('80 < 满宽', z80 and z80['w'] < sab_w - 100, {'s80': z80, 'sabW': sab_w})

    # 输入框必须跟着列宽一起变（原生 660px 上限会让它在列宽超过 660 之后停住）
    ia100 = s100.get('ia')
    ia80 = s80.get('ia')
    col100 = s100.get(col)
    col80 = s80.get(col)
    # 输入框与内容列之间可能有固定的左右内边距，两种页面不同，所以比「缩窄量」而不是绝对值
    d_ia = (ia100['w'] - ia80['w']) if (ia100 and ia80 and ia100.get('w') and ia80.get('w')) else None
    d_col = (col100['w'] - col80['w']) if (col100 and col80 and col100.get('w') and col80.get('w')) else None
    add('输入框跟随列宽', d_ia is not None and d_col is not None
        and abs(d_ia - d_col) <= 8
        and d_ia >= 100,
        {'ia100': ia100, 'ia80': ia80, 'col100': col100, 'col80': col80, 'deltaIa': d_ia, 'deltaCol': d_col})
    add('滑块口径', s100.get('val') == '100%' and s80.get('val') == '80%', [s100.get('val'), s80.get('val')])
    add('--gw-k', s80.get('k') == '0.8', s80.get('k'))

    nb = d.get('nativeBtn') or {}
    add('原生按钮', nb.get('on') is False and nb.get('val') == '原生', nb)
    add('回 80%', back.get('k') == '0.8' and back.get('val') == '80%', [back.get('k'), back.get('val')])

    col_ = d.get('collapsed') or {}
    exp = d.get('expanded') or {}
    add('折叠侧栏内容区变宽', col_.get('sab') and exp.get('sab') and col_['sab']['w'] > exp['sab']['w'] + 200,
        {'collapsed': col_.get('sab'), 'expanded': exp.get('sab')})
    _c = col_.get('chat')
    add('折叠后列仍按比例', _c and col_.get('sab') and
        abs(_c['w'] - col_['sab']['w'] * 0.8) <= 6,
        {'col': col_.get('conv') or col_.get('chat'), 'sab': col_.get('sab')})

    nar = d.get('narrow') or {}
    wide = d.get('wide') or {}
    # 零态页面没有 user-query，用当前模式对应的列元素比较
    add('窗口变窄列跟随', nar.get(col) and wide.get(col) and nar[col]['w'] < wide[col]['w'] - 100,
        {'narrow': nar.get(col), 'wide': wide.get(col)})

    rb = d.get('rollback') or {}
    b = rb.get('before') or {}
    a = rb.get('after') or {}
    same = 0
    total = 0
    for k in ('ic', 'ia'):
        if b.get(k) and a.get(k):
            total += 1
            if all(abs(b[k][f] - a[k][f]) <= 2 for f in ('x', 'y', 'w', 'h')):
                same += 1
    rn = d.get('rollbackNative') or {}
    nb2 = rn.get('ia')
    add('回滚=原生位置', nb2 and a.get('ia') and all(abs(a['ia'][f] - nb2[f]) <= 2 for f in ('x', 'y', 'w', 'h')),
        {'rollback': a.get('ia'), 'native': nb2})

    add('面板关闭', d.get('closed') == 'none' and str(d.get('reopen', '')).startswith('block:'), [d.get('closed'), d.get('reopen')])

print(json.dumps({
    'mode': mode,
    'total': len(checks),
    'failed': sum(1 for c in checks if not c['pass']),
    'checks': checks,
}, ensure_ascii=False))
