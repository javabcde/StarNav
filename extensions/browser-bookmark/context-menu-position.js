// 右键坐标记录（content script，注入所有 http/https 页面）：
// contextMenus.onClicked 的 info 不含鼠标位置，小窗无法跟随右键落点。
// 浏览器右键菜单弹出前必然触发页面的 contextmenu 事件——此处把屏幕坐标
// 暂存 storage.local，background 开窗时读取并传入 windows.create({ left, top })。
// 坐标 clamp 到当前窗口所在屏幕内，保证小窗完整可见（多屏负坐标同样成立）。
// 未注入页面（chrome:// 等）无记录 → background 兜底居中开窗。
(function () {
  'use strict';

  const PICKER_WIDTH = 340;
  const PICKER_HEIGHT = 480;

  document.addEventListener('contextmenu', (event) => {
    // window.screenX/screenY 是窗口外缘相对主屏原点的位置（多屏可为负），
    // clientX/clientY 相对视口——纵向隔着标签栏+地址栏（outerHeight-innerHeight），
    // 横向视口左缘与窗口左缘对齐（无横向 chrome），只需补纵向偏移
    const winLeft = window.screenX;
    const winTop = window.screenY;
    const chromeY = window.outerHeight - window.innerHeight;
    const screenRight = winLeft + window.screen.width;
    const screenBottom = winTop + window.screen.height;
    // clamp：窗口左上角尽量贴近鼠标落点，但不越出当前屏幕
    const left = Math.max(winLeft, Math.min(winLeft + event.clientX, screenRight - PICKER_WIDTH));
    const top = Math.max(winTop, Math.min(winTop + chromeY + event.clientY, screenBottom - PICKER_HEIGHT));
    // 键名与 Contract.STORAGE_KEYS.CONTEXT_MENU_POSITION 一致（content script 为
    // 隔离世界，无法读取 extension-contract.js，此处字面量，background 侧走契约键）
    chrome.storage.local.set({
      'lastContextMenuPosition': {
        x: Math.round(left),
        y: Math.round(top),
        ts: Date.now(),
      },
    }).catch(() => {});
  }, true);
})();
