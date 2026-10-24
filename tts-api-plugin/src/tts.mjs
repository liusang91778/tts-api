// 语音合成（TTS）：把一段文字变成语音库里的音频文件。
//
// 三条引擎，按配置顺序尝试：
//   1. custom —— 你自己接的 TTS HTTP API（OpenAI /audio/speech、火山、GPT-SoVITS、Fish、自建…）
//   2. edge   —— 微软 Edge 在线 TTS（免费免 key，mp3，中文音质不错）。走 `py -m edge_tts`。
//   3. sapi   —— Windows 自带 SAPI（完全离线，wav，音质一般，断网兜底）。
//
// 引擎选择：config.json → socialV2.voice.tts.provider = 'auto' | 'custom' | 'edge' | 'sapi'
//   auto（默认）= custom（若已配好）→ edge → sapi
//   custom      = 只用你配的 API（除非 tts.fallback === true，才在失败后继续降级）
//
// 设计约束：
//   · 不经过 shell：text 一律作为 argv / JSON 值传递，不让提示词里的 `&`、`|`、引号拼成命令。
//   · 生成物只落在语音库目录里，文件名由本模块生成（tts-时间戳-随机），**不采用外部传入的路径**。
//   · 失败必须返回可读原因（没配好 / 没网 / 没有中文声线 / API 返回了报错），不要静默产出 0 字节文件。
//   · custom 配置里的 apiKey 不会被回显到任何接口响应里（见 bridge 的 GET /api/voice/tts）。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** 推荐的 Edge 中文声线（AI 侧 tool 描述里也会列这几条）。 */
export const EDGE_VOICES = [
  'zh-CN-XiaoyiNeural',   // 女，年轻（默认）
  'zh-CN-XiaoxiaoNeural', // 女，标准
  'zh-CN-YunxiNeural',    // 男，青年
  'zh-CN-YunxiaNeural',   // 男，少年（可爱）
  'zh-CN-YunjianNeural',  // 男，成熟
  'zh-CN-YunyangNeural',  // 男，播报腔
  'zh-CN-liaoning-XiaobeiNeural',
  'zh-CN-shaanxi-XiaoniNeural'
];

export const DEFAULT_VOICE = 'zh-CN-XiaoyiNeural';

/** 允许落盘的音频扩展名（与 voice-core.js 的白名单保持一致）。 */
const AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus', 'amr', 'silk'];

/** 扩展名 → MIME，给克隆样本拼 DataURL 用（MiMo 的 voice clone 只吃 DataURL）。 */
const AUDIO_MIME = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  amr: 'audio/amr',
  silk: 'audio/silk',
  slk: 'audio/silk',
  wma: 'audio/x-ms-wma',
  spx: 'audio/ogg'
};

/** 按文件名后缀给 MIME（未知就当 audio/mpeg，别让 DataURL 前缀坏掉）。 */
function mimeOfAudioFile(name) {
  const ext = String(name || '').toLowerCase().split('.').pop();
  return AUDIO_MIME[ext] || 'audio/mpeg';
}

/** 跑一个子进程并收集输出；不经过 shell。 */
function run(cmd, args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, code: -1, stdout: '', stderr: String(error?.message ?? error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      settle({ ok: false, code: -2, stdout, stderr: `${stderr}\n(超时 ${timeoutMs}ms)` });
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => settle({ ok: false, code: -1, stdout, stderr: `${stderr}\n${error?.message ?? error}` }));
    child.on('close', (code) => settle({ ok: code === 0, code, stdout, stderr }));
  });
}

