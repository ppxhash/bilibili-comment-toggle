// B站评论区开关 · content script
// 运行在隔离环境（isolated world）：能改 B 站页面的 DOM/CSS，
// 但读不到页面 JS 变量，也不会被页面脚本读取；仅使用 chrome.storage 存开关状态。
// 安全说明：无网络请求、无 eval/innerHTML、不读 cookie，只写自己的 6 个存储键（hidden/pos/whitelist/upCache/ads/userHides）。
// 广告屏蔽为 DOM 层隐藏：以「广告/推广」标注为锚点（《广告法》要求广告可识别，该标注
// 比类名稳定）向上判定容器，叠加实测类名兜底；标题里带这些词的一律不动，判不出就不藏。
// 另有一条静态 DNR 规则拦截实测抓到的广告接口（见 rules.json），规则随扩展打包、可全文审计。
// 「点谁藏谁」为手动兜底：用户在面板进入选取模式后点击元素即藏，选择器存本地，可随时恢复。
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
// 命中后要藏起来的卡片容器（feed-card 是首页给卡片套的外壳）
var AD_CARD_SELECTOR = '.bili-video-card, .feed-card';
// 已知广告容器：实测证据（用户 F12 取证：B站横幅广告类名 strip-ad = 横幅广告）。
// 类名会随改版过时，所以只是兜底；主力是下面的「广告」标注锚点。
var KNOWN_AD_SELECTORS = '.strip-ad-inner';
// 祖先类名按连字符分词后，整词命中这些词 → 视为广告容器线索（ad-report-inner / strip-ad-inner 都能命中）
var AD_HINT_TOKENS = ['ad', 'ads', 'advert', 'sponsor', 'promo'];

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
var adsHidden = true; // 广告屏蔽默认开（与评论区默认隐藏同风的“姿态友好”）
var userHides = []; // 手动隐藏：用户点选元素生成的 CSS 选择器列表
var picking = false; // 是否处于选取模式
var highlightedNodes = []; // 选取模式下高亮的元素（含同选择器的所有匹配）
var styleUserHide = null;
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

/* ---------------- 广告屏蔽（DOM 层隐藏） ---------------- */
// 双层证据，任一命中即藏：
// 1) 已知广告容器（实测类名兜底）；
// 2) 「广告 / 推广」标注锚点——《广告法》要求广告必须可识别，这个标注是法律义务、
//    比类名稳定得多。锚点命中后从标注往上找容器：优先类名带广告线索的祖先
//    （取最靠外的一个，封顶 5 层），否则退回信息流卡片判定；都判不出就只当没看见，不猜。
// 评论区内的文本不参与匹配（避免误伤评论内容）；藏过的元素打 data-ad-hidden，
// 关闭屏蔽时只撤自己打过的标记，不碰页面原有样式。

function isAdBadge(node) {
  var t = (node.textContent || '').trim();
  return t === '广告' || t === '推广';
}

// 类名按连字符分词后整词比对，避免 header / read 之类误命中
function hasAdHintClass(el) {
  var cls = typeof el.className === 'string' ? el.className : '';
  if (!cls) return false;
  var tokens = cls.split(/\s+/);
  for (var i = 0; i < tokens.length; i++) {
    var parts = tokens[i].split('-');
    for (var j = 0; j < parts.length; j++) {
      if (AD_HINT_TOKENS.indexOf(parts[j]) !== -1) return true;
    }
  }
  return false;
}

function hideAdEl(el) {
  if (!el || el === document.body || el === document.documentElement) return;
  if (isOwnUi(el)) return;
  if (el.getAttribute('data-ad-hidden') === '1') return;
  el.style.setProperty('display', 'none', 'important');
  el.setAttribute('data-ad-hidden', '1');
}

function inCommentSection(el) {
  return !!(el.closest && el.closest(SELECTORS));
}

// 从标注元素往上判定要藏的容器；判不出返回 null（不猜）
function adContainerFromLabel(label) {
  var hinted = null;
  var node = label.parentElement;
  for (var d = 0; d < 5 && node && node !== document.body; d++) {
    if (hasAdHintClass(node)) hinted = node; // 保留最靠外的带线索祖先
    node = node.parentElement;
  }
  if (hinted) return hinted;
  var card = label.closest(AD_CARD_SELECTOR);
  if (!card) return null;
  var outer = card.parentElement ? card.parentElement.closest(AD_CARD_SELECTOR) : null;
  return outer || card;
}

function hideKnownAds() {
  var nodes = document.querySelectorAll(KNOWN_AD_SELECTORS);
  for (var i = 0; i < nodes.length; i++) hideAdEl(nodes[i]);
}

