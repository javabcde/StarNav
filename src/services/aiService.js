import { cleanText } from '../lib/utils.js';
import { getSite, searchSites, getSiteAnalytics } from './siteService.js';
import { canAccessSite } from './accessService.js';
import { listCategories } from './categoryService.js';
import { listTags } from './tagService.js';
import {
  buildLocalAnswer,
  detectBookmarkIntent,
  extractJsonArray,
  filterSitesByContainsKeyword,
  formatPopularSiteLine,
  formatSiteContext,
  inferSearchKeywords,
  normalizeCategorySuggestion,
  normalizeTagMergeSuggestions,
  parseSuggestedCategory,
  parseSuggestedTags,
  suggestCategoryLocally,
  suggestTagMergesLocally,
  suggestTagsLocally,
} from './aiLocalLogic.js';
import { callOpenAiCompatible, DEFAULT_AI_SETTINGS, getModelsEndpoint, normalizeAiSettingsPayload } from './aiModelService.js';
import { getAiSettings, updateAiSettings } from './aiSettingsService.js';

// AI 设置域（ai.* 键域：默认值/批量读写/密钥加解密）已迁入 aiSettingsService
// （2026-08-16 架构评审候选 2，与 systemSettingsService 同构）；
// 本地导入供本模块编排使用；re-export 垫片保持存量测试与调用方 import 面不变。
export { getAiSettings, updateAiSettings };

async function searchExpandedSites(env, {
  message,
  access = null,
  limit = 16,
} = {}) {
  const keywords = inferSearchKeywords(message);
  const merged = new Map();

  for (const [keywordIndex, keyword] of keywords.entries()) {
    let results = [];
    try {
      results = await searchSites(env, {
        keyword,
        limit: Math.max(8, limit),
        access,
      });
    } catch (error) {
      console.warn(`[ai] skip failed bookmark search keyword="${String(keyword).slice(0, 40)}": ${error.message}`);
      continue;
    }
    const keywordPriorityBoost = Math.max(0, keywords.length - keywordIndex) * 120;
    for (const site of results || []) {
      const aiSearchScore = (Number(site._score) || 0) + keywordPriorityBoost;
      if (!merged.has(site.id)) {
        merged.set(site.id, { ...site, _matchedBy: [keyword], _aiSearchScore: aiSearchScore });
      } else {
        const existing = merged.get(site.id);
        existing._matchedBy.push(keyword);
        existing._aiSearchScore = Math.max(Number(existing._aiSearchScore) || 0, aiSearchScore);
        existing._score = Math.max(Number(existing._score) || 0, Number(site._score) || 0);
      }
    }
    if (merged.size >= limit * 2) break;
  }

  return Array.from(merged.values())
    .sort((a, b) => {
      const aiScoreDiff = (Number(b._aiSearchScore) || 0) - (Number(a._aiSearchScore) || 0);
      if (aiScoreDiff !== 0) return aiScoreDiff;
      const scoreDiff = (Number(b._score) || 0) - (Number(a._score) || 0);
      if (scoreDiff !== 0) return scoreDiff;
      const hitDiff = (b._matchedBy?.length || 0) - (a._matchedBy?.length || 0);
      if (hitDiff !== 0) return hitDiff;
      return (Number(b.hits) || 0) - (Number(a.hits) || 0);
    })
    .slice(0, limit);
}

async function resolveContextSites(env, previousSites = [], access = null) {
  const ids = Array.isArray(previousSites)
    ? [...new Set(previousSites.map((site) => Number(site?.id)).filter((id) => Number.isInteger(id) && id > 0))].slice(0, 5)
    : [];
  if (!ids.length) return [];

  const sites = [];
  for (const id of ids) {
    const site = await getSite(env, id);

    if (site && canAccessSite(site, access || {})) {
      sites.push(site);
    }
  }
  return sites;
}

