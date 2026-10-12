// B站评论区开关 · content script
// 运行在隔离环境（isolated world）：能改 B 站页面的 DOM/CSS，
// 但读不到页面 JS 变量，也不会被页面脚本读取；仅使用 chrome.storage 存开关状态。
// 安全说明：无网络请求、无 eval/innerHTML、不读 cookie，只写自己的 4 个存储键（hidden/pos/whitelist/upCache）。
// UP 主识别走纯 DOM 解析（.up-info-container 里的 space 主页链接），不调用任何接口。
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
var PANEL_ID = 'bili-cmt-toggle-panel';
var DEFAULT_HIDDEN = true;
var UP_CACHE_MAX = 200;
var PANEL_W = 268;

/* ---------------- 状态 ---------------- */

var hidden = DEFAULT_HIDDEN;
var savedPos = null;
var styleEl = null;
var btn = null;
var observer = null;

var currentMid = null;
var currentName = '';
var whitelist = {};
var upCache = {};
var manual = false;
var manualHidden = DEFAULT_HIDDEN;
var panel = null;

function isVideoPage() {
  return /^https:\/\/www\.bilibili\.com\/(video\/|bangumi\/play\/|list\/)/.test(location.href);
}

function savePosState() {
  try { chrome.storage.local.set({ pos: savedPos }); } catch (e) {}
}
function saveManualState() {
  try { chrome.storage.local.set({ hidden: manualHidden }); } catch (e) {}
}

/* ---------------- UP 主识别（纯 DOM，无网络请求） ---------------- */

// 按可靠性降序尝试，取第一个能解析出 mid 的
var UP_SELECTORS = [
  '.up-info-container a[href*="space.bilibili.com/"]',
  '.up-info__detail a[href*="space.bilibili.com/"]',
  '.up-detail-top a.up-name',
  'a.up-name',
  '.bili-author-card a[href*="space.bilibili.com/"]'
];

function extractMid(href) {
  var m = /space\.bilibili\.com\/(\d{1,20})/.exec(String(href || ''));
  return m ? m[1] : null;
}

function readUp() {
  for (var i = 0; i < UP_SELECTORS.length; i++) {
    var a = document.querySelector(UP_SELECTORS[i]);
    if (!a) continue;
    var mid = extractMid(a.getAttribute('href'));
    if (!mid) continue;
    var name = (a.textContent || '').replace(/\s+/g, ' ').trim();
    if (name.length > 24) name = name.slice(0, 24);
    return { mid: mid, name: name };
  }
  return null;
}

function currentBv() {
  var m = /\/video\/(BV[0-9A-Za-z]+)/.exec(location.href);
  return m ? m[1] : null;
}

function trimUpCache() {
  var keys = Object.keys(upCache);
  if (keys.length <= UP_CACHE_MAX) return;
  keys.sort(function (a, b) { return (upCache[a].at || 0) - (upCache[b].at || 0); });
  var drop = keys.length - Math.floor(UP_CACHE_MAX / 2);
  for (var i = 0; i < drop; i++) delete upCache[keys[i]];
}

// 解析当前视频的 UP：优先命中 BV 缓存（避免闪烁），否则读 DOM
function resolveUp() {
  var bv = currentBv();
  if (bv && upCache[bv] && upCache[bv].mid) {
    currentMid = upCache[bv].mid;
    currentName = upCache[bv].name || '';
    return true;
  }
  var up = readUp();
  if (!up) return false;
  currentMid = up.mid;
  currentName = up.name;
  var old = bv ? upCache[bv] : null;
  if (bv && (!old || old.mid !== up.mid || old.name !== up.name)) {
    upCache[bv] = { mid: up.mid, name: up.name, at: Date.now() };
    trimUpCache();
    try { chrome.storage.local.set({ upCache: upCache }); } catch (e) {}
  }
  // 已加白但名字还是占位符时，顺手补全
  if (up.name && whitelist[up.mid] && whitelist[up.mid].name !== up.name) {
    whitelist[up.mid].name = up.name;
    try { chrome.storage.local.set({ whitelist: whitelist }); } catch (e) {}
  }
  return true;
}

/* ---------------- 白名单 ---------------- */

function hasWl(mid) {
  return !!mid && Object.prototype.hasOwnProperty.call(whitelist, mid);
}
function isWhitelisted() {
  return hasWl(currentMid);
}
function computeHidden() {
  if (manual) return manualHidden;
  if (isWhitelisted()) return false;
  return DEFAULT_HIDDEN;
}
function toggleManual() {
  manual = true;
  manualHidden = !hidden;
  apply();
  saveManualState();
}
function addToWhitelist(mid, name) {
  if (!mid) return;
  whitelist[mid] = { name: name || ('UP ' + mid), at: Date.now() };
  manual = false;
  try { chrome.storage.local.set({ whitelist: whitelist }); } catch (e) {}
  apply();
}
function removeFromWhitelist(mid) {
  if (!hasWl(mid)) return;
  delete whitelist[mid];
  manual = false;
  try { chrome.storage.local.set({ whitelist: whitelist }); } catch (e) {}
  apply();
}