function hideLabeledAds() {
  var leaves = document.querySelectorAll('span, a, div, i, em, b, small');
  for (var i = 0; i < leaves.length; i++) {
    var leaf = leaves[i];
    if (leaf.children.length) continue;
    if (leaf.getAttribute('data-ad-checked') === '1') continue;
    if (!isAdBadge(leaf)) continue;
    if (isOwnUi(leaf) || inCommentSection(leaf)) {
      leaf.setAttribute('data-ad-checked', '1'); // 明确排除的，标记后不再扫
      continue;
    }
    var container = adContainerFromLabel(leaf);
    if (!container) continue; // 判定失败：不标记，下轮重试（DOM 可能还在渲染中）
    leaf.setAttribute('data-ad-checked', '1');
    hideAdEl(container);
    // 标注在容器外（浮层式标注）时，连标注一起藏
    if (!container.contains(leaf)) hideAdEl(leaf);
  }
}

function sweepAds() {
  if (!adsHidden) return;
  hideKnownAds();
  hideLabeledAds();
}

function restoreAds() {
  var hidden = document.querySelectorAll('[data-ad-hidden="1"]');
  for (var i = 0; i < hidden.length; i++) {
    var el = hidden[i];
    el.style.removeProperty('display');
    el.removeAttribute('data-ad-hidden');
    el.removeAttribute('data-ad-checked');
    var inner = el.querySelectorAll('[data-ad-checked="1"]');
    for (var j = 0; j < inner.length; j++) inner[j].removeAttribute('data-ad-checked');
  }
}

function saveAdsState() {
  try { chrome.storage.local.set({ ads: adsHidden }); } catch (e) {}
}

function toggleAds() {
  adsHidden = !adsHidden;
  saveAdsState();
  if (!adsHidden) restoreAds();
  paintBtn();
}

/* ---------------- 手动隐藏（点谁藏谁） ---------------- */
// 面板进入选取模式 → 悬停高亮（含所有同选择器匹配，藏多少看得见）→ 点击即藏。
// 选择器生成优先 id，其次 tag.class，匹配不唯一时逐级加祖先限定（封顶 4 层）；
// 找不到安全锚点就放弃，不瞎猜。自己的 UI 不可选。全部本地存储，可一键恢复。

var PICKER_BAR_ID = 'bili-cmt-picker-bar';
var USERHIDE_STYLE_ID = 'bili-cmt-userhide-style';
var USERHIDE_MAX = 50;

function cssClassPart(node) {
  var cls = [];
  if (node.classList) {
    for (var i = 0; i < node.classList.length && cls.length < 2; i++) {
      var c = node.classList[i];
      if (/^[a-zA-Z][\w-]*$/.test(c)) cls.push(c);
    }
  }
  return node.tagName.toLowerCase() + (cls.length ? '.' + cls.join('.') : '');
}

function selectorMatchCount(sel) {
  try { return document.querySelectorAll(sel).length; } catch (e) { return -1; }
}

function buildSelector(el) {
  if (!el || el === document.body || el === document.documentElement) return null;
  if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id)) return '#' + CSS.escape(el.id);
  var sel;
  if (el.classList && el.classList.length) {
    sel = cssClassPart(el);
  } else {
    // 自身没类名：往上找最近的有类名祖先，中间用 nth-child 串起来
    var chain = [];
    var node = el;
    while (node && node !== document.body && !(node.classList && node.classList.length)) {
      if (!node.parentNode) return null;
      chain.push(node.tagName.toLowerCase() + ':nth-child(' + (Array.prototype.indexOf.call(node.parentNode.children, node) + 1) + ')');
      node = node.parentNode;
    }
    if (!node || node === document.body) return null;
    chain.push(cssClassPart(node));
    chain.reverse();
    sel = chain.join(' > ');
  }
  // 匹配不唯一就逐级加祖先限定（封顶 4 层，避免选择器过长）
  var up = el.parentElement;
  for (var d = 0; d < 4 && selectorMatchCount(sel) > 1 && up && up !== document.body; d++) {
    if (up.id && /^[a-zA-Z][\w-]*$/.test(up.id)) {
      sel = '#' + CSS.escape(up.id) + ' ' + sel;
      break;
    }
    sel = cssClassPart(up) + ' ' + sel;
    up = up.parentElement;
  }
  return selectorMatchCount(sel) > 0 ? sel : null;
}

function isOwnUi(el) {
  if (!el || !el.closest) return false;
  return !!el.closest('#' + BTN_ID + ', #' + PANEL_ID + ', #' + PICKER_BAR_ID + ', #' + USERHIDE_STYLE_ID);
}