export async function suggestCategoryForSite(env, payload = {}) {
  const site = payload.siteId || payload.id ? await getSite(env, payload.siteId || payload.id) : {
    name: cleanText(payload.name),
    url: cleanText(payload.url),
    desc: cleanText(payload.desc),
    catelog: cleanText(payload.catelog),
    tags: Array.isArray(payload.tags) ? payload.tags : cleanText(payload.tags).split(/[,，、\s]+/).filter(Boolean),
  };
  if (!site || (!site.name && !site.url)) throw new Error('site name or url required');

  const categories = await listCategories(env);
  if (!categories.length) throw new Error('categories required');
  const fallback = suggestCategoryLocally(site, categories);
  const settings = await getAiSettings(env, { includeSecret: true });

  if (settings.enabled !== 'true' || !settings.apiKey) {
    return {
      site,
      category: fallback,
      mode: 'local',
      configured: false,
      message: 'AI 未启用或未配置 API Key，已返回本地规则推荐分类。',
    };
  }

  const categoryNames = categories.map((category) => category.name).filter(Boolean);
  const prompt = [
    '请从“已有分类候选”中为下面这个书签选择最合适的一个分类。',
    '要求：',
    '1. 必须只选择已有分类候选中的一个，不要创造新分类。',
    '2. 只返回 JSON 对象，例如 {"category":"开发工具"}，不要解释，不要 Markdown。',
    '',
    `书签名称：${site.name || ''}`,
    `URL：${site.url || ''}`,
    `当前分类：${site.catelog || ''}`,
    `描述：${site.desc || ''}`,
    `标签：${Array.isArray(site.tags) ? site.tags.join('、') : ''}`,
    `已有分类候选：${categoryNames.join('、')}`,
  ].join('\n');

  try {
    const answer = await callOpenAiCompatible({
      settings: { ...settings, systemPrompt: '你是书签分类整理助手。你只能从给定分类候选中选择一个分类，并且只输出 JSON 对象，例如 {"category":"开发工具"}。不要输出解释、标题、Markdown 或代码块。' },
      message: prompt,
      context: '后台分类推荐任务，不需要回答用户问题。',
    });
    const category = parseSuggestedCategory(answer, categories);
    return {
      site,
      category: category || fallback,
      mode: category ? 'ai' : 'local',
      configured: true,
      raw: answer.slice(0, 500),
    };
  } catch (error) {
    return {
      site,
      category: fallback,
      mode: 'fallback',
      configured: true,
      message: `AI 推荐分类失败，已返回本地规则推荐。错误：${error.message}`,
    };
  }
}

export async function suggestTagsForSite(env, siteInput, { limit = 8 } = {}) {
  const site = typeof siteInput === 'object' && siteInput !== null
    ? {
      name: cleanText(siteInput.name),
      url: cleanText(siteInput.url),
      desc: cleanText(siteInput.desc),
      catelog: cleanText(siteInput.catelog),
      tags: Array.isArray(siteInput.tags) ? siteInput.tags : cleanText(siteInput.tags).split(/[,，、\s]+/).filter(Boolean),
    }
    : await getSite(env, siteInput);
  if (!site || (!site.name && !site.url)) throw new Error('site not found');
  const tagRows = await listTags(env);
  const existingTags = tagRows.map((row) => row.name).filter(Boolean).slice(0, 80);
  const maxTags = Math.min(12, Math.max(3, Number(limit) || 8));
  const settings = await getAiSettings(env, { includeSecret: true });
  const fallbackTags = suggestTagsLocally(site, tagRows, maxTags);

  if (settings.enabled !== 'true' || !settings.apiKey) {
    return {
      site,
      tags: fallbackTags,
      mode: 'local',
      configured: false,
      message: 'AI 未启用或未配置 API Key，已返回本地规则推荐标签。',
    };
  }

  const prompt = [
    '请为下面这个书签推荐适合的中文标签。',
    '要求：',
    `1. 最多返回 ${maxTags} 个标签。`,
    '2. 标签要短，通常 2-8 个字。',
    '3. 优先复用“已有标签候选”中的标签，只有明显必要时才创建新标签。',
    '4. 只返回 JSON 数组，不要解释，不要 Markdown。',
    '',
    `书签名称：${site.name || ''}`,
    `URL：${site.url || ''}`,
    `分类：${site.catelog || ''}`,
    `描述：${site.desc || ''}`,
    `已有标签：${Array.isArray(site.tags) ? site.tags.join('、') : ''}`,
    `已有标签候选：${existingTags.join('、') || '暂无'}`,
  ].join('\n');

  try {
    const answer = await callOpenAiCompatible({
      settings: { ...settings, systemPrompt: '你是书签标签整理助手。你只能输出 JSON 数组，例如 ["AI","开发工具"]。不要输出解释、标题、Markdown 或代码块。' },
      message: prompt,
      context: '后台标签推荐任务，不需要回答用户问题。',
    });
    const tags = parseSuggestedTags(answer, maxTags);
    return {
      site,
      tags: tags.length ? tags : fallbackTags,
      mode: tags.length ? 'ai' : 'local',
      configured: true,
      raw: answer.slice(0, 500),
    };
  } catch (error) {
    return {
      site,
      tags: fallbackTags,
      mode: 'fallback',
      configured: true,
      message: `AI 推荐失败，已返回本地规则推荐。错误：${error.message}`,
    };
  }
}

