/* global chrome */
// ============================================================
// CSS Selector Hider - 后台 service worker
// ============================================================
// 只做一件事：点扩展工具栏图标时打开设置页。
// 不监听任何网络 / 标签页事件，不持有任何状态。
// ============================================================

// IDEA 内置的 chrome 类型定义偏旧，不认识 MV3 的 action API，
// 会误报“未解析的变量 / 弃用符号”。运行时没问题，这里关掉静态提示。
//noinspection JSUnresolvedVariable,JSDeprecatedSymbols
chrome.action.onClicked.addListener(() => {
    chrome.runtime.openOptionsPage();
});