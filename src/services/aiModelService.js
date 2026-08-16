// AI 模型调用管道（model plumbing）：默认配置、载荷归一化、端点推导、OpenAI 兼容调用。
// 租户（chat/suggest/analytics）经此模块访问模型，超时/鉴权/响应解析单一来源。
import { cleanText } from '../lib/utils.js';
import { stripMarkdownArtifacts } from './aiLocalLogic.js';

export const DEFAULT_AI_SETTINGS = {
  enabled: 'false',
  enableThinking: 'false',
  apiKey: '',
  baseUrl: 'https://api.openai.com/v1/chat/completions',
  model: 'gpt-4o-mini',
  systemPrompt: '你是星漫旅站的 AI 书签助理。你的首要任务是基于“本站书签检索结果”回答用户。检索结果是事实来源，不能编造不存在的书签、分类、标签或链接；不能说出与检索结果相反的结论。若检索结果为空，请明确说明本站没有找到相关书签，并建议用户换关键词。若用户询问“所有、全部、包含某字、某分类、某标签、某链接”等事实型问题，必须逐条依据检索结果回答。回答要简洁、准确、友好；只有在明确说明“以下是通用建议，不代表本站已有书签”时，才可以补充常识建议。请使用中文纯文本或简单编号列表回答，避免使用 Markdown 加粗星号。',
};

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

export function getModelsEndpoint(baseUrl) {
  const raw = cleanText(baseUrl) || DEFAULT_AI_SETTINGS.baseUrl;
  try {
    const url = new URL(raw);
    url.pathname = url.pathname
      .replace(/\/chat\/completions\/?$/i, '/models')
      .replace(/\/responses\/?$/i, '/models');
    if (!/\/models\/?$/i.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/+$/g, '') + '/models';
    }
    url.search = '';
    return url.toString();
  } catch {
    return raw.replace(/\/chat\/completions\/?$/i, '/models').replace(/\/+$/g, '') + '/models';
  }
}

export async function callOpenAiCompatible({ settings, message, context }) {
  const response = await fetch(settings.baseUrl, {
    method: 'POST',
    signal: AbortSignal.timeout(30000),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.model,
      messages: [
        {
          // 硅基流动要求 system 消息只能一条且在开头（多条 system 会返回 20015）
          role: 'system',
          content: [
            settings.systemPrompt,
            '事实性约束：你正在做 RAG 问答。“本站书签检索结果”是唯一可信数据源。回答书签是否存在、在哪个分类、链接是什么、包含某字/某词的所有书签、某分类/标签有哪些等事实型问题时，只能使用检索结果中的条目。检索结果为空时必须说本站未找到；检索结果非空时不得说未检索到。不要输出检索结果中不存在的名称、分类、标签、URL。',
            '输出格式要求：请使用中文纯文本回答；可以使用编号列表，但不要使用 Markdown 加粗、标题符号或多余星号。不要把“**”输出给用户。',
            `本站书签检索结果：\n${context}`,
          ].filter(Boolean).join('\n\n'),
        },
        { role: 'user', content: message },
      ],
      temperature: 0.3,
      // 硅基流动等支持 enable_thinking 的 provider：false 关闭推理模型思考（更快更省）；
      // 不支持的 provider 会忽略该参数。默认关闭，后台可开。
      enable_thinking: settings.enableThinking === 'true',
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`AI provider error: ${response.status} ${text.slice(0, 180)}`);
  }

  const data = await response.json();
  const answer = data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || '';
  if (!answer) throw new Error('AI provider returned empty answer');
  return stripMarkdownArtifacts(answer);
}