function isNonEmptyFile(file, minBytes = 1024) {
  try {
    // 只判 size > 0 是不够的：SAPI 的 SetOutputToWaveFile 会先建出 46 字节的空 wav 头，
    // 之后 Speak 抛异常也一样留下这个文件，看起来"生成成功"其实一句都没念。
    return fs.statSync(file).size >= minBytes;
  } catch {
    return false;
  }
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 删掉语音库里过旧的 tts-* 生成物，避免目录无限膨胀。 */
export function pruneTtsFiles(dir, keep = 30) {
  try {
    const files = fs.readdirSync(dir)
      .filter((name) => /^tts-.*\.(mp3|wav|ogg|m4a|aac|flac|opus|amr|silk)$/i.test(name))
      .map((name) => {
        const abs = path.join(dir, name);
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(abs).mtimeMs; } catch {}
        return { abs, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const item of files.slice(keep)) {
      try { fs.unlinkSync(item.abs); } catch {}
    }
  } catch {}
}

// ───────────────────────────── custom（自接 API） ─────────────────────────────

/**
 * 请求头 / 请求体的**出厂模板**。控制台那两个「复原」按钮就是回到这两份内容。
 *
 * 三条硬约定（用户明确要求，改之前先想清楚）：
 *   1. 发送时**只做占位符替换**，然后把「请求头 + 请求体」原样打包发出去：
 *      不自动加 Authorization、不补 Content-Type、不加任何前缀或后缀。
 *      写进去什么就发什么 —— 要认证就把认证头写在请求头里。
 *   2. 占位符一律用中文：{要念的话} {音色} {音色样本} {模型} {格式} {密钥}
 *      （旧的英文 {text}/{voice}/{model}/{format}/{apiKey} 仍然认，方便迁移老配置）
 *   3. 请求头与请求体是**两个独立文本模块**：各自可编辑、可保存、可一键复原；
 *      不再单独设「音色提示词」分区 —— 音色描述直接写在请求体里。
 */
export const PLACEHOLDERS = ['要念的话', '音色', '音色样本', '模型', '格式', '密钥'];

export const DEFAULT_CUSTOM_HEADERS = JSON.stringify({
  'api-key': '{密钥}',
  'Content-Type': 'application/json'
}, null, 2);

export const DEFAULT_CUSTOM_BODY = JSON.stringify({
  model: '{模型}',
  messages: [
    { role: 'user', content: '请用这个音色把下面这段话念出来。' },
    { role: 'assistant', content: '{要念的话}' }
  ],
  audio: { format: '{格式}', voice: '{音色}' }
}, null, 2);

/**
 * 校验并规范化 `socialV2.voice.tts.custom`。
 *
 * 期望形状（除 url 外都可省）：
 * {
 *   "url": "https://api.xiaomimimo.com/v1/chat/completions",
 *   "method": "POST",
 *   "apiKey": "sk-...",              // 只是 {密钥} 的值来源；不会自动变成任何请求头
 *   "headersText": "{...}",          // 请求头模块（JSON 文本，原样发送，只替换占位符）
 *   "bodyText": "{...}",             // 请求体模块（文本，原样发送，只替换占位符）
 *   "model": "mimo-v2.5-tts",        // {模型} 的值
 *   "voice": "茉莉",                 // {音色} 的默认值（AI 不指定时用它）
 *   "voiceMode": "id" | "file",      // file：把语音库里的样本转 base64 塞进 {音色样本}
 *   "format": "mp3",                 // {格式} 的值，同时是落盘扩展名
 *   "responseType": "audio" | "json",
 *   "responsePath": "choices.0.message.audio.data",
 *   "responseEncoding": "base64" | "url",
 *   "timeoutMs": 60000
 * }
 *
 * 老配置仍然能吃：`headers` 对象 → 转成 headersText；`body` 对象 / `bodyRaw` 字符串 → bodyText。
 *
 * @returns {{ok:boolean, cfg?:object, missing?:string[]}}
 */
export function normalizeCustomTts(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, missing: ['custom（未配置）'] };
  const url = String(raw.url ?? '').trim();
  const missing = [];
  if (!url) missing.push('url');
  else if (!/^https?:\/\//i.test(url)) missing.push('url 必须是 http(s):// 开头');

  // 请求头：优先文本模块；老配置是对象就序列化成文本
  let headersText = '';
  if (typeof raw.headersText === 'string' && raw.headersText.trim()) {
    headersText = raw.headersText;
  } else if (raw.headers && typeof raw.headers === 'object' && !Array.isArray(raw.headers)) {
    headersText = JSON.stringify(raw.headers, null, 2);
  }
  if (headersText.trim()) {
    try {
      const parsed = JSON.parse(headersText);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) missing.push('请求头必须是一个 JSON 对象（形如 {"api-key":"{密钥}"}）');
    } catch (error) {
      missing.push(`请求头不是合法 JSON：${error?.message ?? error}`);
    }
  }

  // 请求体：优先文本模块；老配置的 bodyRaw 字符串 / body 对象都迁过来
  let bodyText = '';
  if (typeof raw.bodyText === 'string' && raw.bodyText.trim()) bodyText = raw.bodyText;
  else if (typeof raw.bodyRaw === 'string' && raw.bodyRaw.trim()) bodyText = raw.bodyRaw;
  else if (raw.body && typeof raw.body === 'object' && !Array.isArray(raw.body)) bodyText = JSON.stringify(raw.body, null, 2);
  if (!bodyText.trim()) missing.push('请求体不能为空（bodyText）');

  // 返回形态：默认 auto —— 按响应的 Content-Type 自己判断（音频字节 / JSON 套一层 / JSON 给 URL），
  // 这样控制台就不用把这个开关摆给人调了。显式写 audio / json 仍然尊重。
  const rtRaw = String(raw.responseType ?? 'auto').toLowerCase();
  const responseType = rtRaw === 'json' || rtRaw === 'audio' ? rtRaw : 'auto';
  const responsePath = String(raw.responsePath ?? '').trim();
  if (responseType === 'json' && !responsePath) missing.push('responseType=json 时必须给 responsePath');
  const format = String(raw.format ?? 'mp3').toLowerCase().replace(/^\./, '');
  if (!AUDIO_EXTS.includes(format)) missing.push(`format 不支持：${format}（可用 ${AUDIO_EXTS.join('/')}）`);
  // 音色来源：id（{音色} = 音色名）或 file（{音色样本} = 本地样本 base64，用于声音克隆）
  const voiceMode = String(raw.voiceMode ?? 'id').toLowerCase() === 'file' ? 'file' : 'id';
  const voiceFile = String(raw.voiceFile ?? '').trim();
  if (voiceMode === 'file' && !voiceFile) missing.push('voiceMode=file 时必须给 voiceFile（样本文件，放在语音库目录里）');
  if (missing.length) return { ok: false, missing };
  return {
    ok: true,
    cfg: {
      url,
      method: String(raw.method ?? 'POST').toUpperCase() === 'GET' ? 'GET' : 'POST',
      apiKey: String(raw.apiKey ?? ''),
      headersText,
      bodyText,
      format,
      voice: String(raw.voice ?? '').trim(),
      voiceMode,
      voiceFile,
      model: String(raw.model ?? '').trim(),
      responseType,
      responsePath,
      responseEncoding: String(raw.responseEncoding ?? 'base64').toLowerCase() === 'url' ? 'url' : 'base64',
      timeoutMs: Math.max(3000, Number(raw.timeoutMs) || 60000)
    }
  };
}

/**
 * 读取声音克隆用的样本文件并转成 base64（`mimo-v2.5-tts-voiceclone` 这类接口要的就是这个）。
 *
 * 安全边界：只允许读**语音库目录里的**文件（不接受绝对路径、不接受 `..`），扩展名必须在
 * AUDIO_EXTS 里，体积 ≤ maxBytes。否则这个功能就变成了"把本机任意文件 base64 后发到
 * 你配的 TTS 服务"的外发口子。
 */
function readVoiceSample(voiceDir, relPath, maxBytes = 10 * 1024 * 1024) {
  const raw = String(relPath ?? '').trim();
  if (!raw) return { ok: false, error: '未配置样本文件' };
  if (/^(base64:\/\/|data:|https?:\/\/)/i.test(raw)) return { ok: false, error: '样本必须是语音库里的本地文件，不接受 base64/URL' };
  if (path.isAbsolute(raw) || raw.split(/[\\/]/).includes('..')) return { ok: false, error: '样本路径必须是语音库目录内的相对路径' };
  const dirAbs = path.resolve(voiceDir);
  const abs = path.resolve(dirAbs, raw);
  const rel = path.relative(dirAbs, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, error: '样本必须在语音库目录内' };
  const ext = path.extname(abs).slice(1).toLowerCase();
  if (!AUDIO_EXTS.includes(ext)) return { ok: false, error: `样本扩展名不支持：.${ext}（可用 ${AUDIO_EXTS.join('/')}）` };
  let st;
  try { st = fs.statSync(abs); } catch { return { ok: false, error: `找不到样本文件：${raw}` }; }
  if (!st.isFile()) return { ok: false, error: `不是文件：${raw}` };
  if (st.size < 1024) return { ok: false, error: `样本太小（${st.size} 字节）` };
  if (st.size > maxBytes) return { ok: false, error: `样本太大（${st.size} 字节，上限 ${maxBytes}）` };
  try {
    return { ok: true, base64: fs.readFileSync(abs).toString('base64'), name: rel, bytes: st.size };
  } catch (error) {
    return { ok: false, error: `读取样本失败：${error?.message ?? error}` };
  }
}

/**
 * 占位符替换（单趟，不递归展开）。
 *
 * 中文是**推荐写法**，英文是同义别名（老配置/老文档还在用）。
 * 顺序有讲究：`音色样本` 必须排在 `音色` 前面，否则 `{音色样本}` 会被 `{音色}` 抢先匹配成
 * 「音色值 + 样本}」，替换结果就错位了。
 */
const PLACEHOLDER_RE = /\{(要念的话|音色样本|音色|模型|格式|密钥|text|sample|voice|model|format|apiKey)\}/g;

function fillTemplate(str, vars) {
  return String(str ?? '').replace(PLACEHOLDER_RE, (_m, key) => String(vars[key] ?? ''));
}

/** 按点号路径取值，支持数组下标：'data.audio' / 'choices.0.audio' 。 */
function pickPath(obj, dotted) {
  if (!dotted) return undefined;
  let cur = obj;
  for (const part of String(dotted).split('.')) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

/**
 * auto 模式下要猜的音频字段路径（按常见度排序）。
 * OpenAI chat 兼容（MiMo 就是这条）、各种 TTS 网关的返回都大致落在这些地方。
 */
const AUTO_AUDIO_PATHS = [
  'choices.0.message.audio.data',
  'choices.0.audio.data',
  'data.audio.data',
  'data.audio',
  'data.audio_base64',
  'audio.data',
  'audio',
  'result.audio.data',
  'result.audio',
  'output.audio.data',
  'output.audio',
  'response.audio.data',
  'data'
];

/**
 * 在 JSON 响应里找音频。返回 `{ base64 }` 或 `{ url }`，找不到返回 null。
 * 值可以是：base64 串、http(s) URL、或者是 `{ data | base64 | url }` 这样的对象。
 */
function pickAudioFromJson(js, preferredPath) {
  const paths = preferredPath ? [preferredPath, ...AUTO_AUDIO_PATHS] : AUTO_AUDIO_PATHS;
  for (const p of paths) {
    const val = pickPath(js, p);
    const norm = normalizeAudioValue(val);
    if (norm) return norm;
  }
  return null;
}

function normalizeAudioValue(val) {
  if (val && typeof val === 'object') {
    for (const key of ['data', 'base64', 'audio', 'audio_base64', 'b64']) {
      const inner = normalizeAudioValue(val[key]);
      if (inner) return inner;
    }
    for (const key of ['url', 'audio_url', 'href']) {
      if (typeof val[key] === 'string' && /^https?:\/\//i.test(val[key])) return { url: val[key] };
    }
    return null;
  }
  if (typeof val !== 'string') return null;
  const s = val.trim();
  if (!s || s.length < 64) return null;
  if (/^https?:\/\//i.test(s)) return { url: s };
  if (/^data:[^;]+;base64,/i.test(s)) return { base64: s.replace(/^data:[^;]+;base64,/i, '') };
  // 长 base64（音频至少几十 KB，纯文本不会这么长且通常带非 base64 字符）
  if (/^[A-Za-z0-9+/=\s]+$/.test(s)) return { base64: s.replace(/\s+/g, '') };
  return null;
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function tryCustom({ text, voiceName, fileBase, dir, cfg, timeoutMs }) {
  const c = cfg;
  // 音色取值：id 模式 = 音色名（AI 传的 voiceName 优先，其次配置里的 voice）；
  // file 模式 = 本地样本的 base64（声音克隆），此时 voiceName 无意义。
  let voiceValue = '';
  let sampleValue = '';
  let voiceLabel = '';
  if (c.voiceMode === 'file') {
    const sample = readVoiceSample(dir, c.voiceFile);
    if (!sample.ok) return { ok: false, notes: [`custom: 克隆样本不可用（${sample.error}）`] };
    // {音色样本} 用 DataURL（OpenAI 系 / MiMo 的 voice clone 都要求这个形态：
    // "audio.voice must be a DataURL for voice clone model"），{音色} 保留裸 base64 以兼容老模板。
    sampleValue = `data:${mimeOfAudioFile(sample.name)};base64,${sample.base64}`;
    voiceValue = sample.base64;
    voiceLabel = `克隆样本:${sample.name}`;
  } else {
    voiceValue = String(voiceName || c.voice || '');
    sampleValue = voiceValue;
    voiceLabel = voiceValue;
  }
  const vars = {
    // 中文占位符（推荐）
    '要念的话': text,
    '音色': voiceValue,
    '音色样本': sampleValue,
    '模型': c.model,
    '格式': c.format,
    '密钥': c.apiKey,
    // 英文别名（老配置）
    text,
    voice: voiceValue,
    sample: sampleValue,
    apiKey: c.apiKey,
    format: c.format,
    model: c.model
  };

  // 请求头：解析成对象 → 只替换占位符 → 原样发。**不补任何头**（不加 Authorization、
  // 不加 Content-Type）。用户在模块里漏了 Content-Type，就是真的不带 —— 这是他要的语义。
  let headerObj = {};
  if (c.headersText && c.headersText.trim()) {
    try {
      headerObj = JSON.parse(c.headersText);
    } catch (error) {
      return { ok: false, notes: [`custom: 请求头不是合法 JSON（${error?.message ?? error}）`] };
    }
    if (!headerObj || typeof headerObj !== 'object' || Array.isArray(headerObj)) {
      return { ok: false, notes: ['custom: 请求头必须是 JSON 对象'] };
    }
  }
  const headers = {};
  for (const [k, v] of Object.entries(headerObj)) headers[k] = fillTemplate(v, vars);

  // 请求体：文本模板直接替换后原样发送（不 JSON.parse / 不重排缩进 / 不加前后缀）。
  const body = fillTemplate(c.bodyText ?? '', vars);
  if (!body.trim()) return { ok: false, notes: ['custom: 请求体是空的'] };

  let res;
  try {
    res = await fetchWithTimeout(c.url, { method: c.method, headers, body }, timeoutMs);
  } catch (error) {
    return { ok: false, notes: [`custom: 请求失败（${error?.name === 'AbortError' ? `超时 ${timeoutMs}ms` : (error?.message ?? error)}）`] };
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 300).replace(/\s+/g, ' '); } catch {}
    return { ok: false, notes: [`custom: HTTP ${res.status} ${detail}`] };
  }

  let buf = null;
  try {
    if (c.responseType === 'json') {
      const js = await res.json();
      const val = pickPath(js, c.responsePath);
      if (typeof val !== 'string' || !val) {
        return { ok: false, notes: [`custom: 响应里 ${c.responsePath} 不是字符串（实际 ${typeof val}）`] };
      }
      if (c.responseEncoding === 'url') {
        const audioRes = await fetchWithTimeout(val, { method: 'GET' }, timeoutMs);
        if (!audioRes.ok) return { ok: false, notes: [`custom: 音频 URL 下载失败 HTTP ${audioRes.status}`] };
        buf = Buffer.from(await audioRes.arrayBuffer());
      } else {
        buf = Buffer.from(val, 'base64');
      }
    } else if (c.responseType === 'audio') {
      buf = Buffer.from(await res.arrayBuffer());
    } else {
      // auto：看 Content-Type 自己判断，不让用户在界面上操心「返回形态」。
      const ctype = String(res.headers.get('content-type') || '').toLowerCase();
      if (!ctype.includes('json')) {
        buf = Buffer.from(await res.arrayBuffer());
      } else {
        const js = await res.json();
        const picked = pickAudioFromJson(js, c.responsePath);
        if (!picked) {
          return {
            ok: false,
            notes: [`custom: 响应是 JSON 但里面没找到音频数据（找过 ${AUTO_AUDIO_PATHS.join(' / ')}）`]
          };
        }
        if (picked.url) {
          const audioRes = await fetchWithTimeout(picked.url, { method: 'GET' }, timeoutMs);
          if (!audioRes.ok) return { ok: false, notes: [`custom: 音频 URL 下载失败 HTTP ${audioRes.status}`] };
          buf = Buffer.from(await audioRes.arrayBuffer());
        } else {
          buf = Buffer.from(picked.base64, 'base64');
        }
      }
    }
  } catch (error) {
    return { ok: false, notes: [`custom: 解析响应失败（${error?.message ?? error}）`] };
  }

  if (!buf || buf.length < 1024) {
    return { ok: false, notes: [`custom: 返回的音频过小（${buf ? buf.length : 0} 字节），多半不是音频`] };
  }
  const file = path.join(dir, `${fileBase}.${c.format}`);
  try { fs.writeFileSync(file, buf); } catch (error) {
    return { ok: false, notes: [`custom: 写入失败（${error?.message ?? error}）`] };
  }
  return { ok: true, engine: 'custom', file, voice: voiceLabel, bytes: buf.length };
}

// ───────────────────────────── edge / sapi ─────────────────────────────

async function tryEdge({ text, voiceName, file, timeoutMs }) {
  const notes = [];
  for (const exe of ['py', 'python']) {
    const res = await run(exe, ['-m', 'edge_tts', '--voice', voiceName, '--text', text, '--write-media', file], { timeoutMs });
    if (res.ok && isNonEmptyFile(file)) return { ok: true, engine: 'edge', via: exe };
    // 该解释器不存在 / 没装 edge_tts / 网络不通：记一条原因，继续降级
    const reason = `${exe}: ${String(res.stderr || res.stdout || '').trim().split('\n').slice(-2).join(' ')}`;
    notes.push(reason);
  }
  return { ok: false, notes };
}

async function trySapi({ text, file, timeoutMs }) {
  const textFile = `${file}.txt`;
  fs.writeFileSync(textFile, text, 'utf8');
  const q = (s) => String(s).replace(/'/g, "''");
  const script = [
    'Add-Type -AssemblyName System.Speech;',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
    '$v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like "zh-*" -and $_.Enabled } | Select-Object -First 1;',
    'if ($v) { $s.SelectVoice($v.VoiceInfo.Name) };',
    `$s.SetOutputToWaveFile('${q(file)}');`,
    `$s.Speak([IO.File]::ReadAllText('${q(textFile)}'));`,
    '$s.Dispose()'
  ].join(' ');
  const res = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeoutMs: timeoutMs + 20000 });
  try { fs.unlinkSync(textFile); } catch {}
  if (res.ok && isNonEmptyFile(file)) return { ok: true, engine: 'sapi' };
  return { ok: false, notes: [`sapi: ${String(res.stderr || '').trim().split('\n').slice(-2).join(' ')}`] };
}

// ───────────────────────────── 对外入口 ─────────────────────────────

/**
 * 把文字合成为语音库里的一个音频文件。
 *
 * @param {object} opts
 * @param {string} opts.text - 要念的文字。
 * @param {string} opts.dir - 语音库绝对路径（生成物一定落在这个目录里）。
 * @param {string} [opts.voiceName] - 声线（custom 侧是它自己的音色 id；edge 侧是 zh-CN-* Neural 名）。
 * @param {'auto'|'custom'|'edge'|'sapi'} [opts.engine] - 显式指定引擎；不给则用 ttsCfg.provider，再不行 auto。
 * @param {object} [opts.ttsCfg] - config.json → socialV2.voice.tts（provider / custom / fallback）。
 * @param {number} [opts.maxChars] - 文字上限，超了直接拒绝（语音别太长）。
 * @param {number} [opts.timeoutMs] - 单次合成超时。
 * @returns {Promise<{ok:boolean,name?:string,path?:string,engine?:string,voice?:string,bytes?:number,error?:string,notes?:string[]}>}
 */
export async function synthesize({ text, dir, voiceName = '', engine, maxChars = 120, timeoutMs = 60000, ttsCfg = null } = {}) {
  const content = String(text ?? '').trim();
  if (!content) return { ok: false, error: 'text 不能为空' };
  if (maxChars > 0 && [...content].length > maxChars) {
    return { ok: false, error: `文字过长（${[...content].length} 字，上限 ${maxChars} 字）：语音别念长篇大论` };
  }
  if (!dir) return { ok: false, error: '语音库目录未知' };
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  if (!fs.existsSync(dir)) return { ok: false, error: `语音库目录不存在：${dir}` };

  const tts = ttsCfg && typeof ttsCfg === 'object' ? ttsCfg : {};
  const provider = String(tts.provider || 'auto').toLowerCase();
  const wants = String(engine || provider || 'auto').toLowerCase();
  const customNorm = normalizeCustomTts(tts.custom);
  const customReady = customNorm.ok;

  const base = `tts-${stamp()}-${Math.random().toString(36).slice(2, 6)}`;
  const notes = [];

  // 1) custom（自接 API）
  if (wants === 'custom' || (wants === 'auto' && customReady)) {
    if (!customReady) {
      return { ok: false, error: `custom TTS 还没配好，缺：${(customNorm.missing ?? []).join('；')}` };
    }
    const r = await tryCustom({
      text: content,
      voiceName: voiceName || customNorm.cfg.voice,
      fileBase: base,
      dir,
      cfg: customNorm.cfg,
      timeoutMs: Math.max(timeoutMs, customNorm.cfg.timeoutMs)
    });
    if (r.ok) {
      pruneTtsFiles(dir);
      return { ok: true, name: path.basename(r.file), path: r.file, engine: 'custom', voice: r.voice, bytes: r.bytes };
    }
    notes.push(...(r.notes ?? []));
    if (wants === 'custom' && tts.fallback !== true) {
      return { ok: false, error: r.notes?.[0] ?? 'custom TTS 合成失败', notes };
    }
  }

  // 2) edge
  if (wants === 'auto' || wants === 'edge' || wants === 'custom') {
    const edgeName = String(voiceName || DEFAULT_VOICE);
    // 声线名不像 Edge 的（比如自定义 API 的音色 id）就别硬塞给 edge
    const edgeVoice = /^[a-z]{2,3}-[A-Z]{2}-/i.test(edgeName) ? edgeName : DEFAULT_VOICE;
    const mp3 = path.join(dir, `${base}.mp3`);
    const res = await tryEdge({ text: content, voiceName: edgeVoice, file: mp3, timeoutMs });
    if (res.ok) {
      pruneTtsFiles(dir);
      return { ok: true, name: path.basename(mp3), path: mp3, engine: 'edge', voice: edgeVoice, bytes: fs.statSync(mp3).size };
    }
    notes.push(...(res.notes ?? []));
    try { fs.unlinkSync(mp3); } catch {}
    if (wants === 'edge') {
      return { ok: false, error: `Edge TTS 合成失败：${notes.join(' | ')}` };
    }
  }

  // 3) sapi（离线兜底）
  if (wants === 'auto' || wants === 'sapi' || (wants === 'custom' && tts.fallback === true)) {
    const wav = path.join(dir, `${base}.wav`);
    const sapi = await trySapi({ text: content, file: wav, timeoutMs });
    if (sapi.ok) {
      pruneTtsFiles(dir);
      return { ok: true, name: path.basename(wav), path: wav, engine: 'sapi', bytes: fs.statSync(wav).size, notes };
    }
    notes.push(...(sapi.notes ?? []));
    try { fs.unlinkSync(wav); } catch {}
    if (wants === 'sapi') {
      return { ok: false, error: `SAPI 合成失败：${notes.join(' | ')}` };
    }
  }

  return { ok: false, error: `语音合成失败（${wants}）：${notes.filter(Boolean).join(' | ') || '未知原因'}`, notes };
}

/**
 * 从 TTS 接口地址推出「模型列表」地址（控制台的模型下拉框用它去问官方 API）。
 *
 * 规则：路径里带 `/v1`（或 `/v2`…）就换成 `<base>/v1/models`，否则把最后一段换成 `models`。
 * 例：`https://api.xiaomimimo.com/v1/chat/completions` → `https://api.xiaomimimo.com/v1/models`。
 * 推不出来就返回空串（调用方自己报错，不要瞎猜）。
 */
export function deriveModelsUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl ?? '').trim());
    const path = u.pathname.replace(/\/+$/, '');
    const versioned = path.match(/^(.*\/v\d+(?:\.\d+)?)(?:\/.*)?$/i);
    if (versioned) u.pathname = `${versioned[1]}/models`;
    else if (path) u.pathname = `${path.replace(/\/[^/]*$/, '')}/models`;
    else u.pathname = '/models';
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return '';
  }
}