// 共享租户 runner：suggestTagMerges / analyzeNoTagSites / analyzeDuplicateSites /
// analyzeSearchGaps / analyzeCategoryErrors 的统一骨架——
// 设置门（ai.enabled + apiKey + 业务条件 run）→ callOpenAiCompatible（systemPrompt 覆写）
// → extractJsonArray → 逐项映射 mapItems。返回结构化状态，envelope 由各租户自行整形：
//   skipped：门未通过（未启用 / 缺 Key / 业务条件不满足），未调用模型；
//   ai / local：模型返回且映射非空 / 映射为空；
//   error：调用或解析失败（含错误对象，租户按各自语义回退）。
async function runAiJsonTenant({ env, run = true, systemPrompt, message, context, mapItems }) {
  const settings = await getAiSettings(env, { includeSecret: true });
  const aiEnabled = settings.enabled === 'true' && Boolean(settings.apiKey);
  if (!aiEnabled || !run) return { status: 'skipped', aiEnabled };

  try {
    const answer = await callOpenAiCompatible({ settings: { ...settings, systemPrompt }, message, context });
    const items = mapItems(extractJsonArray(answer) || []);
    return { status: items.length ? 'ai' : 'local', items, answer, aiEnabled };
  } catch (error) {
    return { status: 'error', error, aiEnabled };
  }
}

export async function suggestTagMerges(env, { limit = 8 } = {}) {
  const tags = await listTags(env);
  const safeLimit = Math.min(20, Math.max(1, Number(limit) || 8));
  const fallback = suggestTagMergesLocally(tags, safeLimit);
  const tagLines = tags.slice(0, 160).map((tag) => `- ${tag.name}（书签数：${Number(tag.site_count) || 0}）`).join('\n');
  const prompt = [
    '请分析下面的标签列表，找出疑似同义、大小写差异、简称/全称重复、碎片化的标签合并建议。',
    '要求：',
    `1. 最多返回 ${safeLimit} 条建议。`,
    '2. source 是建议被合并/删除的源标签，target 是建议保留的目标标签。',
    '3. source 和 target 必须都来自给定标签列表，不能创造新标签。',
    '4. 只返回 JSON 数组，例如 [{"source":"AIGC","target":"AI","reason":"同义标签","confidence":85}]，不要解释，不要 Markdown。',
    '',
    `标签列表：\n${tagLines}`,
  ].join('\n');

  const result = await runAiJsonTenant({
    env,
    run: tags.length >= 2,
    systemPrompt: '你是标签体系整理助手。你只能输出 JSON 数组，不要输出解释、标题、Markdown 或代码块。',
    message: prompt,
    context: '后台标签合并建议任务，不需要回答用户问题。',
    mapItems: (items) => normalizeTagMergeSuggestions(items, tags, safeLimit),
  });

  if (result.status === 'skipped') {
    return { suggestions: fallback, mode: 'local', configured: false, message: 'AI 未启用或标签数量不足，已返回本地规则合并建议。' };
  }
  if (result.status === 'error') {
    return { suggestions: fallback, mode: 'fallback', configured: true, message: `AI 标签合并建议失败，已返回本地规则建议。错误：${result.error.message}` };
  }
  return {
    suggestions: result.status === 'ai' ? result.items : fallback,
    mode: result.status === 'ai' ? 'ai' : 'local',
    configured: true,
    raw: result.answer.slice(0, 500),
  };
}

