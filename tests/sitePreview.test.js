import test from 'node:test';
import assert from 'node:assert/strict';

// 站点预览抓取（lib/sitePreview.js）行为测试：meta 抽取、URL 归一、非 HTML 回退、错误路径。
import { fetchSitePreview } from '../src/lib/sitePreview.js';

const SAMPLE_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>示例站点</title>
  <meta name="description" content="这是站点描述">
  <meta name="keywords" content="工具,效率">
  <meta property="og:image" content="/og.png">
  <meta name="twitter:image" content="https://cdn.example.com/tw.png">
  <link rel="icon" href="/favicon.ico">
</head>
<body>内容</body>
</html>`;

function mockHtmlFetch(t, { body = SAMPLE_HTML, status = 200, contentType = 'text/html; charset=utf-8', calls = [] } = {}) {
  return t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    calls.push({ url, options });
    return new Response(body, { status, headers: { 'content-type': contentType } });
  });
}

test('fetchSitePreview：HTML 页抽取 title/description/keywords/ogImage/favicon，相对路径按页面基准解析', async (t) => {
  const calls = [];
  mockHtmlFetch(t, { calls });

  const data = await fetchSitePreview('https://example.com/page');

  assert.equal(data.title, '示例站点');
  assert.equal(data.description, '这是站点描述');
  assert.equal(data.keywords, '工具,效率');
  assert.equal(data.ogImage, 'https://example.com/og.png', '相对 og:image 应按页面 URL 解析');
  assert.equal(calls.length, 1);
  assert.equal(String(calls[0].url), 'https://example.com/page', '应直接抓取原始 URL');
  assert.equal(data.favicon, 'https://example.com/favicon.ico', '相对 favicon 由 extractHtmlFavicon 按页面基准解析为绝对 URL');
});

test('fetchSitePreview：无协议 URL 归一为 https', async (t) => {
  const calls = [];
  mockHtmlFetch(t, { calls });

  await fetchSitePreview('example.com/foo');

  assert.equal(String(calls[0].url), 'https://example.com/foo');
});

test('fetchSitePreview：非 HTML 内容类型返回空字段，不解析 body', async (t) => {
  const calls = [];
  mockHtmlFetch(t, { body: 'PNG bytes', contentType: 'image/png', calls });

  const data = await fetchSitePreview('https://example.com/img.png');

  assert.deepEqual(data, { title: '', description: '', keywords: '', ogImage: '', favicon: '' });
});

test('fetchSitePreview：HTTP 非 2xx 抛错携带状态码', async (t) => {
  mockHtmlFetch(t, { status: 404, body: 'Not Found' });

  await assert.rejects(() => fetchSitePreview('https://example.com/missing'), /网站返回 HTTP 404/);
});

test('fetchSitePreview：网络失败抛「无法访问该网址」并带原因', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('ETIMEDOUT'); });

  await assert.rejects(() => fetchSitePreview('https://example.com/'), /无法访问该网址：ETIMEDOUT/);
});

test('fetchSitePreview：标题超长截断到 200 字', async (t) => {
  const longTitle = '长'.repeat(300);
  mockHtmlFetch(t, { body: `<html><head><title>${longTitle}</title></head></html>` });

  const data = await fetchSitePreview('https://example.com/');

  assert.equal(data.title.length, 200);
});