/**
 * 给控制台/CLI 用的「当前 TTS 配置」摘要。
 *
 * 注意：headersText / bodyText 会**原样回显**给控制台（那是用户自己编辑的两个文本模块，
 * 不给回去就没法编辑）。如果他把明文密钥直接写进了请求头模块，回显的就是明文——
 * 这是那两块文本的语义，不是 apiKey 字段（那个仍然只回 hasApiKey）。
 */
export function describeTtsConfig(ttsCfg) {
  const tts = ttsCfg && typeof ttsCfg === 'object' ? ttsCfg : {};
  const provider = String(tts.provider || 'auto').toLowerCase();
  const norm = normalizeCustomTts(tts.custom);
  const custom = norm.ok
    ? {
        ready: true,
        url: norm.cfg.url,
        method: norm.cfg.method,
        format: norm.cfg.format,
        voiceMode: norm.cfg.voiceMode,
        voice: norm.cfg.voice || '',
        voiceFile: norm.cfg.voiceFile,
        model: norm.cfg.model,
        responseType: norm.cfg.responseType,
        responsePath: norm.cfg.responsePath,
        hasApiKey: Boolean(norm.cfg.apiKey),
        hasBodyTemplate: Boolean(norm.cfg.bodyText && norm.cfg.bodyText.trim()),
        headersText: norm.cfg.headersText,
        bodyText: norm.cfg.bodyText,
        modelsUrl: deriveModelsUrl(norm.cfg.url),
        timeoutMs: norm.cfg.timeoutMs
      }
    : {
        ready: false,
        missing: norm.missing ?? [],
        // 还没配好也要把两块模板回给控制台，否则「复原」按钮没有目标
        headersText: String(tts.custom?.headersText ?? DEFAULT_CUSTOM_HEADERS),
        bodyText: String(tts.custom?.bodyText ?? DEFAULT_CUSTOM_BODY),
        modelsUrl: deriveModelsUrl(tts.custom?.url)
      };
  return {
    provider,
    fallbackToEdge: tts.fallback === true,
    defaultVoice: DEFAULT_VOICE,
    edgeVoices: EDGE_VOICES,
    placeholders: PLACEHOLDERS,
    defaults: { headers: DEFAULT_CUSTOM_HEADERS, body: DEFAULT_CUSTOM_BODY },
    custom
  };
}
