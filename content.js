// B站评论区开关 · content script
// 运行在隔离环境（isolated world）：能改 B 站页面的 DOM/CSS，
// 但读不到页面 JS 变量，也不会被页面脚本读取；仅使用 chrome.storage 存开关状态。
// 安全说明：无网络请求、无 eval/innerHTML、不读 cookie，只写自己的 2 个存储键。
'use strict';

/* ---------------- 常量 ---------------- */

var SELECTORS = [
  'bili-comments',
  '#comment', '#commentapp',
  '.bili-comment-container', '.comment-container',
  '.reply-warp', '.bb-comment',
  '[data-e2e="comment-list"]'
].join(',');

var CSS_RULE = SELECTORS + ' { display: none !important; }';

var STYLE_ID = 'bili-cmt-toggle-style';
var BTN_ID = 'bili-cmt-toggle-btn';
var DEFAULT_HIDDEN = true;

/* ---------------- 状态 ---------------- */

var hidden = DEFAULT_HIDDEN;
var savedPos = null;
var styleEl = null;
var btn = null;
var observer = null;

function isVideoPage() {
  return /^https:\/\/www\.bilibili\.com\/(video\/|bangumi\/play\/|list\/)/.test(location.href);
}

function saveState() {
  try { chrome.storage.local.set({ hidden: hidden, pos: savedPos }); } catch (e) {}
  try { chrome.runtime.sendMessage({ type: 'state', hidden: hidden }); } catch (e) {}
}

/* ---------------- 隐藏/恢复 ---------------- */

function forceHideNodes() {
  var nodes = document.querySelectorAll(SELECTORS);
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    if (getComputedStyle(el).display !== 'none') {
      el.style.setProperty('display', 'none', 'important');
    }
  }
}
function restoreNodes() {
  var nodes = document.querySelectorAll(SELECTORS);
  for (var i = 0; i < nodes.length; i++) {
    nodes[i].style.removeProperty('display');
  }
}
function startObserver() {
  if (observer) return;
  observer = new MutationObserver(function () { forceHideNodes(); });
  observer.observe(document.body, { childList: true, subtree: true });
  forceHideNodes();
}
function stopObserver() {
  if (observer) { observer.disconnect(); observer = null; }
  restoreNodes();
}

function apply() {
  var hide = hidden && isVideoPage();
  if (styleEl) styleEl.textContent = hide ? CSS_RULE : '';
  if (hide) startObserver(); else stopObserver();
  paintBtn();
  try { chrome.runtime.sendMessage({ type: 'state', hidden: hidden }); } catch (e) {}
}

/* ---------------- 悬浮胶囊按钮 ---------------- */

var BTN_CSS = [
  'position:fixed', 'z-index:2147483000', 'width:52px', 'height:52px',
  'border-radius:26px', 'border:1px solid rgba(0,0,0,.12)',
  'background:rgba(255,255,255,.62)', 'backdrop-filter:blur(8px)',
  'box-shadow:0 2px 10px rgba(0,0,0,.18)', 'cursor:pointer',
  'display:flex', 'align-items:center', 'justify-content:center',
  'gap:4px', 'font:12px/1 system-ui,-apple-system,"Microsoft YaHei",sans-serif',
  'color:#333', 'user-select:none', 'touch-action:none'
].join(';');

function makeDot(color) {
  var d = document.createElement('span');
  d.style.cssText = 'width:9px;height:9px;border-radius:50%;background:' + color + ';display:inline-block';
  return d;
}

function placeBtn(b, x, y) {
  var maxX = Math.max(0, window.innerWidth - 60);
  var maxY = Math.max(0, window.innerHeight - 60);
  x = Math.min(Math.max(0, Number(x) || 0), maxX);
  y = Math.min(Math.max(0, Number(y) || 0), maxY);
  b.style.left = x + 'px';
  b.style.top = y + 'px';
}

function savePos(b) {
  savedPos = { x: parseFloat(b.style.left) || 0, y: parseFloat(b.style.top) || 0 };
  saveState();
}

