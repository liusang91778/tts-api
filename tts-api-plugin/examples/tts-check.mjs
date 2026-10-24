#!/usr/bin/env node
/**
 * TTS 接口契约自检：把「桥接会怎么调你」原样打一遍，逐条 PASS/FAIL。
 *
 *   node examples/tts-check.mjs http://127.0.0.1:8899/tts
 *   node examples/tts-check.mjs http://127.0.0.1:8899/tts --json --path audio --encoding base64
 *   node examples/tts-check.mjs https://api.example.com/tts --key sk-xxx --voice mimo_default --format mp3
 *
 * 检查项（和桥接内部的判据一致，见 src/tts.mjs）：
 *   1. HTTP 200
 *   2. Content-Type 是音频（audio/*）—— 除非 --json
 *   3. 字节数 ≥ 1024（桥接把 <1024 的返回判为「多半不是音频」）
 *   4. 空 text 应被拒（不给 200）
 *   5. 超长 text 应被拒或正常处理（不 500）
 */
import fs from 'node:fs';

const argv = process.argv.slice(2);
const pos = argv.filter((a) => !a.startsWith('--'));
const url = pos[0] || 'http://127.0.0.1:8899/tts';
const has = (n) => argv.includes(`--${n}`);
const val = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const isJson = has('json');
const apiKey = val('key', '');
const voice = val('voice', 'mimo_default');
const format = val('format', 'wav');
const responsePath = val('path', 'audio');
const encoding = val('encoding', 'base64');
const text = val('text', '我想吃大白饭，今天特别想吃。');

const results = [];
const push = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

function pickPath(obj, dotted) {
  let cur = obj;
  for (const part of String(dotted).split('.')) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

async function call(body) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const mime = res.headers.get('content-type') || '';
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, mime, buf };
}

console.log(`\n目标: ${url}`);
console.log(`模式: ${isJson ? `json（取值 ${responsePath}，编码 ${encoding}）` : 'audio 字节'}\n`);

// ── 1~3：正常请求
try {
  const r = await call({ text, voice, format, model: '' });
  push('HTTP 200', r.status === 200, `实际 ${r.status}`);

  let audioBytes = r.buf.length;
  let audio = r.buf;
  if (isJson) {
    push('Content-Type 是 JSON', /json/i.test(r.mime), r.mime || '(空)');
    let parsed = null;
    try { parsed = JSON.parse(r.buf.toString('utf8')); } catch {}
    if (!parsed) {
      push(`响应能解析成 JSON`, false, `前 120 字：${r.buf.toString('utf8').slice(0, 120)}`);
    } else {
      const raw = pickPath(parsed, responsePath);
      push(`路径 ${responsePath} 有值`, typeof raw === 'string' && !!raw, `实际类型 ${typeof raw}`);
      if (typeof raw === 'string' && raw) {
        if (encoding === 'url') {
          const ar = await fetch(raw);
          audio = Buffer.from(await ar.arrayBuffer());
          audioBytes = audio.length;
          push('音频 URL 能下载', ar.status === 200, `HTTP ${ar.status}`);
        } else {
          audio = Buffer.from(raw, 'base64');
          audioBytes = audio.length;
        }
      }
    }
  } else {
    push('Content-Type 是音频', /^audio\//i.test(r.mime), r.mime || '(空)');
  }

  push('音频 ≥ 1024 字节', audioBytes >= 1024, `${audioBytes} 字节`);

  const out = `tts-check-out.${format}`;
  fs.writeFileSync(out, audio);
  const head = audio.subarray(0, 4).toString('hex');
  console.log(`   已存 ${out}（${audioBytes} 字节，前 4 字节 ${head}）  试听：start ${out}`);
} catch (error) {
  push('正常请求', false, error?.message ?? String(error));
}

// ── 4：空 text 应被拒
try {
  const r = await call({ text: '', voice, format });
  push('空 text 被拒（非 200）', r.status !== 200, `实际 ${r.status}`);
} catch (error) {
  push('空 text 被拒（非 200）', true, `连接层直接拒：${error?.message ?? error}`);
}

// ── 5：超长 text 不应 5xx
try {
  const r = await call({ text: '测'.repeat(2000), voice, format });
  push('超长 text 不炸（非 5xx）', r.status < 500, `实际 ${r.status}`);
} catch (error) {
  push('超长 text 不炸（非 5xx）', true, `连接层直接拒：${error?.message ?? error}`);
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${bad.length === 0 ? '🎉 契约通过' : `⚠️ ${bad.length} 项未通过`}（${results.length - bad.length}/${results.length}）`);
if (bad.length) {
  console.log('未通过：');
  for (const b of bad) console.log(`  · ${b.name} — ${b.detail}`);
  process.exitCode = 1;
}
