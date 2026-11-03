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
echo "== 宽度 1600x900 =="; run 1600 900
echo; echo "== 宽度 1200x800 =="; run 1200 800
echo; echo "== 滚动锚定 1500x850 =="; anchor 1500 850
echo; echo "== 滚动锚定 1100x700 =="; anchor 1100 700
echo; echo "== 思考隐藏 + 设置面板 =="; think
echo
