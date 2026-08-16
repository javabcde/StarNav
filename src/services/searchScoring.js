// 搜索评分（Search Scoring）：搜索查询解析 / 高级筛选 / 评分管线的纯逻辑叶模块。
// 2026-08-16 架构评审候选 1：从 siteService.js 迁出（约 225 行，零 D1 依赖），
// 与 submissionAnalytics / healthQuery / aiLocalLogic 同构——纯策略单一持有 + node:test 直接单测。
// siteService.searchSites 消费 parseSearchQuery → matchesAdvancedFilters → scoreSite 三级管线；
// aiService 消费评分输出形状（_score / _matchedFields / _matchReasons），不触碰本模块内部。
// toSafeLikePattern 与列表查询（getSites）共享，留在 siteService——它属于查询编排面，不属于评分管线。
// 修改评分权重 / 匹配理由词汇 / 拼音首字母推断时，行为矩阵在 tests/searchScoring.test.js。
import { cleanText } from '../lib/utils.js';
import { normalizeVisibility } from './accessService.js';
import { isDeadSite, isOkSite } from './healthQuery.js';

// 常见中文书签词 → 拼音首字母映射（人工维护的高频表，命中优先于边界推断）。
const CJK_INITIALS = {
  星: 'x', 空: 'k', 图: 't', 床: 'c', 云: 'y', 盘: 'p', 网: 'w', 资: 'z', 源: 'y', 工: 'g', 具: 'j',
  开: 'k', 发: 'f', 设: 's', 计: 'j', 素: 's', 材: 'c', 代: 'd', 码: 'm', 托: 't', 管: 'g',
  服: 'f', 务: 'w', 器: 'q', 运: 'y', 维: 'w', 博: 'b', 客: 'k', 搜: 's', 索: 's', 导: 'd',
  航: 'h', 书: 's', 签: 'q', 分: 'f', 类: 'l', 标: 'b', 私: 's', 人: 'r', 常: 'c',
  用: 'y', 站: 'z', 点: 'd', 链: 'l', 接: 'j', 文: 'w', 档: 'd', 影: 'y', 音: 'y', 视: 's',
  频: 'p', 下: 'x', 载: 'z', 上: 's', 传: 'c', 压: 'y', 缩: 's', 转: 'z', 换: 'h', 编: 'b',
  辑: 'j', 生: 's', 成: 'c', 智: 'z', 能: 'n', 大: 'd', 模: 'm', 型: 'x'
};

// 拼音首字母边界表：localeCompare('zh-Hans-CN') 落在区间 [boundary, 下一 boundary) 的字取该字母。
const PINYIN_INITIAL_BOUNDARIES = [
  ['a', '阿'], ['b', '八'], ['c', '嚓'], ['d', '咑'], ['e', '妸'], ['f', '发'],
  ['g', '旮'], ['h', '哈'], ['j', '击'], ['k', '喀'], ['l', '垃'], ['m', '妈'],
  ['n', '拿'], ['o', '哦'], ['p', '啪'], ['q', '期'], ['r', '然'], ['s', '撒'],
  ['t', '塌'], ['w', '挖'], ['x', '昔'], ['y', '压'], ['z', '匝'],
];

function normalizeSearchText(value) {
  return cleanText(value).toLowerCase();
}

function getHostParts(url) {
  const raw = cleanText(url);
  if (!raw) return [];
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(withProtocol);
    return [
      parsed.hostname.toLowerCase(),
      parsed.hostname.replace(/^www\./i, '').toLowerCase(),
      parsed.pathname.toLowerCase(),
    ].filter(Boolean);
  } catch {
    return [raw.toLowerCase()];
  }
}

function inferPinyinInitial(char) {
  if (!/[\u4e00-\u9fff]/.test(char)) return '';
  if (CJK_INITIALS[char]) return CJK_INITIALS[char];

  let initial = '';
  for (const [letter, boundary] of PINYIN_INITIAL_BOUNDARIES) {
    if (char.localeCompare(boundary, 'zh-Hans-CN') >= 0) {
      initial = letter;
    } else {
      break;
    }
  }
  return initial;
}

function getCjkInitials(value) {
  return Array.from(cleanText(value)).map((char) => inferPinyinInitial(char)).join('');
}

function getCjkNgrams(value) {
  const chars = Array.from(cleanText(value).replace(/\s+/g, '')).filter((char) => /[\u4e00-\u9fff]/.test(char));
  const grams = new Set();
  for (const size of [2, 3, 4]) {
    for (let i = 0; i + size <= chars.length; i += 1) {
      grams.add(chars.slice(i, i + size).join(''));
    }
  }
  return [...grams];
}

/**
 * 解析搜索关键词：抽取 tag:/cat:/category:/url:/is: 高级筛选前缀，剩余文本分词，
 * 中文按 2/3/4 元组扩展 ngram；返回 { raw, terms, filters }。
 * terms 上限 24 项——超出部分丢弃（排序后的 Set 顺序稳定）。
 */
export function parseSearchQuery(keyword) {
  let text = cleanText(keyword);
  const filters = { tags: [], categories: [], urls: [], visibility: '', health: '' };
  text = text.replace(/\b(tag|cat|category|url|is):(?:"([^"]+)"|'([^']+)'|(\S+))/gi, (match, key, quoted, singleQuoted, plain) => {
    const value = cleanText(quoted || singleQuoted || plain);
    const normalizedKey = key.toLowerCase();
    if (!value) return ' ';
    if (normalizedKey === 'tag') filters.tags.push(value);
    else if (normalizedKey === 'cat' || normalizedKey === 'category') filters.categories.push(value);
    else if (normalizedKey === 'url') filters.urls.push(value);
    else if (normalizedKey === 'is') {
      const state = value.toLowerCase();
      if (['private', 'public', 'unlisted', 'admin_only'].includes(state)) filters.visibility = state;
      if (['dead', 'bad', 'error'].includes(state)) filters.health = 'dead';
      if (['ok', 'alive'].includes(state)) filters.health = 'ok';
    }
    return ' ';
  });

  const terms = new Set();
  const phrase = cleanText(text);
  if (phrase) terms.add(phrase);
  phrase.split(/\s+/).map(cleanText).filter(Boolean).forEach((term) => terms.add(term));
  getCjkNgrams(phrase).forEach((term) => terms.add(term));

  return { raw: cleanText(keyword), terms: [...terms].slice(0, 24), filters };
}