function createBtn() {
  var b = document.createElement('button');
  b.id = BTN_ID;
  b.type = 'button';
  b.style.cssText = BTN_CSS;

  var dot = makeDot('#fb7299');
  dot.id = BTN_ID + '-dot';
  var label = document.createElement('span');
  label.id = BTN_ID + '-label';
  label.textContent = '评论';
  b.appendChild(dot);
  b.appendChild(label);

  b.addEventListener('click', function () {
    if (b.dataset.dragged === '1') { b.dataset.dragged = '0'; return; }
    hidden = !hidden;
    saveState();
    apply();
  });

  var dragging = false, sx = 0, sy = 0, ox = 0, oy = 0, moved = 0;
  b.addEventListener('pointerdown', function (e) {
    dragging = true; moved = 0;
    sx = e.clientX; sy = e.clientY;
    ox = parseFloat(b.style.left) || 0;
    oy = parseFloat(b.style.top) || 0;
    try { b.setPointerCapture(e.pointerId); } catch (err) {}
  });
  b.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    var dx = e.clientX - sx, dy = e.clientY - sy;
    moved = Math.max(moved, Math.abs(dx), Math.abs(dy));
    if (moved > 4) b.dataset.dragged = '1';
    placeBtn(b, ox + dx, oy + dy);
  });
  b.addEventListener('pointerup', function (e) {
    if (!dragging) return;
    dragging = false;
    try { b.releasePointerCapture(e.pointerId); } catch (err) {}
    if (moved > 4) savePos(b);
  });

  if (savedPos) placeBtn(b, savedPos.x, savedPos.y);
  else placeBtn(b, window.innerWidth - 76, window.innerHeight - 140);

  document.body.appendChild(b);
  return b;
}

function paintBtn() {
  if (!btn) return;
  btn.style.display = isVideoPage() ? 'flex' : 'none';
  var dot = document.getElementById(BTN_ID + '-dot');
  var label = document.getElementById(BTN_ID + '-label');
  if (dot) dot.style.background = hidden ? '#fb7299' : '#c9c9c9';
  if (label) label.textContent = hidden ? '已隐' : '已显';
  btn.title = (hidden ? '评论区已隐藏' : '评论区已显示') + '（点击切换，可拖动；Alt+C 也可）';
}

function ensureBtn() {
  if (!document.body) return;
  if (!btn || !document.body.contains(btn)) {
    if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
    btn = createBtn();
  }
  paintBtn();
}

/* ---------------- 消息：工具栏图标 / Alt+C ---------------- */

chrome.runtime.onMessage.addListener(function (msg) {
  if (msg && msg.type === 'toggle') {
    hidden = !hidden;
    saveState();
    apply();
  }
});

/* ---------------- 存储变化（多标签同步） ---------------- */

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local') return;
  if (changes.hidden && typeof changes.hidden.newValue === 'boolean') {
    hidden = changes.hidden.newValue;
    apply();
  }
  if (changes.pos && changes.pos.newValue && btn) {
    savedPos = changes.pos.newValue;
    placeBtn(btn, savedPos.x, savedPos.y);
  }
});

/* ---------------- SPA 兜底 ---------------- */

var lastHref = location.href;
setInterval(function () {
  ensureBtn();
  if (location.href !== lastHref) { lastHref = location.href; apply(); }
}, 800);

window.addEventListener('popstate', function () { setTimeout(apply, 200); });

/* ---------------- 启动 ---------------- */

chrome.storage.local.get(['hidden', 'pos'], function (d) {
  if (d && typeof d.hidden === 'boolean') hidden = d.hidden;
  if (d && d.pos && typeof d.pos.x === 'number') savedPos = d.pos;

  styleEl = document.createElement('style');
  styleEl.id = STYLE_ID;
  styleEl.textContent = '';
  document.documentElement.appendChild(styleEl);

  ensureBtn();
  apply();
});
