// 读「官方模型列表」——任何 OpenAI 兼容服务都有 `<base>/v1/models`。
//
// 这里只做两件事：从请求地址推出 models 地址、带密钥去取一次并归一化成字符串数组。
// 不缓存（调用方自己决定要不要缓存），不写盘。
import { deriveModelsUrl } from './tts.mjs';

/**
 * 从 TTS 配置里推出模型列表地址：优先用 custom.modelsUrl，否则由 custom.url 推导。
 * @param {{custom?: {url?: string, modelsUrl?: string}}} ttsCfg
 * @returns {string} 空字符串表示推不出来
 */
export function modelsUrlOf(ttsCfg) {
  const custom = (ttsCfg && ttsCfg.custom) || {};
  const explicit = String(custom.modelsUrl || '').trim();
  if (explicit) return explicit;
  const url = String(custom.url || '').trim();
  return url ? deriveModelsUrl(url) : '';
}

/**
 * 取模型列表。
 * @param {{custom?: object}} ttsCfg - 与 src/tts.mjs 的 synthesize({ttsCfg}) 同一份配置
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{ok: boolean, url?: string, models?: string[], error?: string, status?: number}>}
 */
export async function listModels(ttsCfg, { timeoutMs = 15000 } = {}) {
  const custom = (ttsCfg && ttsCfg.custom) || {};
  const url = modelsUrlOf(ttsCfg);
  if (!url) return { ok: false, error: '还没配接口地址（custom.url）' };
  const apiKey = String(custom.apiKey || '').trim();

  const attempts = [];
  if (apiKey) attempts.push({ 'api-key': apiKey });
  if (apiKey) attempts.push({ authorization: `Bearer ${apiKey}` });
  attempts.push({}); // 有些本地服务不要鉴权

  let lastError = '请求失败';
  let lastStatus = 0;
  for (const headers of attempts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers, signal: controller.signal });
      const text = await res.text();
      if (!res.ok) {
        lastStatus = res.status;
        lastError = `HTTP ${res.status} ${text.slice(0, 300)}`.trim();
        continue;
      }
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { lastError = '返回的不是 JSON'; continue; }
      const raw = Array.isArray(parsed) ? parsed : (parsed.data || parsed.models || []);
      const models = raw
        .map(item => (typeof item === 'string' ? item : (item && (item.id || item.name || item.model))))
        .filter(Boolean)
        .map(String);
      if (!models.length) { lastError = '列表是空的'; continue; }
      return { ok: true, url, models };
    } catch (error) {
      lastError = error && error.name === 'AbortError' ? `超时（${timeoutMs}ms）` : String((error && error.message) || error);
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, url, status: lastStatus, error: lastError };
}
