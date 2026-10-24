#!/usr/bin/env node
// 可选：把引擎包成一个 HTTP 服务。给「只会发 HTTP 请求」的调用方用，
// 也给「想让别人接我的 TTS」当最小实现参考。
//
// 启动：
//   node src/server.mjs --port 8899 --config ./tts.config.json
//   node src/server.mjs --port 8899 --token my-secret   # 加 Bearer 鉴权
//
// 接口：
//   GET  /            → 网页配置界面（src/web/index.html）
//   POST /tts     { "text": "...", "voice": "冰糖", "format": "mp3", "model": "..." }
//                 → 200 音频字节（Content-Type: audio/mpeg 或 audio/wav）
//   POST /api/preview → 同上，给网页「合成并试听」用
//   GET  /models  → { ok, url, models: [...] }（转发接口的模型列表）
//   GET  /config  → { ok, config }（describeTtsConfig，不回显密钥）
//   POST /config  → 保存配置到 tts.config.json，立即生效
//   GET  /healthz → { ok: true }
//
// 说明：服务端不落盘——合成结果读完就删，避免临时音频堆积。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { synthesize, describeTtsConfig, DEFAULT_CUSTOM_HEADERS, DEFAULT_CUSTOM_BODY } from './tts.mjs';
import { listModels } from './models.mjs';

function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

const args = parseArgv(process.argv.slice(2));
const port = Number(args.port || process.env.PORT || 8899);
const token = String(args.token || process.env.TTS_SERVER_TOKEN || '');
const maxBody = Number(args['max-body'] || 1024 * 1024);

const configPath = path.resolve(args.config || 'tts.config.json');
let ttsCfg = { provider: 'auto', fallback: true, custom: {} };
if (fs.existsSync(configPath)) {
  try {
    // 去掉 UTF-8 BOM：Windows 上很多编辑器/脚本写出来的 JSON 会带它，JSON.parse 会直接崩。
    const raw = fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '');
    ttsCfg = JSON.parse(raw);
  } catch (error) {
    console.error(`[tts-server] 配置文件解析失败 ${configPath}：${error.message}`);
    process.exit(1);
  }
}

// 模板留空就用出厂模板
ttsCfg.custom = ttsCfg.custom || {};
if (!String(ttsCfg.custom.headersText || '').trim()) ttsCfg.custom.headersText = DEFAULT_CUSTOM_HEADERS;
if (!String(ttsCfg.custom.bodyText || '').trim()) ttsCfg.custom.bodyText = DEFAULT_CUSTOM_BODY;

const MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac' };

const WEB_PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web', 'index.html');

const PROVIDERS = new Set(['auto', 'custom', 'edge', 'sapi']);
const FORMATS = new Set(['mp3', 'wav', 'pcm', 'pcm16', 'ogg']);
const METHODS = new Set(['POST', 'GET']);

function str(value, maxLength = 20000) {
  return String(value ?? '').slice(0, maxLength);
}

/**
 * 把网页提交的字段合进配置。规则：
 *   · 密钥为空 = 不修改（网页永远不回显密钥，所以空值不能被当成「清空」）
 *   · 请求头/请求体只接受字符串，不做 JSON 校验——原样存的语义优先，校验交给真正调用时
 *   · 其余字段做白名单/夹范围，写错就回落默认值，不让脏值进配置文件
 */
function mergeConfig(current, body) {
  const tts = JSON.parse(JSON.stringify(current || {}));
  tts.custom = tts.custom || {};
  const c = tts.custom;

  if (body.provider !== undefined) tts.provider = PROVIDERS.has(String(body.provider)) ? String(body.provider) : 'auto';
  if (body.fallback !== undefined) tts.fallback = Boolean(body.fallback);

  if (body.url !== undefined) c.url = str(body.url, 2000).trim();
  if (body.method !== undefined) {
    const m = str(body.method, 10).toUpperCase();
    c.method = METHODS.has(m) ? m : 'POST';
  }
  const key = str(body.apiKey, 400).trim();
  if (key) c.apiKey = key;

  if (body.model !== undefined) c.model = str(body.model, 120).trim();
  if (body.voice !== undefined) c.voice = str(body.voice, 120).trim();
  if (body.format !== undefined) {
    const f = str(body.format, 10).toLowerCase();
    c.format = FORMATS.has(f) ? f : 'mp3';
  }
  if (body.timeoutMs !== undefined) {
    const n = Math.round(Number(body.timeoutMs) || 60000);
    c.timeoutMs = Math.min(300000, Math.max(3000, n));
  }
  if (body.headersText !== undefined) c.headersText = str(body.headersText);
  if (body.bodyText !== undefined) c.bodyText = str(body.bodyText);

  // 老字段（对象式 headers/body）在保存时清掉，避免两套写法并存
  delete c.headers;
  delete c.body;
  delete c.bodyRaw;
  return tts;
}

