import test from 'node:test';
import assert from 'node:assert/strict';

import { renderSiteLockPage } from '../src/pages/home/siteLock.js';
import { renderPrivateBookmarkUnlockBox, renderPrivateBookmarkPasswordPage } from '../src/pages/home/privateAccess.js';

// 锁页时长 `<select>` 渲染自解锁会话词汇（durationOptions）的回归锁：
// 五档键、默认档 12h 选中、标签齐全——防止词汇收编后退回硬编码。

const OPTION_RE = /<option value="(session|1h|12h|7d|30d)"([^>]*)>([^<]+)<\/option>/g;

function collectOptions(html) {
  const out = [];
  let match;
  while ((match = OPTION_RE.exec(html)) !== null) {
    out.push({ key: match[1], selected: match[2].includes('selected'), label: match[3].trim() });
  }
  return out;
}

test('整站锁锁页：时长下拉五档齐全、12h 默认选中', async () => {
  const res = renderSiteLockPage({ i18n: { lang: 'zh-CN', dir: 'ltr', th: (k) => k } });
  const options = collectOptions(await res.text());
  assert.equal(options.length, 5);
  assert.deepEqual(options.map((o) => o.key), ['session', '1h', '12h', '7d', '30d']);
  assert.equal(options.find((o) => o.key === '12h').selected, true);
  assert.ok(options.find((o) => o.key === 'session').label.includes('仅本次会话'));
  assert.equal(options.find((o) => o.key === '1h').label, '1 小时');
});

test('私人书签锁页：解锁框与密码页时长下拉均五档齐全、12h 默认', async () => {
  const boxOptions = collectOptions(renderPrivateBookmarkUnlockBox('私人书签'));
  assert.equal(boxOptions.length, 5);
  assert.equal(boxOptions.find((o) => o.key === '12h').selected, true);
  assert.equal(boxOptions.find((o) => o.key === 'session').label, '仅本次会话');

  const pageRes = renderPrivateBookmarkPasswordPage({ catalog: '私人书签', i18n: { lang: 'zh-CN', dir: 'ltr', th: (k) => k } });
  const pageOptions = collectOptions(await pageRes.text());
  assert.equal(pageOptions.length, 5);
  assert.equal(pageOptions.find((o) => o.key === '12h').selected, true);
  assert.ok(pageOptions.find((o) => o.key === 'session').label.includes('关闭浏览器后失效'));
});
