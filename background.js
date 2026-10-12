// 后台服务：把工具栏图标点击 / Alt+C 快捷键转发给当前标签页
// 无网络行为、无第三方代码。
'use strict';

function sendToggle(tabId) {
  if (typeof tabId === 'number') {
    chrome.tabs.sendMessage(tabId, { type: 'toggle' }, function () {
      // 无接收方（如非 B 站页面）时静默忽略
      void chrome.runtime.lastError;
    });
  }
}

chrome.action.onClicked.addListener(function (tab) {
  sendToggle(tab && tab.id);
});

chrome.commands.onCommand.addListener(function (command) {
  if (command !== 'toggle-comments') return;
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (tabs && tabs[0]) sendToggle(tabs[0].id);
  });
});

chrome.runtime.onMessage.addListener(function (msg, sender) {
  if (msg && msg.type === 'state' && sender.tab && typeof sender.tab.id === 'number') {
    chrome.action.setBadgeText({ tabId: sender.tab.id, text: msg.hidden ? 'OFF' : 'ON' });
    chrome.action.setBadgeBackgroundColor({ color: msg.hidden ? '#fb7299' : '#8a8a8a' });
  }
});