export async function suggestTagsForSites(env, siteIds = [], { limit = 8, batchLimit = 10 } = {}) {
  const ids = [...new Set((Array.isArray(siteIds) ? siteIds : [])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0))]
    .slice(0, Math.min(50, Math.max(1, Number(batchLimit) || 10)));

  if (!ids.length) throw new Error('siteIds required');

  const results = [];
  for (const id of ids) {
    try {
      const item = await suggestTagsForSite(env, id, { limit });
      results.push({
        siteId: id,
        ok: true,
        site: item.site,
        tags: item.tags || [],
        mode: item.mode,
        configured: item.configured,
        message: item.message || '',
      });
    } catch (error) {
      results.push({
        siteId: id,
        ok: false,
        tags: [],
        mode: 'error',
        message: error.message,
      });
    }
  }

  return {
    total: ids.length,
    succeeded: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    results,
  };
}

export async function testAiSettings(env, payload = {}) {
  const savedSettings = await getAiSettings(env, { includeSecret: true });
  const settings = normalizeAiSettingsPayload(savedSettings, payload);
  if (!settings.apiKey) throw new Error('请先填写 API Key');
  if (!settings.baseUrl) throw new Error('请先填写接口地址');
  if (!settings.model) throw new Error('请先填写模型名称');

  const answer = await callOpenAiCompatible({
    settings,
    message: '请只回复：连接成功',
    context: '这是后台连接测试，不需要检索书签。',
  });

  return {
    ok: true,
    model: settings.model,
    baseUrl: settings.baseUrl,
    answer: answer.slice(0, 120),
  };
}

