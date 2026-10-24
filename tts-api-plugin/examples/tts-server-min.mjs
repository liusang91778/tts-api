#!/usr/bin/env node
/**
 * 参考实现：一个「文字 → 语音」HTTP 服务（零依赖，只用来验证协议）。
 *
 *   node examples/tts-server-min.mjs --port 8899
 *   node examples/tts-server-min.mjs --port 8899 --engine sapi   # Windows 本地离线合成（真的出声）
 *   node examples/tts-server-min.mjs --port 8899 --mode json     # 返回 {"audio":"<base64>"} 而不是音频字节
 *
 * 默认 `--engine silence`：不看文字，返回一段 **0.8 秒静音 WAV**。
 * 它存在的意义只有一个——让你先把「请求进来 / 音频回去 / 字节数够」这条链路跑通，
 * 再去接真正的引擎。真引擎就是把 buildAudio() 换成你自己的合成调用。
 *
 * 协议见 docs/TTS-API-CONTRACT.md（方向 A）。
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const argOf = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return def;
};
const PORT = Number(argOf('port', 8899));
const HOST = argOf('host', '127.0.0.1');
const ENGINE = argOf('engine', 'silence');           // silence | sapi
const MODE = argOf('mode', 'audio');                 // audio | json
const PATH_TTS = argOf('path', '/tts');
const MAX_TEXT = Number(argOf('maxText', 500));

/** 生成一段静音 WAV（16 kHz / 单声道 / 16 bit）。 */
function silenceWav(seconds = 0.8, sampleRate = 16000) {
  const samples = Math.max(1, Math.round(seconds * sampleRate));
  const dataSize = samples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);            // PCM
  buf.writeUInt16LE(1, 22);            // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;                          // 后半段全是 0 = 静音
}

/** 用 Windows 自带 SAPI 合成（离线、真的出声）。 */
function sapiWav(text) {
  return new Promise((resolve, reject) => {
    const tmpDir = os.tmpdir();
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const out = path.join(tmpDir, `tts-ref-${stamp}.wav`);
    const txt = path.join(tmpDir, `tts-ref-${stamp}.txt`);
    fs.writeFileSync(txt, text, 'utf8');
    const q = (s) => String(s).replace(/'/g, "''");
    const script = [
      'Add-Type -AssemblyName System.Speech;',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
      '$v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like "zh-*" -and $_.Enabled } | Select-Object -First 1;',
      'if ($v) { $s.SelectVoice($v.VoiceInfo.Name) };',
      `$s.SetOutputToWaveFile('${q(out)}');`,
      `$s.Speak([IO.File]::ReadAllText('${q(txt)}'));`,
      '$s.Dispose()'
    ].join(' ');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      try { fs.unlinkSync(txt); } catch {}
      if (code !== 0) return reject(new Error(`sapi 失败（exit ${code}）：${err.trim().slice(-300)}`));
      try { resolve(fs.readFileSync(out)); } catch (e) { reject(e); } finally { try { fs.unlinkSync(out); } catch {} }
    });
  });
}

async function buildAudio(text) {
  if (ENGINE === 'sapi') return { audio: await sapiWav(text), mime: 'audio/wav', ext: 'wav' };
  // silence：不合成，只保证「是一段合法音频且 > 1024 字节」
  return { audio: silenceWav(0.8), mime: 'audio/wav', ext: 'wav' };
}

function readJsonBody(req, limit = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error(`请求体超过 ${limit} 字节`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, engine: ENGINE, mode: MODE, path: PATH_TTS, maxText: MAX_TEXT }));
    return;
  }
  if (url.pathname !== PATH_TTS) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `没有这个路径：${url.pathname}（我提供 ${PATH_TTS}）` } }));
    return;
  }

  let payload = {};
  try {
    if (req.method === 'GET') {
      payload = Object.fromEntries(url.searchParams.entries());
    } else {
      const raw = await readJsonBody(req);
      payload = raw.trim() ? JSON.parse(raw) : {};
    }
  } catch (error) {
    log(`400 解析失败: ${error.message}`);
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `请求体解析失败：${error.message}` } }));
    return;
  }

  const text = String(payload.text ?? payload.input ?? '').trim();
  const voice = String(payload.voice ?? payload.speaker ?? '');
  const format = String(payload.format ?? payload.audio_format ?? 'wav');
  log(`收到: text=${JSON.stringify(text.slice(0, 40))}${text.length > 40 ? '…' : ''} (${text.length} 字) voice=${JSON.stringify(voice.slice(0, 40))}${voice.length > 40 ? `…(${voice.length} 字符, 像是 base64 样本)` : ''} format=${format} auth=${req.headers.authorization ? 'Bearer ***' : '(无)'}`);

  if (!text) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: '缺少 text' } }));
    return;
  }
  if (text.length > MAX_TEXT) {
    res.writeHead(413, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `text 太长（${text.length} > ${MAX_TEXT}）` } }));
    return;
  }

  try {
    const { audio, mime } = await buildAudio(text);
    if (MODE === 'json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, audio: audio.toString('base64'), format: 'wav', bytes: audio.length }));
    } else {
      res.writeHead(200, { 'content-type': mime, 'content-length': audio.length });
      res.end(audio);
    }
    log(`200 返回 ${audio.length} 字节 (${MODE})`);
  } catch (error) {
    log(`500 ${error.message}`);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: error.message } }));
  }
});

server.listen(PORT, HOST, () => {
  log(`TTS 参考服务已启动: http://${HOST}:${PORT}${PATH_TTS}  engine=${ENGINE} mode=${MODE}`);
  log(`自检: node examples/tts-check.mjs http://${HOST}:${PORT}${PATH_TTS}${MODE === 'json' ? ' --json' : ''}`);
});
