// Cookie 请求头解析（lib 层单一实现）。
// 2026-08-16 架构评审候选 6：auth.js 与 i18n.js 此前各持一份且行为分歧——
// auth 版不 decode、不滤空键；i18n 版 decodeURIComponent 且畸形 % 序列会抛 URIError。
// 统一语义：键 trim 后按原样返回，值尝试 URL 解码、畸形序列回退原值（不抛错），空键过滤。
// 消费方（auth.js / i18n.js / accessService / unlockSessionService）一律从本模块导入。
export function parseCookies(cookieHeader = '') {
  return Object.fromEntries(cookieHeader.split(';').map((item) => {
    const [key, ...value] = item.trim().split('=');
    if (!key) return null;
    let decoded = value.join('=') || '';
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      // 畸形 % 序列保留原值——历史 i18n 版会抛 URIError，此处显式容错
    }
    return [key.trim(), decoded];
  }).filter(Boolean));
}