export async function listAiModels(env, payload = {}) {
  const savedSettings = await getAiSettings(env, { includeSecret: true });
  const settings = normalizeAiSettingsPayload(savedSettings, payload);
  if (!settings.apiKey) throw new Error('请先填写 API Key');
  if (!settings.baseUrl) throw new Error('请先填写接口地址');

  const endpoint = getModelsEndpoint(settings.baseUrl);
  const response = await fetch(endpoint, {
    method: 'GET',
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: `Bearer ${settings.apiKey}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`获取模型列表失败：${response.status} ${text.slice(0, 180)}`);
  }

  const data = await response.json();
  const rawModels = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
  const models = rawModels
    .map((item) => typeof item === 'string' ? item : item?.id || item?.name || item?.model)
    .filter(Boolean)
    .sort((a, b) => String(a).localeCompare(String(b)));

  return {
    endpoint,
    total: models.length,
    models,
  };
}

// ─── AI 管理助手分析函数 ───

export async function analyzeNoTagSites(env, { limit = 30 } = {}) {
  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 30));
  const { results: rows } = await env.NAV_DB.prepare(`
    SELECT s.id, s.name, s.url, s.desc, s.catelog, s.visibility
    FROM sites s LEFT JOIN site_tags st ON s.id = st.site_id
    WHERE st.tag_id IS NULL ORDER BY s.create_time DESC LIMIT ?
  `).bind(safeLimit).all();
  const totalRow = await env.NAV_DB.prepare(
    `SELECT COUNT(*) as cnt FROM sites s LEFT JOIN site_tags st ON s.id = st.site_id WHERE st.tag_id IS NULL`
  ).first();
  const totalNoTag = Number(totalRow?.cnt) || 0;
  const sites = (rows || []).map((r) => ({ id: r.id, name: r.name || '', url: r.url || '', desc: r.desc || '', catelog: r.catelog || '', visibility: r.visibility || 'public' }));
  const batch = sites.slice(0, 10);
  const siteLines = batch.map((s, i) => `${i + 1}. ${s.name}（分类：${s.catelog}；URL：${s.url}${s.desc ? '；描述：' + s.desc : ''}）`).join('\n');
  const result = await runAiJsonTenant({
    env,
    run: sites.length > 0,
    systemPrompt: '你是书签标签整理助手。只输出 JSON 数组，不要输出解释。',
    message: `以下书签没有标签。请为每个书签推荐 2-5 个中文标签。\n要求：标签要短(2-8字)；只返回JSON数组，每个元素 {"id": 书签序号, "tags": ["标签1","标签2"]}；不要解释。\n\n${siteLines}`,
    context: '后台无标签书签分析任务。',
    mapItems: (items) => items.map((item) => {
      const idx = Number(item?.id) - 1;
      const tags = Array.isArray(item?.tags) ? item.tags.map((t) => cleanText(t)).filter(Boolean).slice(0, 5) : [];
      if (idx >= 0 && idx < batch.length && tags.length) return { siteId: batch[idx].id, siteName: batch[idx].name, tags };
      return null;
    }).filter(Boolean),
  });
  const suggestions = result.status === 'ai' ? result.items : [];
  if (result.status === 'error') console.warn('[ai-admin] analyzeNoTagSites AI failed:', result.error.message);
  return { type: 'no-tags', total: totalNoTag, sites, suggestions, aiEnabled: result.aiEnabled };
}

export async function analyzeDuplicateSites(env, { limit = 30 } = {}) {
  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 30));
  const { results: domainGroups } = await env.NAV_DB.prepare(`
    SELECT REPLACE(REPLACE(REPLACE(LOWER(url), 'https://', ''), 'http://', ''), 'www.', '') as domain_key,
      COUNT(*) as cnt, GROUP_CONCAT(id, ',') as ids
    FROM sites WHERE url IS NOT NULL AND url != ''
    GROUP BY domain_key HAVING cnt > 1 ORDER BY cnt DESC LIMIT ?
  `).bind(safeLimit).all();
  const groups = [];
  for (const row of domainGroups || []) {
    const ids = (row.ids || '').split(',').map(Number).filter(Boolean);
    if (ids.length < 2) continue;
    const { results: sitesInGroup } = await env.NAV_DB.prepare(
      `SELECT id, name, url, desc, catelog, visibility, hits FROM sites WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY hits DESC`
    ).bind(...ids).all();
    groups.push({
      domainKey: row.domain_key || '', count: Number(row.cnt) || 0,
      sites: (sitesInGroup || []).map((s) => ({ id: s.id, name: s.name || '', url: s.url || '', desc: s.desc || '', catelog: s.catelog || '', visibility: s.visibility || 'public', hits: Number(s.hits) || 0 })),
    });
  }
  const batch = groups.slice(0, 8);
  const lines = batch.map((g, gi) => {
    const sl = g.sites.map((s) => `  - [ID:${s.id}] ${s.name}（${s.url}，访问${s.hits}次）`).join('\n');
    return `组${gi + 1}（域名：${g.domainKey}）：\n${sl}`;
  }).join('\n\n');
  const result = await runAiJsonTenant({
    env,
    run: groups.length > 0,
    systemPrompt: '你是书签去重助手。只输出 JSON 数组，不要解释。',
    message: `以下是按域名分组的书签，可能存在重复。请分析每组是否真正重复，建议保留哪个。\n只返回JSON数组，每个元素 {"group":组序号,"isDuplicate":true/false,"keepId":建议保留的ID,"reason":"原因"}。\n\n${lines}`,
    context: '后台重复书签分析任务。',
    mapItems: (items) => items.map((item) => {
      const gi = Number(item?.group) - 1;
      if (gi >= 0 && gi < batch.length) return { domainKey: batch[gi].domainKey, isDuplicate: item?.isDuplicate !== false, keepId: Number(item?.keepId) || 0, reason: cleanText(item?.reason).slice(0, 200) || '' };
      return null;
    }).filter(Boolean),
  });
  const suggestions = result.status === 'ai' ? result.items : [];
  if (result.status === 'error') console.warn('[ai-admin] analyzeDuplicateSites AI failed:', result.error.message);
  return { type: 'duplicates', total: groups.reduce((sum, g) => sum + g.count, 0), groupCount: groups.length, groups, suggestions, aiEnabled: result.aiEnabled };
}

export async function analyzeSearchGaps(env, { limit = 20 } = {}) {
  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 20));
  const { results: rows } = await env.NAV_DB.prepare(`
    SELECT keyword, total_searches, zero_result_count, last_searched_at
    FROM search_terms WHERE zero_result_count > 0
    ORDER BY zero_result_count DESC, total_searches DESC, last_searched_at DESC LIMIT ?
  `).bind(safeLimit).all();
  const gaps = (rows || []).map((r) => ({ keyword: r.keyword || '', totalSearches: Number(r.total_searches) || 0, zeroResultCount: Number(r.zero_result_count) || 0, lastSearchedAt: r.last_searched_at || '' }));
  const batch = gaps.slice(0, 15);
  const lines = batch.map((g, i) => `${i + 1}. "${g.keyword}"（搜索${g.totalSearches}次，${g.zeroResultCount}次无结果）`).join('\n');
  const result = await runAiJsonTenant({
    env,
    run: gaps.length > 0,
    systemPrompt: '你是书签补充建议助手。只输出JSON数组，不要解释。推荐真实存在的知名网站。',
    message: `以下是用户搜索但没有结果的关键词。请为每个关键词建议1-2个值得收录的网站。\n只返回JSON数组，每个元素 {"keyword":"关键词","suggestions":[{"name":"网站名","url":"网址","desc":"一句话描述"}]}。URL必须真实；太模糊的关键词suggestions为空数组。\n\n${lines}`,
    context: '后台搜索缺口分析任务。',
    mapItems: (items) => items.map((item) => {
      const kw = cleanText(item?.keyword);
      const sug = Array.isArray(item?.suggestions) ? item.suggestions.map((s) => ({ name: cleanText(s?.name), url: cleanText(s?.url), desc: cleanText(s?.desc).slice(0, 120) })).filter((s) => s.name && s.url) : [];
      if (kw && sug.length) return { keyword: kw, suggestions: sug.slice(0, 3) };
      return null;
    }).filter(Boolean),
  });
  const suggestions = result.status === 'ai' ? result.items : [];
  if (result.status === 'error') console.warn('[ai-admin] analyzeSearchGaps AI failed:', result.error.message);
  return { type: 'search-gaps', total: gaps.length, gaps, suggestions, aiEnabled: result.aiEnabled };
}

export async function analyzeCategoryErrors(env, { limit = 20 } = {}) {
  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 20));
  const categories = await listCategories(env);
  const categoryNames = new Set(categories.map((c) => c.name).filter(Boolean));
  const { results: allSites } = await env.NAV_DB.prepare(`SELECT id, name, url, desc, catelog, visibility FROM sites ORDER BY id DESC`).all();
  const orphaned = [];
  for (const site of allSites || []) {
    if (!site.catelog || !categoryNames.has(site.catelog)) {
      orphaned.push({ id: site.id, name: site.name || '', url: site.url || '', desc: site.desc || '', catelog: site.catelog || '', issue: site.catelog ? '分类不存在' : '未设置分类' });
    }
  }
  const sample = (allSites || []).filter((s) => s.catelog && categoryNames.has(s.catelog)).slice(0, safeLimit);
  const catList = categories.map((c) => c.name).join('、');
  const siteLines = sample.map((s, i) => `${i + 1}. [ID:${s.id}] ${s.name}（当前分类：${s.catelog}；URL：${s.url}${s.desc ? '；描述：' + s.desc : ''}）`).join('\n');
  const result = await runAiJsonTenant({
    env,
    run: (allSites || []).length > 0 && categories.length > 1 && sample.length > 0,
    systemPrompt: '你是书签分类审核助手。只输出JSON数组，不要解释。',
    message: `请检查以下书签的分类是否合理。只返回分类可能不当的书签，如果都合理返回空数组[]。\n可用分类：${catList}\n只返回JSON数组，每个元素 {"id":书签ID,"currentCategory":"当前分类","suggestedCategory":"建议分类","reason":"原因"}。suggestedCategory必须是可用分类之一。\n\n${siteLines}`,
    context: '后台分类错误检查任务。',
    mapItems: (items) => items.map((item) => {
      const siteId = Number(item?.id);
      const suggested = cleanText(item?.suggestedCategory);
      const current = cleanText(item?.currentCategory);
      const reason = cleanText(item?.reason).slice(0, 200);
      if (siteId && suggested && categoryNames.has(suggested) && suggested !== current) {
        const site = sample.find((s) => s.id === siteId);
        return { siteId, siteName: site?.name || '', currentCategory: current, suggestedCategory: suggested, reason };
      }
      return null;
    }).filter(Boolean),
  });
  const suggestions = result.status === 'ai' ? result.items : [];
  if (result.status === 'error') console.warn('[ai-admin] analyzeCategoryErrors AI failed:', result.error.message);
  return { type: 'category-errors', totalOrphaned: orphaned.length, orphaned: orphaned.slice(0, safeLimit), suggestions, aiEnabled: result.aiEnabled };
}

export async function chatWithAiAssistant(env, { message, previousSites = [], access = null } = {}) {
  const cleanMessage = cleanText(message);
  if (!cleanMessage) throw new Error('Message is required');

  const intent = detectBookmarkIntent(cleanMessage);
  const contextSites = await resolveContextSites(env, previousSites, access);
  let sites = [];

  // 统计型问题：访问最多、最热门、排行等——行格式复用 aiLocalLogic.formatPopularSiteLine
  if (intent.asksPopular) {
    try {
      const analytics = await getSiteAnalytics(env, { limit: intent.popularLimit || 5, access });
      const topSites = (analytics?.topByHits || []).slice(0, intent.popularLimit || 5);
      if (topSites.length) {
        return {
          code: 200,
          data: {
            answer: `以下是本站访问量最高的 ${topSites.length} 个书签：\n\n${topSites.map(formatPopularSiteLine).join('\n\n')}`,
            mode: 'local_strict',
            sites: topSites,
            configured: false,
          },
        };
      }
    } catch (e) {
      console.warn('[ai] getSiteAnalytics failed:', e.message);
    }
  }

  if (intent.hasPronoun && contextSites.length) {
    sites = contextSites;
  } else {
    sites = await searchExpandedSites(env, {
      message: cleanMessage,
      limit: (intent.asksList || intent.containsKeyword) ? 30 : 16,
      access,
    });
  }

  if (intent.containsKeyword) {
    sites = filterSitesByContainsKeyword(sites, intent.containsKeyword);
  }

  if ((intent.asksCategory || intent.asksUrl || intent.asksExistence || intent.asksList || intent.containsKeyword || intent.hasPronoun) && sites.length) {
    return {
      code: 200,
      data: {
        ...buildLocalAnswer(cleanMessage, sites),
        sites,
        configured: false,
      },
    };
  }

  const context = formatSiteContext(sites);
  const settings = await getAiSettings(env, { includeSecret: true });

  if (settings.enabled !== 'true' || !settings.apiKey) {
    return {
      code: 200,
      data: {
        ...buildLocalAnswer(cleanMessage, sites),
        sites,
        configured: false,
      },
    };
  }

  try {
    const answer = await callOpenAiCompatible({ settings, message: cleanMessage, context });
    return {
      code: 200,
      data: {
        answer,
        mode: 'ai',
        sites,
        configured: true,
      },
    };
  } catch (error) {
    const fallback = buildLocalAnswer(cleanMessage, sites);
    return {
      code: 200,
      data: {
        answer: `${fallback.answer}\n\n（AI 模型暂时调用失败，已先返回本站检索结果。错误：${error.message}）`,
        mode: 'fallback',
        sites,
        configured: true,
      },
    };
  }
}