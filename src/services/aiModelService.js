// AI 模型调用管道（model plumbing）：端点推导、OpenAI 兼容调用。
// 默认配置与载荷归一化属 AI 设置域，已迁入 aiSettingsService（本文件 re-export 垫片
// 保持存量测试 import 面，同 ADR-0003 模式）；租户（chat/suggest/analytics）
// 经本模块访问模型，超时/鉴权/响应解析单一来源。
import { cleanText } from '../lib/utils.js';
import { stripMarkdownArtifacts } from './aiLocalLogic.js';
import { DEFAULT_AI_SETTINGS } from './aiSettingsService.js';

export { DEFAULT_AI_SETTINGS, normalizeAiSettingsPayload } from './aiSettingsService.js';



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
