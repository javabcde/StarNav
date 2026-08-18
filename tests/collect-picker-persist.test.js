import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// 源码级回归锁（同 options-config-persist.test.js 模式）：collect-picker 小窗
// 无运行 seam 可测（DOM + chrome.windows/storage），用源码断言锁定契约，防止复发：
// 1. 右键菜单点击不再直存（background 移出 buildCollectPayload），改为写候选+开窗
// 2. 保存路径必须写 lastCollectCategory 记忆、清 lastCollectCandidate 候选
// 3. 仍然保存走 /api/sites?force=true（服务端唯一约束的强制路径）
// 断言全部用代码形态锚定（Contract.STORAGE_KEYS 引用/行首缩进），避免注释子串误绿。
const backgroundSrc = readFileSync(
  fileURLToPath(new URL('../extensions/browser-bookmark/background.js', import.meta.url)),
  'utf8',
);
const pickerSrc = readFileSync(
  fileURLToPath(new URL('../extensions/browser-bookmark/collect-picker.js', import.meta.url)),
  'utf8',
);
const positionSrc = readFileSync(
  fileURLToPath(new URL('../extensions/browser-bookmark/context-menu-position.js', import.meta.url)),
  'utf8',
);
const manifestSrc = readFileSync(
  fileURLToPath(new URL('../extensions/browser-bookmark/manifest.json', import.meta.url)),
  'utf8',
);

test('右键菜单：onClicked 写候选并开窗，不再直存', () => {
  assert.doesNotMatch(backgroundSrc, /buildCollectPayload/, 'background 不得再直存收藏（直存逻辑已移入小窗）');
  assert.match(backgroundSrc, /^\s*await chrome\.windows\.create\(/m, 'onClicked 必须弹出小窗');
  assert.match(
    backgroundSrc,
    /\[\s*Contract\.STORAGE_KEYS\.LAST_COLLECT_CANDIDATE\s*\]:/,
    'onClicked 必须写入待收藏候选（url/name）供小窗读取',
  );
});

test('右键菜单：collect-result 消息分支存在（background 统一通知）', () => {
  assert.match(
    backgroundSrc,
    /message\.type === Contract\.MESSAGE_TYPES\.COLLECT_RESULT/,
    'onMessage 必须处理 collect-result 上报',
  );
  assert.match(backgroundSrc, /function notifyCollectResult/, '通知需有独立函数承载（分级文案）');
});

test('收藏小窗：保存成功写记忆分类、清候选、关窗、上报', () => {
  assert.match(
    pickerSrc,
    /\[\s*Contract\.STORAGE_KEYS\.LAST_COLLECT_CATEGORY\s*\]:/,
    '保存成功必须写入 lastCollectCategory（下次默认选中）',
  );
  assert.match(
    pickerSrc,
    /storage\.local\.remove\(\s*Contract\.STORAGE_KEYS\.LAST_COLLECT_CANDIDATE\s*\)/,
    '保存成功必须清除 lastCollectCandidate（防残留重复弹窗）',
  );
  assert.match(pickerSrc, /window\.close\(\)/, '保存成功必须自动关窗');
  assert.match(
    pickerSrc,
    /type:\s*Contract\.MESSAGE_TYPES\.COLLECT_RESULT/,
    '保存结果必须经 collect-result 消息上报 background 通知',
  );
});

test('收藏小窗：仍然保存走 force 路径，重复不关窗', () => {
  assert.match(pickerSrc, /\?force=true/, '仍然保存必须走 /api/sites?force=true');
  assert.match(pickerSrc, /els\.forceSaveBtn\.classList\.remove\('hidden'\)/, '查重重复必须显示仍然保存按钮');
  assert.match(pickerSrc, /statusCode === 409/, '409 竞态必须按重复处理');
});

test('小窗定位：跟随鼠标右键位置（content script 记录 + background 读坐标开窗）', () => {
  assert.match(manifestSrc, /"content_scripts"/, 'manifest 必须声明 content script');
  assert.match(manifestSrc, /"context-menu-position\.js"/, 'content script 文件必须注册');
  assert.match(
    backgroundSrc,
    /^\s*const pos = await chrome\.storage\.local\.get\(Contract\.STORAGE_KEYS\.CONTEXT_MENU_POSITION\)/m,
    'onClicked 必须读取右键坐标',
  );
  assert.match(backgroundSrc, /windowOptions\.left = Math\.round\(p\.x\)/, '坐标必须传入 windows.create left/top');
  assert.match(positionSrc, /addEventListener\('contextmenu'/, 'content script 必须监听 contextmenu 记录坐标');
  assert.match(positionSrc, /Math\.max\(winLeft, Math\.min\(/, '坐标必须 clamp 到屏幕内');
});