/**
 * 高级筛选谓词：按 filters（tag:/cat:/url:/is: 语法产物）逐字段判定单个站点。
 * 与 SQL 预筛（LIKE 候选召回）互补——此处是精确语义的唯一判定点。
 */
export function matchesAdvancedFilters(site, filters) {
  const tags = Array.isArray(site.tags) ? site.tags.map(normalizeSearchText) : [];
  const category = normalizeSearchText(site.catelog);
  const url = normalizeSearchText(site.url);
  const hosts = getHostParts(site.url);
  const visibility = normalizeVisibility(site.visibility, site.catelog);
  const isDead = isDeadSite(site);

  if (filters.visibility && visibility !== filters.visibility) return false;
  if (filters.health === 'dead' && !isDead) return false;
  if (filters.health === 'ok' && !isOkSite(site)) return false;
  if (filters.tags.length && !filters.tags.every((tag) => tags.some((item) => item.includes(normalizeSearchText(tag))))) return false;
  if (filters.categories.length && !filters.categories.every((cat) => category.includes(normalizeSearchText(cat)))) return false;
  if (filters.urls.length && !filters.urls.every((part) => {
    const normalized = normalizeSearchText(part);
    return url.includes(normalized) || hosts.some((host) => host.includes(normalized));
  })) return false;

  return true;
}

/**
 * 评分管线：对单个站点按 terms 计算相关性分与匹配理由。
 * 权重语义（改权重必改 tests/searchScoring.test.js 行为矩阵）：
 * 完全匹配 > 包含匹配 > 首字母/标签/分类/域名 > URL/描述；hits 对数衰减、近 14 天时间衰减。
 */
export function scoreSite(site, terms) {
  const name = normalizeSearchText(site.name);
  const url = normalizeSearchText(site.url);
  const desc = normalizeSearchText(site.desc);
  const category = normalizeSearchText(site.catelog);
  const tags = Array.isArray(site.tags) ? site.tags.map(normalizeSearchText) : [];
  const tagInitials = Array.isArray(site.tags) ? site.tags.map(getCjkInitials).filter(Boolean) : [];
  const hosts = getHostParts(site.url);
  const nameInitials = getCjkInitials(site.name);
  const categoryInitials = getCjkInitials(site.catelog);

  let score = 0;
  const matchedFields = new Set();
  const matchReasons = [];

  for (const rawTerm of terms) {
    const term = normalizeSearchText(rawTerm);
    if (!term) continue;

    if (name === term) {
      score += 1000;
      matchedFields.add('name');
      matchReasons.push(`名称完全匹配：${rawTerm}`);
    } else if (name.includes(term)) {
      score += 520;
      matchedFields.add('name');
      matchReasons.push(`名称包含：${rawTerm}`);
    }

    if (nameInitials && nameInitials.includes(term)) {
      score += 420;
      matchedFields.add('name_initials');
      matchReasons.push(`名称首字母匹配：${rawTerm}`);
    }

    if (tags.some((tag) => tag === term)) {
      score += 360;
      matchedFields.add('tags');
      matchReasons.push(`标签完全匹配：${rawTerm}`);
    } else if (tags.some((tag) => tag.includes(term))) {
      score += 280;
      matchedFields.add('tags');
      matchReasons.push(`标签包含：${rawTerm}`);
    }

    if (tagInitials.some((initials) => initials.includes(term))) {
      score += 240;
      matchedFields.add('tag_initials');
      matchReasons.push(`标签首字母匹配：${rawTerm}`);
    }

    if (category === term) {
      score += 300;
      matchedFields.add('category');
      matchReasons.push(`分类完全匹配：${rawTerm}`);
    } else if (category.includes(term)) {
      score += 230;
      matchedFields.add('category');
      matchReasons.push(`分类包含：${rawTerm}`);
    }

    if (categoryInitials && categoryInitials.includes(term)) {
      score += 180;
      matchedFields.add('category_initials');
      matchReasons.push(`分类首字母匹配：${rawTerm}`);
    }

    if (hosts.some((host) => host.includes(term))) {
      score += 220;
      matchedFields.add('url');
      matchReasons.push(`域名匹配：${rawTerm}`);
    } else if (url.includes(term)) {
      score += 160;
      matchedFields.add('url');
      matchReasons.push(`URL 包含：${rawTerm}`);
    }

    if (desc.includes(term)) {
      score += 120;
      matchedFields.add('desc');
      matchReasons.push(`描述包含：${rawTerm}`);
    }
  }

  const hits = Math.min(Number(site.hits) || 0, 1000);
  score += Math.min(80, Math.log10(hits + 1) * 24);

  const updateTime = Date.parse(site.update_time || site.create_time || '');
  if (Number.isFinite(updateTime)) {
    const ageDays = Math.max(0, (Date.now() - updateTime) / 86400000);
    score += Math.max(0, 40 - Math.min(40, ageDays / 14));
  }

  return {
    score: Math.round(score * 100) / 100,
    matchedFields: [...matchedFields],
    matchReasons: [...new Set(matchReasons)].slice(0, 8),
  };
}