function ensureUserHideStyle() {
  if (styleUserHide && styleUserHide.parentNode) return;
  var host = document.head || document.documentElement;
  if (!host) return;
  styleUserHide = document.createElement('style');
  styleUserHide.id = USERHIDE_STYLE_ID;
  host.appendChild(styleUserHide);
}

function paintUserHides() {
  ensureUserHideStyle();
  if (!styleUserHide) return;
  var css = userHides.map(function (h) {
    return h.sel + ' { display: none !important; }';
  }).join('\n');
  if (styleUserHide.textContent !== css) styleUserHide.textContent = css;
}

function addUserHide(sel) {
  if (!sel) return false;
  for (var i = 0; i < userHides.length; i++) {
    if (userHides[i].sel === sel) return false; // 已藏过
  }
  userHides.unshift({ sel: sel, at: Date.now() });
  if (userHides.length > USERHIDE_MAX) userHides.length = USERHIDE_MAX;
  try { chrome.storage.local.set({ userHides: userHides }); } catch (e) {}
  paintUserHides();
  return true;
}

function removeUserHide(sel) {
  var changed = false;
  userHides = userHides.filter(function (h) {
    if (h.sel === sel) { changed = true; return false; }
    return true;
  });
  if (!changed) return;
  try { chrome.storage.local.set({ userHides: userHides }); } catch (e) {}
  paintUserHides();
}

function toast(text) {
  if (!document.body) return;
  var t = el('div', text);
  t.style.cssText = 'position:fixed;z-index:2147483003;left:50%;bottom:96px;transform:translateX(-50%);'
    + 'background:rgba(20,20,24,.92);color:#fff;padding:7px 14px;border-radius:8px;pointer-events:none;'
    + 'font:12px/1.5 system-ui,-apple-system,"Microsoft YaHei",sans-serif;user-select:none;'
    + 'box-shadow:0 4px 14px rgba(0,0,0,.28)';
  document.body.appendChild(t);
  setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 2200);
}

function clearHighlight() {
  for (var i = 0; i < highlightedNodes.length; i++) {
    highlightedNodes[i].style.outline = '';
    highlightedNodes[i].style.outlineOffset = '';
  }
  highlightedNodes = [];
}

function pickerHighlight(el) {
  clearHighlight();
  if (!el || isOwnUi(el)) return;
  var sel = buildSelector(el);
  if (!sel) return;
  var nodes;
  try { nodes = document.querySelectorAll(sel); } catch (e) { return; }
  for (var i = 0; i < nodes.length; i++) {
    if (isOwnUi(nodes[i])) continue;
    nodes[i].style.outline = '2px solid #f5a623';
    nodes[i].style.outlineOffset = '-2px';
    highlightedNodes.push(nodes[i]);
  }
}

function buildPickerBar() {
  var bar = el('div');
  bar.id = PICKER_BAR_ID;
  bar.style.cssText = [
    'position:fixed', 'z-index:2147483002', 'left:50%', 'top:16px',
    'transform:translateX(-50%)', 'display:flex', 'align-items:center', 'gap:10px',
    'background:rgba(20,20,24,.92)', 'color:#fff', 'padding:8px 14px',
    'border-radius:10px', 'box-shadow:0 4px 16px rgba(0,0,0,.3)',
    'font:12px/1.5 system-ui,-apple-system,"Microsoft YaHei",sans-serif', 'user-select:none'
  ].join(';');
  bar.appendChild(el('span', '选取模式：点击页面上的广告元素即可隐藏（Esc 取消）'));
  var cancel = el('button', '取消');
  cancel.type = 'button';
  cancel.style.cssText = 'padding:2px 10px;border:1px solid rgba(255,255,255,.4);border-radius:6px;'
    + 'background:transparent;color:#fff;cursor:pointer;font:12px/1.5 inherit';
  cancel.addEventListener('click', function () { stopPicking(); });
  bar.appendChild(cancel);
  return bar;
}

function startPicking() {
  if (picking) return;
  closePanel();
  if (!document.body) return;
  picking = true;
  document.body.appendChild(buildPickerBar());
  document.addEventListener('mouseover', onPickOver, true);
  document.addEventListener('click', onPickClick, true);
  document.addEventListener('keydown', onPickKey, true);
}

function stopPicking() {
  if (!picking) return;
  picking = false;
  clearHighlight();
  var bar = document.getElementById(PICKER_BAR_ID);
  if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
  document.removeEventListener('mouseover', onPickOver, true);
  document.removeEventListener('click', onPickClick, true);
  document.removeEventListener('keydown', onPickKey, true);
}

function onPickOver(e) {
  if (!picking) return;
  pickerHighlight(e.target);
}

