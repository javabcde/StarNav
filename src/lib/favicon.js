import { isPrivateOrReservedHost } from './ssrf.js';

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

    return '';
  } catch {
    return '';
  }
}