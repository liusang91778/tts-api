#!/usr/bin/env node
/**
 * TTS MCP server —— 装进 qq-bridge 的 <bridge>/src/ 之后由 DSH 以 stdio 拉起。
 *
 * 它只做「把文字变成语音文件」，不直接往 QQ 发：
 *   - 合成结果落在桥接的语音库目录（config.socialV2.voice.dir，默认 audio/）；
 *   - 拿到文件名后，用它已有的 qq_send_voice 发出去就是一条真语音。
 * 这样它不依赖桥接内部实现，桥接升级也不会把它弄坏。
 *
 * 工具：
 *   tts_status     配置是否就绪（不回显密钥）
 *   tts_speak      文字 → 语音文件
 *   tts_models     读接口的模型列表
 *   tts_configure  改接口地址 / 密钥 / 模型 / 音色（写回桥接 config.json）
 *
 * 自检（不启动 stdio，直接打一行结果）：node src/mcp-tts.js --selftest
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { synthesize, describeTtsConfig, DEFAULT_VOICE } from './tts.mjs';
import { listModels } from './models.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = path.join(ROOT, 'config.json');

/** 每次调用都重读配置：改完配置无需重启桥接或 DSH。 */
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return {};
  }
}

function voiceSettings(cfg = loadConfig()) {
  const voice = (cfg.socialV2 && cfg.socialV2.voice) || {};
  const tts = voice.tts || {};
  return {
    enabled: voice.enabled !== false,
    dir: path.resolve(ROOT, voice.dir || 'audio'),
    maxChars: Number(voice.ttsMaxChars || 200),
    tts
  };
}

function ok(text) {
  return { content: [{ type: 'text', text }] };
}

function fail(text) {
  return { content: [{ type: 'text', text: `Error: ${text}` }], isError: true };
}

function statusText() {
  const cfg = loadConfig();
  const s = voiceSettings(cfg);
  const d = describeTtsConfig(s.tts);
  const lines = [];
  lines.push(`引擎：${d.provider}（fallback ${d.fallbackToEdge ? '开' : '关'}）`);
  lines.push(`接口：${(d.custom && d.custom.url) || '(未配置)'}`);
  lines.push(`密钥：${d.custom && d.custom.hasApiKey ? '已配置' : '未配置'}`);
  lines.push(`模型：${(d.custom && d.custom.model) || '(未填)'}｜音色：${(d.custom && d.custom.voice) || '(未填)'}`);
  lines.push(`语音库：${s.dir}`);
  lines.push(`单条上限：${s.maxChars} 字`);
  if (d.custom && d.custom.missing && d.custom.missing.length) lines.push(`还缺：${d.custom.missing.join('、')}`);
  lines.push(`就绪：${d.custom && d.custom.ready ? '是（可以 tts_speak）' : '否（先 tts_configure 或改 config.json）'}`);
  return lines.join('\n');
}

const server = new McpServer({ name: 'tts', version: '0.1.0' });

server.tool(
  'tts_status',
  '看当前 TTS 配置是否就绪：引擎、接口地址、密钥有没有、模型/音色、语音库目录、还剩什么没配（密钥不会回显）。',
  {},
  async () => ok(statusText())
);

