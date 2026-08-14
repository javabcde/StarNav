import test from 'node:test';
import assert from 'node:assert/strict';

import { extractHtmlFavicon, getFavicon } from '../src/lib/favicon.js';

test('extractHtmlFavicon：绝对/相对/协议相对/缺失四态', () => {
  const base = 'https://example.test/';
  assert.equal(
    extractHtmlFavicon('<link rel="icon" href="/custom.png">', base),
    'https://example.test/custom.png',
    '相对路径应解析为绝对 URL',
  );
  assert.equal(
    extractHtmlFavicon('<link rel="icon" href="https://cdn.example.test/i.ico">', base),
    'https://cdn.example.test/i.ico',
    '绝对 URL 原样返回',
  );
  assert.equal(
    extractHtmlFavicon('<link rel="shortcut icon" href="//cdn.example.test/s.ico">', base),
    'https://cdn.example.test/s.ico',
    '协议相对补 https',
  );
  assert.equal(extractHtmlFavicon('<link rel="stylesheet" href="/x.css">', base), '', '无 icon link 返回空');
  assert.equal(extractHtmlFavicon('<link rel="icon" sizes="any" href="">', base), '', '空 href 返回空');
});

test('getFavicon：HTML link 图标（自定义路径，聚合源和 /favicon.ico 都没有）能抓到', async (t) => {
  // 5 个聚合/标准源全 404，/favicon.ico 也 404，但源站 HTML 里
  // 有 <link rel="icon" href="/custom-icon.png">（浏览器标签页图标的真实来源）
  const fetchMock = t.mock.method(globalThis, 'fetch', async (input) => {
    const u = String(input);
    if (u.includes('faviconextractor') || u.includes('favicon.im') || u.includes('google.com/s2') || u.includes('duckduckgo')) {
      return new Response('x', { status: 404 });
    }
    if (u === 'https://example.test/favicon.ico') return new Response('x', { status: 404 });
    if (u === 'https://example.test/') {
      return new Response('<!DOCTYPE html><html><head><link rel="icon" href="/custom-icon.png"></head></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }
    if (u === 'https://example.test/custom-icon.png') {
      return new Response('img', { status: 200, headers: { 'content-type': 'image/png' } });
    }
    return new Response('x', { status: 404 });
  });

  const favicon = await getFavicon('https://example.test');

  assert.equal(favicon, 'https://example.test/custom-icon.png', '应通过 HTML link 找到自定义路径图标');
  assert.equal(fetchMock.mock.callCount(), 6, '5 聚合源 + 源站 HTML 共 6 次尝试');
});
