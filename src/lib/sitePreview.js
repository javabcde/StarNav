// 站点预览抓取（site preview）：外部页面 HTML 元数据抽取适配器。
// 2026-08-16 架构评审候选 4：从 siteService 迁出——零 D1 依赖、零站点域私有基建，
// 与 lib/favicon.js（extractHtmlFavicon，本模块已复用）同族能力；
// 两个抓取适配器相邻 = 真实接缝。消费方：/site/preview 端点（api/resources/sites.js）。
import { cleanText } from './utils.js';
import { readTextWithLimit, safeFetch } from './ssrf.js';
import { extractHtmlFavicon } from './favicon.js';

export async function fetchSitePreview(url) {
  const raw = cleanText(url);
  if (!raw) throw new Error('URL is required');
  const targetUrl = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;

  let response;
  try {
    response = await safeFetch(targetUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(8000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; StarNav-Preview/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
  } catch (err) {
    throw new Error(`无法访问该网址：${err?.message || '请求超时'}`);
  }

  if (!response.ok) {
    throw new Error(`网站返回 HTTP ${response.status}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html') && !contentType.includes('xhtml')) {
    return { title: '', description: '', keywords: '', ogImage: '', favicon: '' };
  }

  const html = await readTextWithLimit(response, 512 * 1024);
  const head = html.slice(0, 32000);

  const title = extractMeta(head, /<title[^>]*>([^<]*)<\/title>/i) || '';
  const description = extractMetaAttr(head, 'description') || extractMetaAttr(head, 'og:description') || '';
  const keywords = extractMetaAttr(head, 'keywords') || '';
  const ogImage = extractMetaAttr(head, 'og:image') || extractMetaAttr(head, 'twitter:image') || '';

  let favicon = extractHtmlFavicon(html, targetUrl);

  return {
    title: cleanText(title).slice(0, 200),
    description: cleanText(description).slice(0, 500),
    keywords: cleanText(keywords).slice(0, 300),
    ogImage: resolveUrl(targetUrl, cleanText(ogImage)),
    favicon: favicon || '',
  };
}

function extractMeta(html, regex) {
  const match = html.match(regex);
  return match ? match[1].trim() : '';
}

function extractMetaAttr(html, name) {
  const patterns = [
    new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${name}["']`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return match[1].trim();
  }
  return '';
}

function resolveUrl(base, relative) {
  const rel = cleanText(relative);
  if (!rel) return '';
  if (/^https?:\/\//i.test(rel)) return rel;
  if (rel.startsWith('//')) return 'https:' + rel;
  try {
    return new URL(rel, base).href;
  } catch {
    return '';
  }
}