// 手动添加：接受 mid 数字，或 space.bilibili.com/<mid> 主页链接
function parseMidInput(raw) {
  var out = [];
  String(raw || '').split(/[,，;；\s]+/).forEach(function (part) {
    if (!part) return;
    var m = /space\.bilibili\.com\/(\d{1,20})/.exec(part) || /^(\d{1,20})$/.exec(part);
    if (m && out.indexOf(m[1]) === -1) out.push(m[1]);
  });
  return out;
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

// document_start 时 <head> 可能还不存在，所以注入要可重试
function ensureStyle() {
  if (styleEl && styleEl.parentNode) return;
  var host = document.head || document.documentElement;
  if (!host) return;
  styleEl = document.createElement('style');
  styleEl.id = STYLE_ID;
  styleEl.textContent = '';
  host.appendChild(styleEl);
}

function apply() {
  ensureStyle();
  hidden = computeHidden();
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
  savePosState();
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
    toggleManual();
  });

  // 右键打开白名单面板；阻止浏览器菜单，并避免被页面脚本捕获
  b.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    e.stopPropagation();
    togglePanel();
  });

  var dragging = false, sx = 0, sy = 0, ox = 0, oy = 0, moved = 0;
  b.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return; // 只响应左键，右键不要进入拖动状态
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
  // 白名单 UP 加一圈绿色描边，和隐藏状态互不干扰
  btn.style.outline = isWhitelisted() ? '2px solid rgba(99,153,34,.85)' : 'none';
  btn.style.outlineOffset = '1px';
  btn.title = (hidden ? '评论区已隐藏' : '评论区已显示')
    + (isWhitelisted() ? '（白名单 UP）' : '')
    + '（左键切换，可拖动；右键管白名单；Alt+C 也可）';
}

function ensureBtn() {
  if (!document.body) return;
  if (!btn || !document.body.contains(btn)) {
    if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
    btn = createBtn();
  }
  paintBtn();
}

/* ---------------- 白名单面板（右键胶囊按钮打开） ---------------- */

// 只用 createElement + textContent 构造，不碰 innerHTML
function el(tag, text) {
  var n = document.createElement(tag);
  if (text != null) n.textContent = text;
  return n;
}

function panelBtn(text) {
  var b = el('button', text);
  b.type = 'button';
  b.style.cssText = 'padding:3px 8px;border:1px solid rgba(0,0,0,.15);border-radius:6px;'
    + 'background:#fff;cursor:pointer;font:12px/1.5 inherit;color:#333';
  return b;
}

function buildPanel() {
  var p = el('div');
  p.id = PANEL_ID;
  p.style.cssText = [
    'position:fixed', 'z-index:2147483001', 'width:' + PANEL_W + 'px',
    'box-sizing:border-box', 'background:rgba(255,255,255,.96)',
    'backdrop-filter:blur(10px)', 'border:1px solid rgba(0,0,0,.12)',
    'border-radius:12px', 'box-shadow:0 4px 18px rgba(0,0,0,.18)', 'padding:12px',
    'font:12px/1.5 system-ui,-apple-system,"Microsoft YaHei",sans-serif',
    'color:#333', 'user-select:none'
  ].join(';');

  var head = el('div', 'UP 白名单');
  head.style.cssText = 'font-size:13px;font-weight:600;margin-bottom:8px;color:#222';
  p.appendChild(head);

  // 当前视频的 UP
  var curRow = el('div');
  curRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:8px';
  var curText = el('div', currentMid
    ? ((currentName || ('UP ' + currentMid)) + ' · ' + currentMid)
    : '未识别到 UP 主');
  curText.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#555';
  curText.title = curText.textContent;
  var curBtn = panelBtn(isWhitelisted() ? '移出' : '加入');
  curBtn.disabled = !currentMid;
  if (!currentMid) curBtn.style.opacity = '.45';
  curBtn.addEventListener('click', function () {
    if (!currentMid) return;
    if (isWhitelisted()) removeFromWhitelist(currentMid);
    else addToWhitelist(currentMid, currentName);
    closePanel();
  });
  curRow.appendChild(curText);
  curRow.appendChild(curBtn);
  p.appendChild(curRow);

  // 手动添加
  var addRow = el('div');
  addRow.style.cssText = 'display:flex;gap:6px;margin-bottom:8px';
  var input = el('input');
  input.type = 'text';
  input.placeholder = 'mid 或 UP 主页链接';
  input.style.cssText = 'flex:1;min-width:0;padding:4px 6px;box-sizing:border-box;'
    + 'border:1px solid rgba(0,0,0,.15);border-radius:6px;font:12px/1.5 inherit;'
    + 'outline:none;color:#333;background:#fff';
  var addBtn = panelBtn('添加');
  addRow.appendChild(input);
  addRow.appendChild(addBtn);
  p.appendChild(addRow);

  function doAdd() {
    var mids = parseMidInput(input.value);
    input.value = '';
    if (!mids.length) return;
    mids.forEach(function (m) {
      if (hasWl(m)) return;
      addToWhitelist(m, m === currentMid ? currentName : '');
    });
    closePanel();
    openPanel();
  }
  addBtn.addEventListener('click', doAdd);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') doAdd();
    e.stopPropagation();
  });

  // 名单列表
  var listWrap = el('div');
  listWrap.style.cssText = 'max-height:190px;overflow:auto;'
    + 'border-top:1px solid rgba(0,0,0,.08);padding-top:6px';
  var keys = Object.keys(whitelist).sort(function (a, b) {
    return (whitelist[b].at || 0) - (whitelist[a].at || 0);
  });
  if (!keys.length) {
    var empty = el('div', '暂无白名单');
    empty.style.cssText = 'color:#999;padding:4px 0';
    listWrap.appendChild(empty);
  } else {
    keys.forEach(function (mid) {
      var row = el('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:3px 0';
      var t = el('div', (whitelist[mid].name || ('UP ' + mid)) + ' · ' + mid);
      t.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      t.title = t.textContent;
      if (mid === currentMid) t.style.color = '#fb7299';
      var del = el('button', '×');
      del.type = 'button';
      del.title = '移出白名单';
      del.style.cssText = 'border:none;background:transparent;cursor:pointer;'
        + 'color:#999;font-size:14px;line-height:1;padding:0 4px';
      del.addEventListener('click', function () {
        removeFromWhitelist(mid);
        closePanel();
        openPanel();
      });
      row.appendChild(t);
      row.appendChild(del);
      listWrap.appendChild(row);
    });
  }
  p.appendChild(listWrap);

  var tip = el('div', '未申请网络权限，昵称无法搜索；可粘贴 space.bilibili.com/数字 的主页链接。'
    + '手动切换只对当前视频有效。');
  tip.style.cssText = 'margin-top:8px;color:#999;font-size:11px;line-height:1.45';
  p.appendChild(tip);

  return p;
}

