import { isPrivateOrReservedHost, readTextWithLimit, safeFetch } from './ssrf.js';

/**
 * 从 HTML 提取 <link rel="icon"> 图标 URL（浏览器标签页图标的真实来源）。
 * 支持绝对 URL / 协议相对 // / 相对路径；找不到返回 ''。
 * 由 getFavicon（第 6 源）与 fetchSitePreview 共用，避免双份解析逻辑漂移。
 *
 * @param {string} html 页面 HTML（内部取前 32KB）。
 * @param {string} baseUrl 相对路径解析基准（源站 URL）。
 * @returns {string} 图标绝对 URL 或 ''。
 */
export function extractHtmlFavicon(html, baseUrl) {
  const head = String(html || '').slice(0, 32000);
  const iconMatch = head.match(/<link[^>]+rel=["'](?:icon|shortcut icon|apple-touch-icon)["'][^>]*>/i);
  if (!iconMatch) return '';
  const hrefMatch = iconMatch[0].match(/href=["']([^"']+)["']/i);
  if (!hrefMatch) return '';
  const rel = String(hrefMatch[1] || '').trim();
  if (!rel) return '';
  if (/^https?:\/\//i.test(rel)) return rel;
  if (rel.startsWith('//')) return 'https:' + rel;
  try {
    return new URL(rel, baseUrl).href;
  } catch {
    return '';
  }
}

export async function getFavicon(url) {
  if (!url) return '';

  try {
    const domain = new URL(url.startsWith('http') ? url : `https://${url}`).hostname;
    if (isPrivateOrReservedHost(domain)) return ''; // 拒绝内网/保留地址，防 SSRF
    const faviconUrls = [
      `https://www.faviconextractor.com/favicon/${domain}?larger=true`,
      `https://favicon.im/${domain}?larger=true`,
      `https://www.google.com/s2/favicons?domain=${domain}&sz=64`,
      `https://icons.duckduckgo.com/ip3/${domain}.ico`,
      `https://${domain}/favicon.ico`,
    ];

    for (const faviconUrl of faviconUrls) {
      // 每源 5s 超时：5 源串行最坏 25s，避免慢源拖死整个补全（
      // /go waitUntil 预算 30s、插件接口同步请求限时内需返回）
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch(faviconUrl, {
          cf: { cacheEverything: true },
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: controller.signal,
        });
        if (response.ok && response.headers.get('content-type')?.startsWith('image/')) {
          return faviconUrl;
        }
      } catch {
        // 尝试下一个源
      } finally {
        clearTimeout(timer);
      }
    }

    // 第 6 源：抓源站 HTML 解析 <link rel="icon">。很多站的图标在自定义路径
    // （非 /favicon.ico），聚合源未必收录——浏览器标签页图标正是 HTML link 来源，
    // 5 源全失败而页签有图标时只能在这里找到。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await safeFetch(`https://${domain}/`, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept': 'text/html,application/xhtml+xml',
        },
      });
      if (response.ok) {
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('text/html') || contentType.includes('xhtml')) {
          const html = await readTextWithLimit(response, 512 * 1024);
          const icon = extractHtmlFavicon(html, `https://${domain}/`);
          if (icon) return icon;
        }
      }
    } catch {
      // HTML 源失败视为无图标
    } finally {
      clearTimeout(timer);
    }

    return '';
  } catch {
    return '';
  }
}