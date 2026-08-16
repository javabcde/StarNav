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
    async list(options = {}) {
      const prefix = options.prefix || '';
      return {
        keys: Array.from(store.keys())
          .filter((name) => name.startsWith(prefix))
          .sort()
          .map((name) => ({ name })),
      };
    },
  };
}

// 匿名首页渲染所需的最小 D1 面：settings 读取（缺省走代码默认）、
// 站点/分类/标签查询全空。
function createMockEnv() {
  return {
    NAV_AUTH: createMemoryKv(),
    NAV_DB: {
      prepare(sql) {
        return {
          bind() {
            return this;
          },
          async first() {
            return null;
          },
          async all() {
            if (sql.includes('FROM site_tags st') || sql.includes('JOIN tags t')) return { results: [] };
            if (sql.includes('FROM categories c')) return { results: [] };
            if (sql.includes('FROM sites s')) return { results: [] };
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

test('renderHomePage：迁移后的 clientScript 模块完整输出（PWA/状态恢复/主题脚本在页面中）', async () => {
  const response = await renderHomePage(new Request('https://nav.example.com/'), createMockEnv(), {});
  const html = await response.text();

  assert.equal(response.status, 200);
  // 原内联客户端脚本（已迁入 pages/home/clientScript.js）仍随页面输出
  assert.ok(html.includes("serviceWorker.register('/sw.js')"), 'PWA 注册脚本应保留');
  assert.ok(html.includes('nav:pwa-state'), 'PWA 状态保存/恢复脚本应保留');
  assert.ok(html.includes('themeDefaults'), '主题默认值脚本应保留');
  // 服务端插值面仍生效（脚本函数参数透传；accent 默认值进头部主题脚本）
  assert.ok(html.includes("defaultAccent='blue'"), '默认 accent 插值应输出');
  // 主页面壳完整
  assert.ok(html.includes('<!DOCTYPE html>'), '页面壳应完整输出');
  // 字节级回归锁（String.raw 迁移）：输出必须与旧 cooked 模板等价——
  // 反斜杠不得双写、\uXXXX 转义必须已字形化（旧模板 cooked 后即字形）。
  assert.ok(html.includes('/\\*\\*([^*]+)\\*\\*/g'), '正则星号转义应为单反斜杠');
  assert.ok(!html.includes('/\\\\*\\\\*([^*]+)\\\\*\\\\*/g'), '正则星号转义不得双写');
  assert.ok(!html.includes('/\\\\*/g'), '正则星号转义不得双写');
  assert.ok(html.includes('本站已收录该网址：\\n#'), 'alert 换行应为单反斜杠转义');
  assert.ok(!html.includes('本站已收录该网址：\\\\n#'), 'alert 换行不得双写');
  assert.ok(html.includes('/^https?:\\/\\//i'), 'URL 正则应为单反斜杠');
  assert.ok(!html.includes('/^https?:\\\\/\\\\//i'), 'URL 正则不得双写');
  assert.ok(html.includes('\\\\$&'), 'highlightText 替换串应保留双反斜杠（合法唯一处）');
  assert.ok(html.includes('⏳') && !html.includes('\\u23f3'), 'u23f3 应字形化输出');
  assert.ok(html.includes('· '), 'u00b7 应字形化输出');
  assert.ok(html.includes('⚠️'), 'u26a0+ufe0f 应字形化输出');
});