function placePanel() {
  if (!panel || !btn) return;
  var r = btn.getBoundingClientRect();
  if (r.top > 280) {
    panel.style.top = 'auto';
    panel.style.bottom = (window.innerHeight - r.top + 10) + 'px';
  } else {
    panel.style.bottom = 'auto';
    panel.style.top = (r.bottom + 10) + 'px';
  }
  panel.style.left = 'auto';
  panel.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
}

function openPanel() {
  closePanel();
  if (!document.body) return;
  panel = buildPanel();
  document.body.appendChild(panel);
  placePanel();
  var input = panel.querySelector('input');
  if (input) input.focus();
}

function closePanel() {
  if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
  panel = null;
}

function togglePanel() {
  if (panel) closePanel(); else openPanel();
}

// 点面板外或按 Esc 关闭（捕获阶段，避免被页面脚本拦掉）
document.addEventListener('click', function (e) {
  if (!panel) return;
  if (panel.contains(e.target) || (btn && btn.contains(e.target))) return;
  closePanel();
}, true);
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && panel) closePanel();
}, true);

/* ---------------- 消息：工具栏图标 / Alt+C ---------------- */

chrome.runtime.onMessage.addListener(function (msg) {
  if (msg && msg.type === 'toggle') {
    toggleManual();
  }
});

/* ---------------- 存储变化（多标签同步） ---------------- */

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local') return;
  if (changes.hidden && typeof changes.hidden.newValue === 'boolean') {
    // 来自其他标签页的手动切换；自己写的（值相同）跳过，避免重复 apply
    if (!manual || manualHidden !== changes.hidden.newValue) {
      manual = true;
      manualHidden = changes.hidden.newValue;
      apply();
    }
  }
  if (changes.whitelist && changes.whitelist.newValue && typeof changes.whitelist.newValue === 'object') {
    // 只有增删条目才重置手动状态；仅补全昵称时不重置，避免打断用户刚做的手动切换
    var keysChanged = Object.keys(whitelist).sort().join(',')
      !== Object.keys(changes.whitelist.newValue).sort().join(',');
    whitelist = changes.whitelist.newValue;
    if (keysChanged) manual = false;
    apply();
    if (panel) { closePanel(); openPanel(); }
  }
  if (changes.pos && changes.pos.newValue && btn) {
    savedPos = changes.pos.newValue;
    placeBtn(btn, savedPos.x, savedPos.y);
  }
});

/* ---------------- SPA 兜底 ---------------- */

var lastHref = location.href;
setInterval(function () {
  ensureStyle();
  ensureBtn();
  // UP 信息异步渲染，解析成功前每轮重试
  if (!currentMid && resolveUp()) apply();
  if (location.href !== lastHref) {
    lastHref = location.href;
    manual = false;
    currentMid = null;
    currentName = '';
    resolveUp();
    apply();
  }
}, 800);

window.addEventListener('popstate', function () { setTimeout(apply, 200); });

/* ---------------- 启动 ---------------- */

chrome.storage.local.get(['pos', 'whitelist', 'upCache'], function (d) {
  if (d && d.whitelist && typeof d.whitelist === 'object') whitelist = d.whitelist;
  if (d && d.upCache && typeof d.upCache === 'object') upCache = d.upCache;
  if (d && d.pos && typeof d.pos.x === 'number') savedPos = d.pos;

  ensureStyle();
  resolveUp();
  ensureBtn();
  apply();
});
