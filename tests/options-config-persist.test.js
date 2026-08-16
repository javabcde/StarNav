import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// 源码级回归锁（同 popup-view-persist.test.js 模式）：options.js 无运行 seam 可测
// （DOM + chrome.storage），用源码断言锁定配置读写契约，防止两类复发：
// 1. loadOptions 不把 token 回填输入框（此前误删导致打开设置页 token 为空）
// 2. saveOptions/testConnection 的 storage.sync.set 不持久化 token（鉴权链路断裂）
// 3. browseCacheMinutes 默认值必须来自契约常量（避免字面量 5 与契约漂移）
const optionsSrc = readFileSync(
  fileURLToPath(new URL('../extensions/browser-bookmark/options.js', import.meta.url)),
  'utf8',
);

test('options 配置持久化：loadOptions 回填 token 与 baseUrl', () => {
  const match = optionsSrc.match(/async function loadOptions\(\)[\s\S]*?\n}/);
  assert.ok(match, '应存在 loadOptions 定义');
  assert.match(match[0], /els\.token\.value = syncData\.token \|\| '';/, 'token 必须从 storage 回填输入框');
  assert.match(match[0], /els\.baseUrl\.value = syncData\.baseUrl \|\| '';/, 'baseUrl 必须从 storage 回填输入框');
});

test('options 配置持久化：saveOptions 与 testConnection 均持久化 token', () => {
  const saveMatch = optionsSrc.match(/async function saveOptions\([\s\S]*?\n}/);
  assert.ok(saveMatch, '应存在 saveOptions 定义');
  assert.match(saveMatch[0], /^\s+token,$/m, 'saveOptions 的 sync.set 必须写入 token');

  const testMatch = optionsSrc.match(/async function testConnection\(\)[\s\S]*?\n}/);
  assert.ok(testMatch, '应存在 testConnection 定义');
  assert.match(testMatch[0], /^\s+token,$/m, 'testConnection 的 sync.set 必须写入 token');
});

test('options 配置持久化：browseCacheMinutes 默认值引用契约常量', () => {
  const occurrences = optionsSrc.match(/browseCacheMinutes\.value : \d+/g) || [];
  assert.equal(occurrences.length, 0, 'browseCacheMinutes 默认值不得为字面量数字（必须引用 Contract.BROWSE_CACHE_DEFAULT_MINUTES）');
  assert.ok(optionsSrc.includes('Contract.BROWSE_CACHE_DEFAULT_MINUTES'), '默认值应来自契约常量');
});