server.tool(
  'tts_speak',
  '把一段文字合成成语音文件（落在语音库目录），返回文件名。要发到 QQ 就用 qq_send_voice 发这个文件名。',
  {
    text: z.string().min(1).describe('要念出来的文字'),
    voice: z.string().optional().describe('音色 id（不传用配置里的）'),
    model: z.string().optional().describe('模型 id（不传用配置里的）'),
    format: z.string().optional().describe('容器格式，默认用配置里的（一般 mp3）'),
    prefix: z.string().optional().describe('文件名前缀，默认 tts')
  },
  async ({ text, voice, model, format, prefix }) => {
    const s = voiceSettings();
    if (!s.enabled) return fail('TTS 在桥接配置里被关掉了（socialV2.voice.enabled=false）');
    const trimmed = String(text || '').trim();
    if (!trimmed) return fail('text 是空的');
    if (trimmed.length > s.maxChars) return fail(`文字太长了（${trimmed.length} 字），这条通道单次最多 ${s.maxChars} 字`);

    fs.mkdirSync(s.dir, { recursive: true });
    const ttsCfg = {
      ...s.tts,
      custom: {
        ...((s.tts && s.tts.custom) || {}),
        ...(model ? { model: String(model) } : {}),
        ...(format ? { format: String(format) } : {}),
        ...(voice ? { voice: String(voice) } : {})
      }
    };
    const r = await synthesize({
      text: trimmed,
      dir: s.dir,
      voiceName: String(voice || ''),
      engine: undefined,
      maxChars: s.maxChars,
      timeoutMs: Number((s.tts && s.tts.custom && s.tts.custom.timeoutMs) || 60000),
      ttsCfg
    });
    if (!r.ok) return fail(`合成失败：${r.error}`);
    const rel = path.relative(s.dir, r.path).split(path.sep).join('/');
    return ok([
      `✅ 合成好了：${rel}（${r.engine}｜${r.voice || '-'}｜${Math.round((r.bytes || 0) / 1024)} KB）`,
      `绝对路径：${r.path}`,
      `发声就调：qq_send_voice { voice: "${rel}" }（名字就是相对语音库的路径）`,
      `⚠️ 只有 qq_send_voice 返回 verified=true 才算真的发出去了`
    ].join('\n'));
  }
);

server.tool(
  'tts_models',
  '读接口的模型列表（OpenAI 兼容的 /v1/models），用来确认密钥通不通、有哪些模型可选。',
  {},
  async () => {
    const s = voiceSettings();
    const r = await listModels(s.tts, { timeoutMs: 15000 });
    if (!r.ok) return fail(`读模型列表失败：${r.error}`);
    return ok(`✅ ${r.url}\n共 ${r.models.length} 个：${r.models.join('、')}`);
  }
);

server.tool(
  'tts_configure',
  '改 TTS 的接口地址 / 密钥 / 模型 / 音色 / 格式化参数（写回桥接 config.json，立即生效）。只改你传的字段。',
  {
    url: z.string().optional().describe('接口地址，http(s):// 开头'),
    apiKey: z.string().optional().describe('密钥（只用于 {密钥} 占位符）'),
    model: z.string().optional().describe('模型 id'),
    voice: z.string().optional().describe('音色 id'),
    format: z.string().optional().describe('mp3 / wav …'),
    provider: z.enum(['auto', 'custom', 'edge', 'sapi']).optional().describe('引擎选择'),
    fallback: z.boolean().optional().describe('自定义接口失败时是否降级到 edge/sapi')
  },
  async (patch) => {
    const cfg = loadConfig();
    cfg.socialV2 = cfg.socialV2 || {};
    cfg.socialV2.voice = cfg.socialV2.voice || {};
    const tts = cfg.socialV2.voice.tts = cfg.socialV2.voice.tts || {};
    tts.custom = tts.custom || {};
    const names = [];
    if (patch.url !== undefined) { tts.custom.url = patch.url; names.push('url'); }
    if (patch.apiKey !== undefined) { tts.custom.apiKey = patch.apiKey; names.push('apiKey'); }
    if (patch.model !== undefined) { tts.custom.model = patch.model; names.push('model'); }
    if (patch.voice !== undefined) { tts.custom.voice = patch.voice; names.push('voice'); }
    if (patch.format !== undefined) { tts.custom.format = patch.format; names.push('format'); }
    if (patch.provider !== undefined) { tts.provider = patch.provider; names.push('provider'); }
    if (patch.fallback !== undefined) { tts.fallback = !!patch.fallback; names.push('fallback'); }
    if (!names.length) return fail('没有要改的字段');
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    return ok(`✅ 已写入 config.json：${names.join('、')}\n\n${statusText()}`);
  }
);

if (process.argv.includes('--selftest')) {
  const s = voiceSettings();
  const d = describeTtsConfig(s.tts);
  console.log(JSON.stringify({
    root: ROOT,
    voiceDir: s.dir,
    tools: ['tts_status', 'tts_speak', 'tts_models', 'tts_configure'],
    provider: d.provider,
    ready: !!(d.custom && d.custom.ready),
    hasApiKey: !!(d.custom && d.custom.hasApiKey),
    modelsUrl: (d.custom && d.custom.modelsUrl) || '',
    defaultVoice: DEFAULT_VOICE
  }, null, 2));
  process.exit(0);
}

await server.connect(new StdioServerTransport());
