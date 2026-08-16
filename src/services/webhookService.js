import { cleanText } from '../lib/utils.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import {
  buildWebhookPayload,
  eventMatches,
  isValidWebhookUrl,
  publicWebhook,
  sanitizeWebhook,
  signPayload,
} from './webhookPolicy.js';

// Webhook 传输与簿记（webhook transport & bookkeeping）：CRUD、fetch 投递、KV 结果写回。
// 匹配 / 整形 / 签名 / 载荷构建的纯策略在 webhookPolicy.js（2026-08-16 架构评审候选 4，
// 单一持有 + 直接单测）；本模块只做「读 KV → 投递 → 批量写回」。
// dispatchWebhooks 簿记为一次读 + 一次写（此前每条投递全表重读重写，O(n) × N）。
const WEBHOOKS_KEY = 'webhooks';


async function loadWebhooks(env) {
  const raw = await env.NAV_AUTH.get(WEBHOOKS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const sanitized = parsed.map(sanitizeWebhook).filter((item) => item.id && item.url);
    // 解密 secret（历史明文数据原样返回）
    return Promise.all(sanitized.map(async (item) => ({ ...item, secret: await decryptSecret(env, item.secret) })));
  } catch {
    return [];
  }
}

async function saveWebhooks(env, webhooks) {
  const sanitized = webhooks.map(sanitizeWebhook);
  const encrypted = await Promise.all(sanitized.map(async (item) => ({ ...item, secret: await encryptSecret(env, item.secret) })));
  await env.NAV_AUTH.put(WEBHOOKS_KEY, JSON.stringify(encrypted));
}

export async function listWebhooks(env) {
  const webhooks = await loadWebhooks(env);
  return webhooks.map(publicWebhook);
}

export async function createWebhook(env, input = {}) {
  const webhook = sanitizeWebhook({
    ...input,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  });
  if (!isValidWebhookUrl(webhook.url)) {
    throw new Error('Webhook URL must be a valid HTTPS URL');
  }
  const webhooks = await loadWebhooks(env);
  webhooks.push(webhook);
  await saveWebhooks(env, webhooks);
  return publicWebhook(webhook);
}

export async function updateWebhook(env, id, input = {}) {
  const webhooks = await loadWebhooks(env);
  const index = webhooks.findIndex((item) => item.id === String(id));
  if (index === -1) throw new Error('Webhook not found');
  const current = webhooks[index];
  const next = sanitizeWebhook({
    ...current,
    ...input,
    id: current.id,
    secret: input.secret === undefined ? current.secret : input.secret,
    updatedAt: new Date().toISOString(), // 配置编辑推进「上次修改」时间（原行为）
    lastTriggeredAt: current.lastTriggeredAt,
    lastStatus: current.lastStatus,
    lastError: current.lastError,
  });
  if (!isValidWebhookUrl(next.url)) {
    throw new Error('Webhook URL must be a valid HTTPS URL');
  }
  webhooks[index] = next;
  await saveWebhooks(env, webhooks);
  return publicWebhook(next);
}

export async function deleteWebhook(env, id) {
  const webhooks = await loadWebhooks(env);
  const next = webhooks.filter((item) => item.id !== String(id));
  if (next.length === webhooks.length) throw new Error('Webhook not found');
  await saveWebhooks(env, next);
  return true;
}


async function invokeWebhook(webhook, payload) {
  const payloadText = JSON.stringify(payload);
  const signature = await signPayload(webhook.secret, payloadText);
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'StarNav-Webhook/1.0',
  };
  if (signature) headers['X-StarNav-Signature'] = `sha256=${signature}`;
  const response = await fetch(webhook.url, {
    headers,
    body: payloadText,
  });
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
  };
}

async function updateWebhookDeliveryResult(env, id, patch = {}) {
  const webhooks = await loadWebhooks(env);
  const index = webhooks.findIndex((item) => item.id === String(id));
  if (index === -1) return;
  webhooks[index] = sanitizeWebhook({
    ...webhooks[index],
    ...patch,
    updatedAt: webhooks[index].updatedAt,
  });
  await saveWebhooks(env, webhooks);
}

export async function dispatchWebhooks(env, operation = {}) {
  const action = cleanText(operation.action);
  if (!action) return { sent: 0, failed: 0 };
  const webhooks = await loadWebhooks(env);
  const targets = webhooks.filter((webhook) => webhook.enabled && isValidWebhookUrl(webhook.url) && eventMatches(webhook, action));
  let sent = 0;
  let failed = 0;

  // event/action 用清洗后的 action（与 eventMatches 匹配同源，旧实现行为）
  const payload = buildWebhookPayload({ ...operation, action });
  const patches = new Map();

  for (const webhook of targets) {
    try {
      const result = await invokeWebhook(webhook, payload);
      if (result.ok) {
        sent += 1;
        patches.set(webhook.id, { lastTriggeredAt: payload.timestamp, lastStatus: result.status, lastError: null });
      } else {
        failed += 1;
        patches.set(webhook.id, {
          lastTriggeredAt: payload.timestamp,
          lastStatus: result.status,
          lastError: result.statusText || `HTTP ${result.status}`,
        });
      }
    } catch (error) {
      failed += 1;
      patches.set(webhook.id, {
        lastTriggeredAt: payload.timestamp,
        lastStatus: null,
        lastError: error?.message || String(error),
      });
    }
  }

  // 簿记批量写回：写前重读最新列表——投递期间并发的增/改/删不得被投递前快照覆盖
  // （旧逐条实现每次投递后重读，天然保留并发变更）。命中目标的项保留其 updatedAt：
  // 旧实现整表重存会把所有钩子的 updatedAt 刷成投递时刻（sanitize 无条件盖写），
  // 此处改为只推进 lastTriggeredAt/lastStatus/lastError（评审修复，语义为「上次配置修改」）。
  if (patches.size) {
    const latest = await loadWebhooks(env);
    await saveWebhooks(env, latest.map((webhook) => {
      const patch = patches.get(webhook.id);
      return patch ? { ...webhook, ...patch, updatedAt: webhook.updatedAt } : webhook;
    }));
  }
  return { sent, failed };
}

export async function testWebhook(env, id) {
  const webhooks = await loadWebhooks(env);
  const webhook = webhooks.find((item) => item.id === String(id));
  if (!webhook) throw new Error('Webhook not found');
  if (!isValidWebhookUrl(webhook.url)) throw new Error('Webhook URL must be a valid HTTPS URL');
  const payload = {
    event: 'webhook.test',
    action: 'webhook.test',
    target: 'webhook',
    targetId: webhook.id,
    summary: 'StarNav WebHook test event',
    detail: null,
    ip: null,
    timestamp: new Date().toISOString(),
  };
  const result = await invokeWebhook(webhook, payload);
  await updateWebhookDeliveryResult(env, webhook.id, {
    lastTriggeredAt: payload.timestamp,
    lastStatus: result.status,
    lastError: result.ok ? null : result.statusText || `HTTP ${result.status}`,
  });
  return result;
}