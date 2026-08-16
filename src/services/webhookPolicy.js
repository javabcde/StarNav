// Webhook 策略（Webhook Policy）：匹配 / 整形 / 签名 / 载荷构建的纯逻辑叶模块。
// 2026-08-16 架构评审候选 4：从 webhookService.js 迁出（策略与逐条投递、KV 簿记
// 原本搅在 dispatchWebhooks 一个循环里）；与 submissionAnalytics / searchScoring 同构——
// 零 env 零 D1 依赖，node:test 直接单测。传输（fetch + 超时）留在 webhookService.js。
import { cleanText } from '../lib/utils.js';

export function normalizeEvents(events = []) {
  const values = Array.isArray(events) ? events : String(events || '').split(/[,\s]+/);
  const normalized = values
    .map((event) => cleanText(event).trim())
    .filter(Boolean);
  return Array.from(new Set(normalized));
}

export function sanitizeWebhook(input = {}) {
  return {
    id: cleanText(input.id).slice(0, 80),
    name: cleanText(input.name).slice(0, 80) || '未命名 WebHook',
    url: String(input.url || '').trim(),
    events: normalizeEvents(input.events || ['*']),
    enabled: input.enabled !== false,
    secret: String(input.secret || '').trim(),
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || new Date().toISOString(),
    lastTriggeredAt: input.lastTriggeredAt || null,
    lastStatus: input.lastStatus || null,
    lastError: input.lastError || null,
  };
}

export function publicWebhook(webhook = {}) {
  const { secret, ...rest } = webhook;
  return {
    ...rest,
    hasSecret: Boolean(secret),
  };
}

export function isValidWebhookUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 事件匹配：'*' 匹配一切；精确 action 匹配；组通配——action 首段 + '.*' 匹配
 * （如 'site.*' 命中 'site.create'）。组通配与精确匹配并存时任一命中即投递。
 */
export function eventMatches(webhook, action) {
  const events = normalizeEvents(webhook.events || ['*']);
  if (events.includes('*')) return true;
  if (events.includes(action)) return true;
  const group = String(action || '').split('.')[0];
  return events.includes(`${group}.*`);
}

/** HMAC-SHA256 十六进制签名；空 secret 返回空串（不签名）。 */
export async function signPayload(secret, payloadText) {
  if (!secret) return '';
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadText));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 投递载荷整形：operation 字段投影 + 时间戳；所有投递目标共用同一载荷。 */
export function buildWebhookPayload(operation = {}, timestamp = new Date().toISOString()) {
  return {
    event: operation.action,
    action: operation.action,
    target: operation.target || null,
    targetId: operation.targetId || null,
    summary: operation.summary || null,
    detail: operation.detail || null,
    ip: operation.ip || null,
    timestamp,
  };
}