function writeConfig(next) {
  const text = JSON.stringify(next, null, 2) + '\n';
  fs.writeFileSync(configPath, text, 'utf8');
  ttsCfg = next;
  if (!String(ttsCfg.custom?.headersText || '').trim()) ttsCfg.custom.headersText = DEFAULT_CUSTOM_HEADERS;
  if (!String(ttsCfg.custom?.bodyText || '').trim()) ttsCfg.custom.bodyText = DEFAULT_CUSTOM_BODY;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function authorized(req) {
  if (!token) return true;
  const header = String(req.headers.authorization || '');
  return header === `Bearer ${token}` || req.headers['x-tts-token'] === token;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBody) { reject(new Error(`请求体太大（上限 ${maxBody} 字节）`)); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

  if (req.method === 'GET' && url.pathname === '/healthz') return sendJson(res, 200, { ok: true });

  if (!authorized(req)) return sendJson(res, 401, { ok: false, error: '未授权：请带 Authorization: Bearer <token>' });

  // 网页配置界面：单文件、零依赖，直接读 src/web/index.html
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    let page;
    try {
      page = fs.readFileSync(WEB_PAGE, 'utf8');
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: `找不到网页文件：${WEB_PAGE}（${error.message}）` });
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(page), 'cache-control': 'no-store' });
    return res.end(page);
  }

  if (req.method === 'GET' && url.pathname === '/api/config') {
    return sendJson(res, 200, { ok: true, config: describeTtsConfig(ttsCfg), path: configPath });
  }

  if (req.method === 'POST' && url.pathname === '/api/config') {
    let body;
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : {};
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: `请求体不是合法 JSON：${error.message}` });
    }
    try {
      const next = mergeConfig(ttsCfg, body);
      writeConfig(next);
      return sendJson(res, 200, { ok: true, config: describeTtsConfig(ttsCfg), path: configPath });
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: `写配置失败：${error.message}` });
    }
  }

  if (req.method === 'GET' && (url.pathname === '/models' || url.pathname === '/api/models')) {
    const r = await listModels(ttsCfg, { timeoutMs: 15000 });
    // 多给一个 count，和命令行 `--list-models` 的输出对齐，方便脚本直接判空
    return sendJson(res, r.ok ? 200 : 502, r.ok ? { ...r, count: r.models.length } : r);
  }

  if (req.method === 'GET' && url.pathname === '/config') {
    // 不回显密钥（describeTtsConfig 只给 hasApiKey）
    return sendJson(res, 200, { ok: true, config: describeTtsConfig(ttsCfg) });
  }

  if (req.method === 'POST' && (url.pathname === '/tts' || url.pathname === '/api/preview' || url.pathname === '/')) {
    let payload;
    try {
      const raw = await readBody(req);
      payload = raw ? JSON.parse(raw) : {};
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: `请求体不是合法 JSON：${error.message}` });
    }
    const text = String(payload.text || payload.input || '').trim();
    if (!text) return sendJson(res, 400, { ok: false, error: '缺少 text（要念出来的文字）' });

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-api-'));
    try {
      const result = await synthesize({
        text,
        dir: tmpDir,
        voiceName: String(payload.voice || payload.voiceName || ''),
        engine: payload.engine ? String(payload.engine) : undefined,
        maxChars: Number(payload.maxChars || 2000),
        timeoutMs: Number(payload.timeoutMs || 60000),
        ttsCfg: {
          ...ttsCfg,
          custom: { ...(ttsCfg.custom || {}), ...(payload.format ? { format: String(payload.format) } : {}), ...(payload.model ? { model: String(payload.model) } : {}) }
        }
      });
      if (!result.ok) return sendJson(res, 502, { ok: false, error: result.error });
      const buf = fs.readFileSync(result.path);
      const ext = path.extname(result.path).replace('.', '').toLowerCase();
      res.writeHead(200, {
        'content-type': MIME[ext] || 'application/octet-stream',
        'content-length': buf.length,
        'x-tts-engine': String(result.engine || ''),
        'x-tts-voice': encodeURIComponent(String(result.voice || '')),
        'cache-control': 'no-store'
      });
      res.end(buf);
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String((error && error.message) || error) });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: '没有这个接口：GET /、GET /config、POST /config、GET /models、POST /tts、GET /healthz' });
});

server.listen(port, '127.0.0.1', () => {
  const cfg = describeTtsConfig(ttsCfg);
  console.log(`[tts-server] 已启动 http://127.0.0.1:${port}`);
  console.log(`[tts-server] 配置界面：http://127.0.0.1:${port}/  （配置文件 ${configPath}）`);
  console.log(`[tts-server] provider=${cfg.provider} ready=${cfg.custom.ready} modelsUrl=${cfg.custom.modelsUrl || '(未配置)'} auth=${token ? 'on' : 'off'}`);
  console.log('[tts-server] POST /tts  {text, voice?, format?, model?}  → 音频字节');
});