function onPickClick(e) {
  if (!picking) return;
  e.preventDefault();
  e.stopPropagation();
  if (isOwnUi(e.target)) { stopPicking(); return; } // 点到自己的 UI 视为取消
  var sel = buildSelector(e.target);
  stopPicking();
  if (!sel) { toast('这个元素选不了，换一个更具体的'); return; }
  if (addUserHide(sel)) toast('已隐藏，可在右键面板里恢复');
  else toast('这个元素已经在隐藏列表里了');
}

function onPickKey(e) {
  if (e.key === 'Escape') stopPicking();
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
    + '（左键切换，可拖动；右键管白名单；Alt+C 也可）'
    + (adsHidden ? '；广告屏蔽中（Alt+A 可关）' : '；广告未屏蔽（Alt+A 可开）');
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

  var head = el('div', '设置');
  head.style.cssText = 'font-size:13px;font-weight:600;margin-bottom:8px;color:#222';
  p.appendChild(head);

  // 广告屏蔽开关
  var adsRow = el('div');
  adsRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:10px';
  var adsText = el('div', '广告屏蔽');
  adsText.style.cssText = 'flex:1;color:#555';
  var adsBtn = panelBtn(adsHidden ? '已开启' : '已关闭');
  adsBtn.addEventListener('click', function () {
    toggleAds();
    closePanel();
    openPanel();
  });
  adsRow.appendChild(adsText);
  adsRow.appendChild(adsBtn);
  p.appendChild(adsRow);

  var wlHead = el('div', 'UP 白名单');
  wlHead.style.cssText = 'font-size:12px;font-weight:600;margin:2px 0 6px;color:#666';
  p.appendChild(wlHead);

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

  // 手动隐藏（点谁藏谁）
  var uhHead = el('div', '手动隐藏');
  uhHead.style.cssText = 'font-size:12px;font-weight:600;margin:10px 0 6px;color:#666';
  p.appendChild(uhHead);

  var uhRow = el('div');
  uhRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:6px';
  var pickBtn = panelBtn('选取元素');
  pickBtn.addEventListener('click', function () { startPicking(); });
  uhRow.appendChild(pickBtn);
  var uhHint = el('div', '进入后点页面元素即藏');
  uhHint.style.cssText = 'flex:1;color:#999;font-size:11px';
  uhRow.appendChild(uhHint);
  p.appendChild(uhRow);

  var uhList = el('div');
  uhList.style.cssText = 'max-height:120px;overflow:auto;'
    + 'border-top:1px solid rgba(0,0,0,.08);padding-top:6px';
  if (!userHides.length) {
    var uhEmpty = el('div', '暂无');
    uhEmpty.style.cssText = 'color:#999;padding:4px 0';
    uhList.appendChild(uhEmpty);
  } else {
    userHides.forEach(function (h) {
      var row = el('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:3px 0';
      var t = el('div', h.sel);
      t.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:#555';
      t.title = h.sel;
      var back = el('button', '恢复');
      back.type = 'button';
      back.title = '恢复显示该元素';
      back.style.cssText = 'border:none;background:transparent;cursor:pointer;color:#999;font-size:11px;padding:0 4px';
      back.addEventListener('click', function () {
        removeUserHide(h.sel);
        closePanel();
        openPanel();
      });
      row.appendChild(t);
      row.appendChild(back);
      uhList.appendChild(row);
    });
  }
  p.appendChild(uhList);

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
  } else if (msg && msg.type === 'toggle-ads') {
    toggleAds();
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
  if (changes.ads && typeof changes.ads.newValue === 'boolean') {
    // 自己刚写的那次也会回来，值相同就跳过，避免重复 apply
    if (adsHidden !== changes.ads.newValue) {
      adsHidden = changes.ads.newValue;
      if (!adsHidden) restoreAds();
      paintBtn();
      if (panel) { closePanel(); openPanel(); }
    }
  }
  if (changes.userHides && Array.isArray(changes.userHides.newValue)) {
    // 其他标签页增删了手动隐藏项
    userHides = changes.userHides.newValue;
    paintUserHides();
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
  sweepAds();
  paintUserHides();
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

chrome.storage.local.get(['pos', 'whitelist', 'upCache', 'ads', 'userHides'], function (d) {
  if (d && d.whitelist && typeof d.whitelist === 'object') whitelist = d.whitelist;
  if (d && d.upCache && typeof d.upCache === 'object') upCache = d.upCache;
  if (d && d.pos && typeof d.pos.x === 'number') savedPos = d.pos;
  if (d && typeof d.ads === 'boolean') adsHidden = d.ads;
  if (d && Array.isArray(d.userHides)) userHides = d.userHides;

  ensureStyle();
  resolveUp();
  ensureBtn();
  apply();
  sweepAds();
  paintUserHides();
});
