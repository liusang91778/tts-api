#!/usr/bin/env node
// 命令行入口：把一句话合成成音频文件，或读一下模型列表 / 打印出厂模板。
//
// 用法（不需要 npm install，零依赖）：
//   node src/cli.mjs --text "你好" --out hello.mp3
//   node src/cli.mjs --file script.txt --voice 冰糖 --format mp3
//   node src/cli.mjs --list-models
//   node src/cli.mjs --print-defaults
//
// 配置优先级：命令行参数 > 环境变量 > --config 指定的 JSON 文件。
import fs from 'node:fs';
import path from 'node:path';
import {
  synthesize, DEFAULT_VOICE, describeTtsConfig,
  DEFAULT_CUSTOM_HEADERS, DEFAULT_CUSTOM_BODY, PLACEHOLDERS
} from './tts.mjs';
import { listModels } from './models.mjs';

function parseArgv(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) { out._.push(token); continue; }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

function readConfig(file) {
  const target = path.resolve(file || 'tts.config.json');
  if (!fs.existsSync(target)) return { config: {}, file: target, missing: true };
  try {
    // 去掉 UTF-8 BOM：Windows 编辑器常写出来，JSON.parse 会直接崩。
    const raw = fs.readFileSync(target, 'utf8').replace(/^\uFEFF/, '');
    return { config: JSON.parse(raw), file: target, missing: false };
  } catch (error) {
    console.error(`[tts] 读不了配置文件 ${target}：${error.message}`);
    process.exit(1);
  }
}

/** 把「配置文件 + 环境变量 + 命令行」合成一份 ttsCfg（形状与 src/tts.mjs 期望的一致）。 */
function buildTtsConfig(args, fileConfig) {
  const base = fileConfig || {};
  const custom = { ...(base.custom || {}) };
  if (process.env.TTS_URL) custom.url = process.env.TTS_URL;
  if (process.env.TTS_KEY) custom.apiKey = process.env.TTS_KEY;
  if (args.url) custom.url = args.url;
  if (args.key) custom.apiKey = args.key;
  if (args['headers-text']) custom.headersText = args['headers-text'];
  if (args['body-text']) custom.bodyText = args['body-text'];
  if (args.model) custom.model = args.model;
  if (args.voice) custom.voice = args.voice;
  if (args.format) custom.format = args.format;
  if (args['response-type']) custom.responseType = args['response-type'];
  if (args['voice-mode']) custom.voiceMode = args['voice-mode'];
  if (args['voice-file']) custom.voiceFile = args['voice-file'];

  // 没给模板就用出厂模板（否则只填 url+key 的用户会卡在「请求体不能为空」）。
  if (!String(custom.headersText || '').trim()) custom.headersText = DEFAULT_CUSTOM_HEADERS;
  if (!String(custom.bodyText || '').trim()) custom.bodyText = DEFAULT_CUSTOM_BODY;

  return {
    provider: args.provider || process.env.TTS_PROVIDER || base.provider || 'auto',
    fallback: base.fallback !== false,
    custom
  };
}

function readText(args) {
  if (typeof args.text === 'string') return args.text;
  if (typeof args.file === 'string') {
    const file = path.resolve(args.file);
    if (!fs.existsSync(file)) { console.error(`[tts] 找不到文本文件：${file}`); process.exit(1); }
    return fs.readFileSync(file, 'utf8');
  }
  if (!process.stdin.isTTY) {
    try { return fs.readFileSync(0, 'utf8'); } catch { /* 落下去报错 */ }
  }
  return '';
}

async function main() {
  const args = parseArgv(process.argv.slice(2));

  if (args.help || args.h) {
    console.log(fs.readFileSync(new URL('./help.txt', import.meta.url), 'utf8'));
    return 0;
  }

  if (args['print-defaults']) {
    console.log(JSON.stringify({
      placeholders: PLACEHOLDERS,
      headersText: DEFAULT_CUSTOM_HEADERS,
      bodyText: DEFAULT_CUSTOM_BODY,
      defaultVoice: DEFAULT_VOICE
    }, null, 2));
    return 0;
  }

  const loaded = readConfig(args.config);
  const ttsCfg = buildTtsConfig(args, loaded.config);

  if (args['list-models'] || args.models) {
    const r = await listModels(ttsCfg, { timeoutMs: Number(args.timeout || 15000) });
    if (!r.ok) { console.error(`[tts] 读模型列表失败：${r.error}`); return 1; }
    console.log(JSON.stringify({ url: r.url, count: r.models.length, models: r.models }, null, 2));
    return 0;
  }

  if (args['describe'] || args['check-config']) {
    console.log(JSON.stringify(describeTtsConfig(ttsCfg), null, 2));
    return 0;
  }

  const text = readText(args).trim();
  if (!text) {
    console.error('[tts] 没有要念的文字：用 --text "..." / --file 路径 / 管道喂进来');
    return 1;
  }

  const outDir = path.resolve(args.dir || path.dirname(path.resolve(args.out || 'audio/out.mp3')));
  fs.mkdirSync(outDir, { recursive: true });

  const result = await synthesize({
    text,
    dir: outDir,
    voiceName: args.voice || process.env.TTS_VOICE || '',
    engine: args.engine || process.env.TTS_ENGINE || undefined,
    maxChars: Number(args['max-chars'] || 2000),
    timeoutMs: Number(args.timeout || 60000),
    ttsCfg
  });

  if (!result.ok) { console.error(`[tts] 合成失败：${result.error}`); return 1; }

  let finalPath = result.path;
  if (args.out) {
    finalPath = path.resolve(args.out);
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    fs.copyFileSync(result.path, finalPath);
    if (!args.keep) fs.rmSync(result.path, { force: true });
  }

  console.log(JSON.stringify({
    ok: true,
    engine: result.engine,
    voice: result.voice,
    bytes: result.bytes,
    path: finalPath
  }, null, 2));
  return 0;
}

main().then(code => process.exit(code)).catch(error => {
  console.error('[tts] 出错了：', error);
  process.exit(1);
});
