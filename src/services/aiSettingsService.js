// AI 设置域（ai.* 键域）：默认值、载荷归一化、批量读写、密钥加解密。
// 与 systemSettingsService（system.* 键域）同构：settingsService 是 settings 表适配器，
// 本模块是 AI 设置领域模块——aiService 编排、systemHealthService 聚合、settings 端点
// 统一从本模块读取，禁止再内嵌逐 key 读写（2026-08-16 架构评审候选 2）。
import { cleanText } from '../lib/utils.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import { listSettings, setSettings } from './settingsService.js';

const AI_SETTING_PREFIX = 'ai.';

export const DEFAULT_AI_SETTINGS = {
  enabled: 'false',
  enableThinking: 'false',
  apiKey: '',
  baseUrl: 'https://api.openai.com/v1/chat/completions',
  model: 'gpt-4o-mini',
  systemPrompt: '你是星漫旅站的 AI 书签助理。你的首要任务是基于“本站书签检索结果”回答用户。检索结果是事实来源，不能编造不存在的书签、分类、标签或链接；不能说出与检索结果相反的结论。若检索结果为空，请明确说明本站没有找到相关书签，并建议用户换关键词。若用户询问“所有、全部、包含某字、某分类、某标签、某链接”等事实型问题，必须逐条依据检索结果回答。回答要简洁、准确、友好；只有在明确说明“以下是通用建议，不代表本站已有书签”时，才可以补充常识建议。请使用中文纯文本或简单编号列表回答，避免使用 Markdown 加粗星号。',
};

// bool 字符串归一：仅 true / 'true' 视为 'true'，其余一律 'false'。
// 与 normalizeAiSettingsPayload 的布尔判定同源；后者用于把载荷并入已存设置
// （updateAiSettings / testAiSettings / listAiModels），本函数用于读取与强制写回时的归一。
function boolString(value) {
  return String(value) === 'true' ? 'true' : 'false';
}

/**
 * 载荷归一化：文本字段 cleanText 后回退已存值再回退默认；bool 字段
 * 仅显式 true/'true' 置真，缺省继承已存值；apiKey 星号占位不覆盖已存密钥。
 */
export function normalizeAiSettingsPayload(savedSettings, payload = {}) {
  const apiKey = cleanText(payload.apiKey);
  return {
    ...savedSettings,
    enabled: payload.enabled === true || payload.enabled === 'true' ? 'true' : savedSettings.enabled,
    enableThinking: payload.enableThinking === true || payload.enableThinking === 'true' ? 'true' : savedSettings.enableThinking,
    baseUrl: cleanText(payload.baseUrl) || savedSettings.baseUrl || DEFAULT_AI_SETTINGS.baseUrl,
    model: cleanText(payload.model) || savedSettings.model || DEFAULT_AI_SETTINGS.model,
    systemPrompt: cleanText(payload.systemPrompt) || savedSettings.systemPrompt || DEFAULT_AI_SETTINGS.systemPrompt,
    apiKey: apiKey && apiKey !== '********' ? apiKey : savedSettings.apiKey,
  };
}

/**
 * 读取 AI 设置。批量读一次 listSettings 全部 ai.* 键，避免按 key 逐条查询
 * （同 systemSettingsService 的 19 次串行 D1 往返 → 1 次先例）。
 */
export async function getAiSettings(env, { includeSecret = false } = {}) {
  const stored = {};
  try {
    const rows = await listSettings(env, AI_SETTING_PREFIX);
    for (const row of rows) {
      stored[String(row.key).slice(AI_SETTING_PREFIX.length)] = row.value;
    }
  } catch (error) {
    console.warn(`[aiSettings] 批量读取失败，回退默认值: ${error?.message || error}`);
  }

  const settings = {};
  for (const [key, defaultValue] of Object.entries(DEFAULT_AI_SETTINGS)) {
    const value = stored[key];
    settings[key] = value === undefined || value === null ? defaultValue : value;
  }

  settings.enabled = boolString(settings.enabled);
  settings.configured = Boolean(settings.apiKey);
  if (includeSecret) {
    settings.apiKey = await decryptSecret(env, settings.apiKey);
  } else {
    settings.apiKey = settings.configured ? '********' : '';
  }

  return settings;
}

/**
 * 更新 AI 设置：merge+persist（先读已存设置，经 normalizeAiSettingsPayload 合并载荷）。
 * 一次批量写（setSettings）落 5 个固定键 + 条件 apiKey，替代逐 key setSetting。
 * bool 字段保持既有强制归一：未提供视为 false（后台开关始终随表单整包提交）。
 */
export async function updateAiSettings(env, payload = {}) {
  const saved = await getAiSettings(env, { includeSecret: true });
  const settings = normalizeAiSettingsPayload(saved, payload);

  const entries = [
    [`${AI_SETTING_PREFIX}enabled`, boolString(payload.enabled)],
    [`${AI_SETTING_PREFIX}enableThinking`, boolString(payload.enableThinking)],
    [`${AI_SETTING_PREFIX}baseUrl`, settings.baseUrl],
    [`${AI_SETTING_PREFIX}model`, settings.model],
    [`${AI_SETTING_PREFIX}systemPrompt`, settings.systemPrompt],
  ];

  // apiKey 不走合并结果写回：仅当提交了非占位新值时才加密落库，避免明文/密文反复重写。
  const apiKey = cleanText(payload.apiKey);
  if (apiKey && apiKey !== '********') {
    entries.push([`${AI_SETTING_PREFIX}apiKey`, await encryptSecret(env, apiKey)]);
  }

  await setSettings(env, entries);

  return getAiSettings(env);
}
