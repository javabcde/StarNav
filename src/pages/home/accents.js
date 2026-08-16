// 首页强调色板单一来源：蓝/绿/紫/蔷薇/琥珀五档的全部派生色值集中于此。
// 消费方（迁移前各自手写副本，现统一从本表推导）：
//   - handlers/pwa.js：PWA 图标渐变三档 stop（primary / iconStop55 / accent）与 manifest theme_color（primary）；
//   - pages/home.js：<head> theme-color meta、主题面板强调色按钮（swatch）、各 accent 的 CSS 变量块（accentVarsCss 内联 <style>）；
//   - pages/home/clientScript.js：客户端 themeColors（切档回写 meta theme-color），由 themeColorMap 生成。
// 值与迁移前四处副本逐字一致。:root 默认蓝仍留在 home-custom.css（锁页等非首页共用），
// 其值必须与本表 blue 档保持同步。

export const DEFAULT_ACCENT = 'blue';

export const ACCENTS = Object.freeze({
  blue: Object.freeze({
    primary: '#254267',
    primary600: '#305580',
    primary50: '#f3f5f9',
    accent: '#3c976d',
    accent600: '#2e7755',
    secondary50: '#fdf8f3',
    // blue 档不生成 CSS 变量块（:root 即默认蓝，且 hero 渐变用 var() 引用）；此处记录等效字面值
    heroFrom: '#254267',
    heroTo: '#305580',
    // PWA 图标渐变中段 stop：blue 档现状为 #416d9d，异于 primary600，按现状对表
    iconStop55: '#416d9d',
    // 色板按钮的 Tailwind 任意值类（完整类名留在本文件内，保证 Tailwind 扫描 src/**/*.js 可见）
    swatch: 'bg-[#254267]',
  }),
  green: Object.freeze({
    primary: '#265c44',
    primary600: '#2e7755',
    primary50: '#f2faf6',
    accent: '#3c976d',
    accent600: '#2e7755',
    secondary50: '#f7fbf8',
    heroFrom: '#265c44',
    heroTo: '#3c976d',
    iconStop55: '#2e7755',
    swatch: 'bg-[#3c976d]',
  }),
  purple: Object.freeze({
    primary: '#5b3b8c',
    primary600: '#6d4bb3',
    primary50: '#f6f2ff',
    accent: '#8b5cf6',
    accent600: '#7c3aed',
    secondary50: '#fbf8ff',
    heroFrom: '#4c1d95',
    heroTo: '#7c3aed',
    iconStop55: '#6d4bb3',
    swatch: 'bg-[#8b5cf6]',
  }),
  rose: Object.freeze({
    primary: '#9f3758',
    primary600: '#be4169',
    primary50: '#fff1f5',
    accent: '#e0527d',
    accent600: '#be4169',
    secondary50: '#fff7f9',
    heroFrom: '#9f3758',
    heroTo: '#e0527d',
    iconStop55: '#be4169',
    swatch: 'bg-[#e0527d]',
  }),
  amber: Object.freeze({
    primary: '#8a5a16',
    primary600: '#b7791f',
    primary50: '#fffbeb',
    accent: '#d97706',
    accent600: '#b45309',
    secondary50: '#fffaf0',
    heroFrom: '#78350f',
    heroTo: '#d97706',
    iconStop55: '#b7791f',
    swatch: 'bg-[#d97706]',
  }),
});

// 取强调色档；未知档位回落默认蓝（与迁移前各消费方的兜底行为一致）。
export function getAccent(name) {
  return ACCENTS[name] || ACCENTS[DEFAULT_ACCENT];
}

// 客户端 themeColors 映射（accent 名 → theme-color 值），clientScript.js 生成期内插。
export function themeColorMap() {
  return Object.fromEntries(Object.entries(ACCENTS).map(([name, tone]) => [name, tone.primary]));
}

// 生成各 accent 的 CSS 变量块（默认蓝除外——:root 已含）。
// 输出与原 home-custom.css 中被移除的 html[data-accent] 块逐字节一致（含 4 空格缩进与换行）。
export function accentVarsCss() {
  return Object.entries(ACCENTS)
    .filter(([name]) => name !== DEFAULT_ACCENT)
    .map(([name, tone]) => `    html[data-accent="${name}"]{--nav-primary:${tone.primary};--nav-primary-600:${tone.primary600};--nav-primary-50:${tone.primary50};--nav-accent:${tone.accent};--nav-accent-600:${tone.accent600};--nav-secondary-50:${tone.secondary50};--nav-hero-gradient:linear-gradient(135deg,${tone.heroFrom},${tone.heroTo})}`)
    .join('\n');
}
