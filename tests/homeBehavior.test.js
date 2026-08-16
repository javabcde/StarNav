// 首页渲染行为测试（renderHomePage 分支行为）——2026-08-16 架构评审候选 5 补齐：
// homeRender.test.js 此前全是字节锁/契约断言，零行为测试；本文件覆盖
// 私人书签锁定、tag 过滤、布局片段、i18n 收编（?lang=en 标题走 t('allBookmarks')）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { renderHomePage } from '../src/pages/home.js';

function createMemoryKv() {
  const store = new Map();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, String(value));
    },
    async delete(key) {
      store.delete(key);
    },
    async list() {
      return { keys: [] };
    },
  };
}

const PRIVATE_CATEGORY = {
  id: 1, name: '私人书签', parent_id: null, sort_order: 1, icon: null, color: null, description: null,
  site_count: 1, child_count: 0,
};

function createMockEnv({ categories = [], sites = [], siteTags = [] } = {}) {
  return {
    NAV_AUTH: createMemoryKv(),
    NAV_DB: {
      prepare(sql) {
        const binds = [];
        return {
          bind(...args) {
            binds.push(...args);
            return this;
          },
          async first() {
            return null;
          },
          async all() {
            if (sql.includes('FROM site_tags st')) return { results: siteTags };
            if (sql.includes('FROM categories c')) return { results: categories };
            if (sql.includes('FROM sites s')) return { results: sites };
            return { results: [] };
          },
          async run() {
            return { success: true, meta: { changes: 1 } };
          },
        };
      },
      async batch() {
        return [];
      },
    },
  };
}

function fullSite(overrides = {}) {
  return {
    id: 1, name: '星空图床', url: 'https://img.example.com', logo: '', desc: '', catelog: '工具',
    category_id: null, space_id: null, visibility: 'public', sort_order: 1, hits: 0,
    last_visit_time: null, last_checked_at: null, last_status_code: null, last_error: null,
    sync_source: 'manual', browser_bookmark_id: null, create_time: '2026-01-01T00:00:00Z',
    update_time: '2026-01-01T00:00:00Z', tags: [],
    ...overrides,
  };
}

test('renderHomePage：私人书签分类未解锁渲染解锁框（不渲染书签卡片）', async () => {
  const env = createMockEnv({ categories: [PRIVATE_CATEGORY], sites: [fullSite({ catelog: '私人书签', visibility: 'private' })] });
  const response = await renderHomePage(new Request('https://nav.example.com/?catalog=%E7%A7%81%E4%BA%BA%E4%B9%A6%E7%AD%BE'), env, {});
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.ok(html.includes('私人书签已上锁'), '应渲染私人书签解锁说明');
  assert.ok(html.includes('name="password"'), '应渲染密码输入框');
  assert.ok(!html.includes('data-name="星空图床"'), '锁定状态下不得渲染书签卡片');
});

test('renderHomePage：tag 过滤反映在标题计数', async () => {
  const env = createMockEnv({
    sites: [
      fullSite({ id: 1, name: '甲', tags: ['图床'] }),
      fullSite({ id: 2, name: '乙', url: 'https://other.example.com', tags: ['工具'] }),
    ],
    siteTags: [
      { site_id: 1, name: '图床' },
      { site_id: 2, name: '工具' },
    ],
  });
  const response = await renderHomePage(new Request('https://nav.example.com/?tag=%E5%9B%BE%E5%BA%8A'), env, {});
  const html = await response.text();

  assert.ok(html.includes('#图床'), '标题应显示 tag 标签');
  assert.ok(html.includes('1 个网站'), '计数应只算命中 tag 的站点');
});

test('renderHomePage：?layout=grid 返回片段响应（无页面壳）+ X-Sites-Total', async () => {
  const env = createMockEnv({ sites: [fullSite()] });
  const response = await renderHomePage(new Request('https://nav.example.com/?layout=grid'), env, {});
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Sites-Total'), '1');
  assert.ok(!html.includes('<!DOCTYPE html>'), '片段响应不得含页面壳');
  assert.ok(html.includes('data-name="星空图床"'), '片段应含书签卡片');
});

test('renderHomePage：?lang=en 标题走 i18n（全部收藏 → All bookmarks）', async () => {
  const env = createMockEnv();
  const response = await renderHomePage(new Request('https://nav.example.com/?lang=en'), env, {});
  const html = await response.text();

  assert.ok(html.includes('All bookmarks'), '英文标题应来自 t(allBookmarks)');
  assert.ok(!html.includes('全部收藏'), '不得残留硬编码中文标题');
});

test('renderHomePage：排序热门时标题显示热门书签且按 hits 降序', async () => {
  const env = createMockEnv({
    sites: [
      fullSite({ id: 1, hits: 5, last_visit_time: '2026-08-01T00:00:00Z' }),
      fullSite({ id: 2, hits: 3, last_visit_time: '2026-08-02T00:00:00Z' }),
    ],
  });
  const response = await renderHomePage(new Request('https://nav.example.com/?sort=hot'), env, {});
  const html = await response.text();

  assert.ok(html.includes('热门书签'), 'hot 排序标题应走 t(hotBookmarks)');
  const firstCard = html.indexOf('data-id="1"');
  const secondCard = html.indexOf('data-id="2"');
  assert.ok(firstCard !== -1 && secondCard !== -1, '两张卡片都应渲染');
  assert.ok(firstCard < secondCard, 'hot 排序应按 hits 降序（5 在 3 前）');
});
