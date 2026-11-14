#!/bin/bash
# 无头 Chrome 跑模拟页测试；需要 /Applications/Google Chrome.app
set -u
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
HERE="$(cd "$(dirname "$0")" && pwd)"
PAGE="file://$HERE/test/mock-deepseek.html"
if [ ! -x "$CHROME" ]; then echo "找不到 Google Chrome：$CHROME"; exit 1; fi
run() {
  local w=$1 h=$2 dir="/tmp/dsw-test-$1x$2"
  rm -rf "$dir"
  "$CHROME" --headless --disable-gpu --hide-scrollbars --no-first-run --no-default-browser-check \
    --user-data-dir="$dir" --virtual-time-budget=13000 --window-size="$w,$h" --dump-dom "$PAGE" 2>/dev/null \
    | grep -o 'DSWJSON={[^<]*' | head -c 6000
}
# 滚动锚定页：改宽度后视口中心那行文字必须留在原处
anchor() {
  local w=$1 h=$2 dir="/tmp/dsw-anchor-$1x$2"
  rm -rf "$dir"
  "$CHROME" --headless --disable-gpu --hide-scrollbars --no-first-run --no-default-browser-check \
    --user-data-dir="$dir" --virtual-time-budget=20000 --window-size="$w,$h" --dump-dom \
    "file://$HERE/test/mock-scroll.html" 2>/dev/null \
    | grep -o 'DSWANCHOR={[^<]*' | head -c 6000
}
# 思考隐藏 + 设置面板：面板按需打开、开关双向生效、× 与 Esc 关闭
think() {
  local dir
  dir="$(mktemp -d /tmp/dsw-think.XXXXXX)"
  "$CHROME" --headless --disable-gpu --hide-scrollbars --no-first-run --no-default-browser-check \
    --user-data-dir="$dir" --virtual-time-budget=12000 --window-size=1400,900 --dump-dom \
    "file://$HERE/test/mock-think.html" 2>/dev/null \
    | grep -o 'DSWTHINK={[^<]*' | head -c 4000
}
# 测试前按当前脚本重新内嵌 Gemini 外壳页，避免测到旧副本
node "$HERE/test/build-gemini-run.cjs" >/dev/null

echo "== 宽度 1600x900 =="; run 1600 900
echo; echo "== 宽度 1200x800 =="; run 1200 800
echo; echo "== 滚动锚定 1500x850 =="; anchor 1500 850
echo; echo "== 滚动锚定 1100x700 =="; anchor 1100 700
echo; echo "== 思考隐藏 + 设置面板 =="; think
echo

# ===== Gemini 宽屏脚本 =====
# file:// 下 iframe 是跨源（origin null），父页拿不到它的 document；
# 用本地 http 服务起测，跑完关掉。
gwdump() {
  local mode=$1 srv=8931 dir out
  (cd "$HERE" && python3 -m http.server $srv --bind 127.0.0.1 >/dev/null 2>&1) &
  local pid=$!
  sleep 1
  dir="$(mktemp -d /tmp/gw-gemini.XXXXXX)"
  out=$("$CHROME" --headless --disable-gpu --no-first-run --no-default-browser-check \
    --user-data-dir="$dir" --virtual-time-budget=40000 --window-size=1400,1000 --dump-dom \
    "http://127.0.0.1:$srv/test/mock-gemini-run.html?mode=$mode" 2>/dev/null \
    | grep -o 'GWJSON={[^<]*')
  kill $pid 2>/dev/null
  wait $pid 2>/dev/null
  echo "$out"
}
gw() { gwdump "$1" | python3 "$HERE/test/gw-check.py" "$1" 2>/dev/null || echo "GWFAIL"; }
echo; echo "== Gemini 宽度（会话）=="; gw conv
echo; echo "== Gemini 宽度（零态首页）=="; gw zero
