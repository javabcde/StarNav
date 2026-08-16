// 首页书签卡片形状契约：服务端渲染（siteCard.js）与客户端搜索结果渲染（clientScript.js 生成期内插）
// 共用同一组常量，杜绝两端卡片形状漂移（class 串、徽章文案、data 属性名）。
// 任何形状调整只改这里；禁止在消费方手写副本。
// 注意：clientScript.js 的模板是 String.raw——常量在生成期经 ${CARD_CONTRACT.xxx} 直接内插即可。

export const CARD_CONTRACT = Object.freeze({
  // 卡片 wrapper 的 class 串（不含拖拽态追加的 cursor-move）
  wrapperClass: 'site-card group bg-white border border-primary-100/60 rounded-xl shadow-sm overflow-hidden',
  // 「可能失效」健康徽章的 class 串
  healthBadgeClass: 'inline-flex items-center rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-600',
  // 健康徽章文案
  healthBadgeLabel: '可能失效',
  // 徽章 title 中最近检测时间的前缀
  lastCheckedPrefix: '最近检测：',
  // 卡片 data 属性名（顺序即服务端卡片的渲染顺序；消费方按需取子集）
  dataAttrs: Object.freeze(['data-id', 'data-name', 'data-url', 'data-catalog', 'data-tags']),
});
