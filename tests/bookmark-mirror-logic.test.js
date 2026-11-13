import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// bookmark-mirror-logic.js 是 UMD；仓库根 package.json 为 "type": "module"，
// 用 vm 在当前 realm 执行真实文件取全局导出（同 popup-logic.test.js 模式）。
const source = readFileSync(new URL('../extensions/browser-bookmark/bookmark-mirror-logic.js', import.meta.url), 'utf8');
vm.runInThisContext(source);
const Mirror = globalThis.BookmarkMirrorLogic;

const {
  isSafeHttpUrl,
  mirrorUrlKey,
  isMirrorableSite,
  desiredMirrorBookmarks,
  planBookmarkMirror,
  pickOtherBookmarksRootId,
} = Mirror;

test('isMirrorableSite：仅非私人 http(s) 收藏进入浏览器书签', () => {
  assert.equal(isSafeHttpUrl('https://github.com'), true);
  assert.equal(isSafeHttpUrl('HTTP://example.com'), true);
  assert.equal(isSafeHttpUrl('javascript:alert(1)'), false);

  assert.equal(isMirrorableSite({ url: 'https://a.com', visibility: 'public' }), true);
  assert.equal(isMirrorableSite({ url: 'https://a.com', visibility: 'unlisted' }), true);
  assert.equal(isMirrorableSite({ url: 'https://a.com' }), true, '缺 visibility 视为公开');
  assert.equal(isMirrorableSite({ url: 'https://a.com', visibility: 'private' }), false);
  assert.equal(isMirrorableSite({ url: 'https://a.com', visibility: 'admin_only' }), false);
  assert.equal(isMirrorableSite({ url: 'https://a.com', catelog: '私人书签' }), false, '旧数据分类兜底');
  assert.equal(isMirrorableSite({ url: 'ftp://a.com' }), false);
  assert.equal(isMirrorableSite(null), false);
});

test('mirrorUrlKey：Chrome 根路径尾斜杠归一化，带路径/query 原样', () => {
  assert.equal(mirrorUrlKey('https://github.com'), 'https://github.com');
  assert.equal(mirrorUrlKey('https://github.com/'), 'https://github.com');
  assert.equal(mirrorUrlKey('https://example.com/a/'), 'https://example.com/a/');
  assert.equal(mirrorUrlKey('https://example.com/?q=1'), 'https://example.com/?q=1');
  assert.equal(mirrorUrlKey(''), '');
});

test('planBookmarkMirror：Chrome 根路径尾斜杠不产生删建抖动', () => {
  assert.deepEqual(
    planBookmarkMirror(
      [{ id: '1', title: 'GitHub', url: 'https://github.com/' }],
      [{ title: 'GitHub', url: 'https://github.com' }],
    ),
    { create: [], update: [], remove: [] },
  );
});

test('desiredMirrorBookmarks：同 URL 去重、标题回退 URL、保持缓存顺序', () => {
  const desired = desiredMirrorBookmarks([
    { name: 'GitHub', url: 'https://github.com' },
    { name: 'GitHub 副本', url: 'https://github.com' },
    { name: '   ', url: 'https://react.dev/' },
    { name: '私人', url: 'https://secret.example.com', visibility: 'private' },
    { name: 'JS', url: 'javascript:alert(1)' },
  ]);
  assert.deepEqual(desired, [
    { title: 'GitHub', url: 'https://github.com' },
    { title: 'https://react.dev/', url: 'https://react.dev/' },
  ]);
});

test('planBookmarkMirror：create / update / remove 增量，重复现有 URL 清理', () => {
  const existing = [
    { id: '1', title: '旧标题', url: 'https://a.com' },
    { id: '2', title: 'B', url: 'https://b.com' },
    { id: '3', title: 'A 副本', url: 'https://a.com' },
    { id: '4', title: '用户文件夹' }, // 无 url：不参与
  ];
  const desired = [
    { title: '新标题', url: 'https://a.com' },
    { title: 'C', url: 'https://c.com' },
  ];
  assert.deepEqual(planBookmarkMirror(existing, desired), {
    create: [{ title: 'C', url: 'https://c.com' }],
    update: [{ id: '1', title: '新标题', url: 'https://a.com' }],
    remove: ['3', '2'],
  });
});

test('planBookmarkMirror：无变化返回空计划；目标重复 URL 只保留第一条', () => {
  assert.deepEqual(
    planBookmarkMirror([{ id: '1', title: 'A', url: 'https://a.com' }], [{ title: 'A', url: 'https://a.com' }]),
    { create: [], update: [], remove: [] },
  );
  assert.deepEqual(
    planBookmarkMirror([], [
      { title: 'A', url: 'https://a.com' },
      { title: 'A 副本', url: 'https://a.com' },
    ]),
    { create: [{ title: 'A', url: 'https://a.com' }], update: [], remove: [] },
  );
});

test('pickOtherBookmarksRootId：中英文标题优先，兜底 id 2 / 第一个根文件夹', () => {
  const tree = (children) => [{ id: '0', title: '', children }];
  assert.equal(pickOtherBookmarksRootId(tree([
    { id: '1', title: '书签栏' },
    { id: '2', title: '其他书签' },
  ])), '2');
  assert.equal(pickOtherBookmarksRootId(tree([
    { id: '1', title: 'Bookmarks Bar' },
    { id: '9', title: 'Other Bookmarks' },
  ])), '9');
  assert.equal(pickOtherBookmarksRootId(tree([{ id: '1', title: '书签栏' }, { id: '2', title: '' }])), '2');
  assert.equal(pickOtherBookmarksRootId(tree([{ id: '7', title: '自定义' }])), '7');
  assert.equal(pickOtherBookmarksRootId(null), '2');
});
