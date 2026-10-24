#!/usr/bin/env node
/**
 * 一键安装：把 TTS 能力挂进一个**已经装好 qq-bridge** 的环境。
 *
 *   node install.mjs                 # 自动找桥接、自动找 DSH profile，装完自检
 *   node install.mjs --dry-run       # 只看它打算做什么，不动任何文件
 *   node install.mjs --bridge D:\qq-bridge --profile desktop
 *   node install.mjs --uninstall     # 反向拆除（config.json 里的配置保留）
 *
 * 它会做五件事，每件都可重复执行（幂等）：
 *   1. 把 src/tts.mjs、src/models.mjs、src/mcp-tts.js 复制进 <bridge>/src/
 *   2. 合并 config.json 的默认项（只补缺的，不覆盖你已经写过的值）
 *   3. 在 DSH profile 的 cordis.patch.yml 里维护一段 MCP 注册块
 *   4. 在 qq-bridge 的 preset 工具白名单里加 mcp__tts__ 前缀（有那个文件才加）
 *   5. 跑一次 mcp-tts.js --selftest，把结果打出来
 * 改动的文件都会先备份成 *.bak-<时间戳>。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const BLOCK_BEGIN = '# === tts-plugin MCP BEGIN ===';
const BLOCK_END = '# === tts-plugin MCP END ===';
const MCP_ID = 'mcp-tts';
const SERVER_NAME = 'tts';
const SAFE_PREFIX = 'mcp__tts__';

function parseArgv(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) { out._.push(t); continue; }
    const k = t.slice(2);
    const n = argv[i + 1];
    if (n === undefined || n.startsWith('--')) out[k] = true;
    else { out[k] = n; i++; }
  }
  return out;
}

const args = parseArgv(process.argv.slice(2));
const DRY = !!args['dry-run'];
const UNINSTALL = !!args.uninstall;
const log = (...m) => console.log(...m);
const step = (n, s) => log(`\n[${n}] ${s}`);
const warn = (...m) => console.log('   ⚠️ ', ...m);
const info = (...m) => console.log('   ', ...m);

/** 备份原文件（只备份一次：已有同内容的 .bak-* 就跳过）。 */
function backup(file) {
  if (DRY || !fs.existsSync(file)) return '';
  const target = `${file}.bak-${STAMP}`;
  if (fs.existsSync(target)) return target;
  fs.copyFileSync(file, target);
  return target;
}

/* ── 1. 找 qq-bridge ─────────────────────────────────────────────────────── */
function looksLikeBridge(dir) {
  try {
    if (!fs.existsSync(path.join(dir, 'src', 'bridge.js'))) return false;
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
    return /qq-bridge/i.test(pkg.name || '') || fs.existsSync(path.join(dir, 'src', 'mcp-snowluma-safe.js'));
  } catch { return false; }
}

function resolveBridge() {
  const candidates = [];
  if (args.bridge) candidates.push(path.resolve(String(args.bridge)));
  if (process.env.QQ_BRIDGE_DIR) candidates.push(path.resolve(process.env.QQ_BRIDGE_DIR));
  if (args._[0]) candidates.push(path.resolve(String(args._[0])));
  const cwd = process.cwd();
  candidates.push(cwd, path.join(cwd, 'qq-bridge'), path.resolve(cwd, '..', 'qq-bridge'), path.resolve(cwd, '..'));
  const home = os.homedir();
  for (const name of ['qq-bridge', 'Desktop/qq-bridge', 'Documents/qq-bridge', 'projects/qq-bridge']) {
    candidates.push(path.join(home, name));
  }
  for (const drive of ['C:', 'D:', 'E:', 'F:']) {
    candidates.push(`${drive}\\qq-bridge`, `${drive}\\code\\qq-bridge`, `${drive}\\projects\\qq-bridge`);
  }
  const seen = new Set();
  for (const c of candidates) {
    const abs = path.resolve(c);
    if (seen.has(abs)) continue;
    seen.add(abs);
    if (looksLikeBridge(abs)) return abs;
  }
  // 常见位置都没有 → 在盘根往下浅扫一层（限深度、跳过系统目录与 node_modules），
  // 这样「解压到 D:\某目录\qq-bridge 然后在这里跑安装器」也能自己找到。
  for (const abs of scanForBridge()) {
    if (seen.has(abs)) continue;
    seen.add(abs);
    if (looksLikeBridge(abs)) return abs;
  }
  return '';
}

function scanForBridge() {
  const found = [];
  const SKIP = /^(windows|program files|program files \(x86\)|programdata|node_modules|appdata|\$recycle\.bin|system volume information|\.git)$/i;
  let budget = 4000;
  for (const drive of ['C:', 'D:', 'E:', 'F:']) {
    let tops = [];
    try { tops = fs.readdirSync(drive + '\\', { withFileTypes: true }).filter(d => d.isDirectory() && !SKIP.test(d.name)); } catch { continue; }
    for (const top of tops) {
      const depth1 = drive + '\\' + top.name;
      if (--budget < 0) return found;
      if (looksLikeBridge(depth1)) { found.push(depth1); continue; }
      let subs = [];
      try { subs = fs.readdirSync(depth1, { withFileTypes: true }).filter(d => d.isDirectory() && !SKIP.test(d.name)); } catch { continue; }
      for (const sub of subs) {
        if (--budget < 0) return found;
        const depth2 = depth1 + '\\' + sub.name;
        if (looksLikeBridge(depth2)) found.push(depth2);
      }
    }
  }
  return found;
}

/* ── 2. 找 DSH profile ───────────────────────────────────────────────────── */
function resolveProfile() {
  const dshHome = process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(os.homedir(), '.dsh');
  const profilesDir = path.join(dshHome, 'profiles');
  if (!fs.existsSync(profilesDir)) return { dshHome, profile: '', patchFile: '' };
  const wanted = args.profile ? String(args.profile) : '';
  const names = fs.readdirSync(profilesDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  const order = wanted ? [wanted] : ['desktop', 'web', ...names];
  for (const name of order) {
    const patchFile = path.join(profilesDir, name, 'cordis.patch.yml');
    if (fs.existsSync(patchFile)) return { dshHome, profile: name, patchFile };
  }
  return { dshHome, profile: '', patchFile: '' };
}

/* ── 3. 维护 cordis.patch.yml 里的 MCP 块 ─────────────────────────────────── */
function mcpBlock(bridgeDir) {
  const nodePath = process.execPath;
  const script = path.join(bridgeDir, 'src', 'mcp-tts.js');
  return [
    BLOCK_BEGIN,
    '# 由 tts-api-plugin 的 install.mjs 维护；这段区块会被整体替换，请勿手工编辑内部条目。',
    '- insert:',
    `    - id: ${MCP_ID}`,
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    `        serverName: ${SERVER_NAME}`,
    '        transport: stdio',
    `        command: '${nodePath.replace(/\\/g, '\\\\')}'`,
    '        args:',
    `          - '${script.replace(/\\/g, '\\\\')}'`,
    '        toolCallTimeoutMs: 300000',
    BLOCK_END
  ].join('\n');
}

function upsertBlock(text, block) {
  const re = new RegExp(`${escapeRe(BLOCK_BEGIN)}[\\s\\S]*?${escapeRe(BLOCK_END)}`);
  if (re.test(text)) return text.replace(re, block);
  const trimmed = text.replace(/\s+$/, '');
  return `${trimmed}\n\n${block}\n`;
}

function removeBlock(text) {
  const re = new RegExp(`\\n*${escapeRe(BLOCK_BEGIN)}[\\s\\S]*?${escapeRe(BLOCK_END)}\\n*`);
  return text.replace(re, '\n');
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ── 4. config.json 默认项 ───────────────────────────────────────────────── */
function defaultTts() {
  return {
    provider: 'auto',
    fallback: true,
    custom: {
      url: '',
      method: 'POST',
      apiKey: '',
      headersText: JSON.stringify({ 'api-key': '{密钥}', 'Content-Type': 'application/json' }, null, 2),
      bodyText: JSON.stringify({
        model: '{模型}',
        messages: [
          { role: 'user', content: '请用自然口语把下面这段话读出来。' },
          { role: 'assistant', content: '{要念的话}' }
        ],
        audio: { format: '{格式}', voice: '{音色}' }
      }, null, 2),
      format: 'mp3',
      voice: '',
      model: '',
      voiceMode: 'id',
      voiceFile: '',
      responseType: 'auto',
      responsePath: '',
      responseEncoding: 'base64',
      timeoutMs: 60000
    }
  };
}

/** 深合并：只补缺失字段，绝不覆盖已有值（你配过的 url/key 不会被清掉）。 */
function fillMissing(target, defaults) {
  let changed = false;
  for (const [k, v] of Object.entries(defaults)) {
    if (target[k] === undefined || target[k] === null || target[k] === '') {
      if (typeof v === 'object' && !Array.isArray(v) && v !== null) {
        target[k] = {};
        if (fillMissing(target[k], v)) changed = true;
      } else {
        target[k] = v;
        changed = true;
      }
    } else if (typeof v === 'object' && v !== null && !Array.isArray(v) && typeof target[k] === 'object') {
      if (fillMissing(target[k], v)) changed = true;
    }
  }
  return changed;
}

/* ── 主流程 ─────────────────────────────────────────────────────────────── */
function main() {
  log('tts-api-plugin 安装器' + (DRY ? '（dry-run：不会改任何文件）' : '') + (UNINSTALL ? '（卸载）' : ''));

  step(1, '定位 qq-bridge');
  const bridge = resolveBridge();
  if (!bridge) {
    console.error('\n❌ 没找到 qq-bridge。请用 --bridge <目录> 指定，或设环境变量 QQ_BRIDGE_DIR。');
    console.error('   判断依据：目录里有 src/bridge.js 和 package.json。');
    process.exit(1);
  }
  info(`桥接目录：${bridge}`);

  step(2, '定位 DSH profile');
  const { dshHome, profile, patchFile } = resolveProfile();
  if (!patchFile) {
    warn(`没在 ${dshHome}\\profiles 下找到带 cordis.patch.yml 的 profile；MCP 注册会跳过。`);
    warn('装好 DSH 后重跑一次，或用 --profile <名字> 指定。');
  } else {
    info(`profile：${profile}`);
    info(`补丁文件：${patchFile}`);
  }

  const srcTargets = [
    { from: path.join(HERE, 'src', 'tts.mjs'), to: path.join(bridge, 'src', 'tts.mjs') },
    { from: path.join(HERE, 'src', 'models.mjs'), to: path.join(bridge, 'src', 'models.mjs') },
    { from: path.join(HERE, 'src', 'mcp-tts.js'), to: path.join(bridge, 'src', 'mcp-tts.js') }
  ];

  if (UNINSTALL) return uninstall({ bridge, patchFile, srcTargets });

  step(3, '复制引擎与 MCP server');
  for (const { from, to } of srcTargets) {
    if (!fs.existsSync(from)) { warn(`源文件缺失，跳过：${from}`); continue; }
    const same = fs.existsSync(to) && fs.readFileSync(from).equals(fs.readFileSync(to));
    if (same) { info(`已是最新：${path.relative(bridge, to)}`); continue; }
    if (fs.existsSync(to)) { const b = backup(to); info(`备份 ${path.relative(bridge, to)} → ${path.basename(b)}`); }
    if (!DRY) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); }
    info(`${DRY ? '将复制' : '已复制'} ${path.relative(bridge, to)}`);
  }

  step(4, '确保桥接依赖里有 MCP SDK');
  const sdkDir = path.join(bridge, 'node_modules', '@modelcontextprotocol', 'sdk');
  if (!fs.existsSync(sdkDir)) {
    warn('桥接里没有 @modelcontextprotocol/sdk —— MCP server 起不来。');
    warn(`在 ${bridge} 里跑一次 npm install 再重新执行本脚本。`);
  } else {
    info('已找到 @modelcontextprotocol/sdk');
  }

  step(5, '合并 config.json 默认项');
  const cfgFile = path.join(bridge, 'config.json');
  if (!fs.existsSync(cfgFile)) {
    warn('桥接还没有 config.json（先从 config.example.json 复制一份再装）。');
  } else {
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8').replace(/^\uFEFF/, ''));
    cfg.socialV2 = cfg.socialV2 || {};
    cfg.socialV2.voice = cfg.socialV2.voice || {};
    const before = JSON.stringify(cfg.socialV2.voice);
    const firstInstall = !cfg.socialV2.voice.tts || !Object.keys(cfg.socialV2.voice.tts).length;
    // 语音通道总开关 + 发送工具：第一次装就顺手打开；已经配过 tts 就尊重你现在的开关
    if (cfg.socialV2.voice.enabled === undefined) cfg.socialV2.voice.enabled = true;
    cfg.socialV2.tools = cfg.socialV2.tools || {};
    if (cfg.socialV2.tools.sendVoice === undefined) cfg.socialV2.tools.sendVoice = true;
    if (firstInstall) {
      if (cfg.socialV2.voice.enabled !== true) { cfg.socialV2.voice.enabled = true; info('首次安装：把 socialV2.voice.enabled 打开了'); }
      if (cfg.socialV2.tools.sendVoice !== true) { cfg.socialV2.tools.sendVoice = true; info('首次安装：把工具 sendVoice 打开了（否则发不出语音）'); }
    }
    if (cfg.socialV2.voice.ttsMaxChars === undefined) cfg.socialV2.voice.ttsMaxChars = 200;
    cfg.socialV2.voice.tts = cfg.socialV2.voice.tts || {};
    fillMissing(cfg.socialV2.voice.tts, defaultTts());
    const after = JSON.stringify(cfg.socialV2.voice);
    if (before === after) info('配置已是最新，不动它');
    else {
      const b = backup(cfgFile);
      if (b) info(`备份 config.json → ${path.basename(b)}`);
      if (!DRY) fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
      info(`${DRY ? '将写入' : '已写入'} socialV2.voice.tts 默认项（已有的值不改）`);
      const url = cfg.socialV2.voice.tts.custom && cfg.socialV2.voice.tts.custom.url;
      if (!url) info('接口地址还是空的 —— 装完用 tts_configure 或改 config.json 填 url + apiKey');
    }
    if (!DRY) {
      const voiceDir = path.resolve(bridge, cfg.socialV2.voice.dir || 'audio');
      fs.mkdirSync(voiceDir, { recursive: true });
      info(`语音库目录：${voiceDir}`);
    }
  }

  step(6, '注册 MCP 到 DSH profile');
  if (patchFile) {
    const text = fs.readFileSync(patchFile, 'utf8');
    const next = upsertBlock(text, mcpBlock(bridge));
    if (next === text) info('已经注册过，跳过');
    else {
      const b = backup(patchFile);
      if (b) info(`备份 cordis.patch.yml → ${path.basename(b)}`);
      if (!DRY) fs.writeFileSync(patchFile, next, 'utf8');
      info(`${DRY ? '将写入' : '已写入'} MCP 块（serverName=${SERVER_NAME}）`);
    }
  }

  step(7, '放行工具前缀（QQ preset 白名单）');
  const restrictFile = path.join(bridge, 'plugins', 'qq-agent-presets', 'qq-tool-restrict.mjs');
  if (!fs.existsSync(restrictFile)) {
    info('没有 qq-tool-restrict.mjs（不是 qq-bridge 的 preset 结构？）——跳过');
  } else {
    const text = fs.readFileSync(restrictFile, 'utf8');
    if (text.includes(`'${SAFE_PREFIX}'`)) info(`白名单里已有 ${SAFE_PREFIX}`);
    else {
      // 注意：真实仓库里这个数组可能写成 `]` 换行（没有 `];` 同行），也可能带注释，
      // 所以这里只认到第一个 `]`，不要求后面紧跟分号。
      const m = /SAFE_PREFIXES\s*=\s*\[([\s\S]*?)\]/.exec(text);
      if (!m) warn('找不到 SAFE_PREFIXES 数组，请手动加 ' + SAFE_PREFIX);
      else {
        const b = backup(restrictFile);
        if (b) info(`备份 qq-tool-restrict.mjs → ${path.basename(b)}`);
        const body = m[1].replace(/\s+$/, '');
        const replacement = `SAFE_PREFIXES = [${body}\n  '${SAFE_PREFIX}',\n]`;
        const nextText = text.slice(0, m.index) + replacement + text.slice(m.index + m[0].length);
        if (!DRY) fs.writeFileSync(restrictFile, nextText, 'utf8');
        info(`${DRY ? '将加入' : '已加入'} '${SAFE_PREFIX}'`);
      }
    }
  }

  step(8, '自检（直接跑 MCP server 的 --selftest）');
  const mcpFile = path.join(bridge, 'src', 'mcp-tts.js');
  if (!fs.existsSync(mcpFile)) {
    warn('mcp-tts.js 还没就位，跳过自检');
  } else {
    const r = spawnSync(process.execPath, [mcpFile, '--selftest'], { cwd: bridge, encoding: 'utf8', timeout: 30000 });
    if (r.status !== 0) {
      warn('自检失败：' + (r.stderr || r.stdout || r.error || '').toString().slice(0, 500));
    } else {
      log(r.stdout.trim());
    }
  }

  step(9, '下一步');
  if (patchFile) {
    info('重启 DSH —— MCP 只在 DSH 启动时拉起（重启前 QQ 侧看不到 tts_* 工具）。');
  }
  info('重启桥接 —— 改了 config.json 才需要（语音库目录 / 开关生效）。');
  info('然后在控制台或让 AI 调 tts_configure 填 url + apiKey，再 tts_status 看是否就绪。');
  log('\n完成。');
}

function uninstall({ bridge, patchFile, srcTargets }) {
  step(3, '移除复制进去的文件');
  for (const { to } of srcTargets) {
    if (!fs.existsSync(to)) { info(`不存在，跳过：${path.relative(bridge, to)}`); continue; }
    // 只在内容与插件自带的一致时才删，避免误删宿主自己的同名文件
    const src = srcTargets.find(t => t.to === to).from;
    const same = fs.existsSync(src) && fs.readFileSync(src).equals(fs.readFileSync(to));
    if (!same) { warn(`内容已被改过，保留：${path.relative(bridge, to)}`); continue; }
    // 桥接自己 import 了 tts.mjs（被二次开发过的桥接会这样）→ 删了下次启动就崩，必须留下
    if (path.basename(to) === 'tts.mjs') {
      const bridgeJs = path.join(bridge, 'src', 'bridge.js');
      let depends = false;
      try { depends = /from\s+['"]\.\/tts\.mjs['"]/.test(fs.readFileSync(bridgeJs, 'utf8')); } catch {}
      if (depends) { warn('桥接的 bridge.js 直接 import 了 ./tts.mjs，保留这个文件（删了桥接会启动失败）'); continue; }
    }
    if (DRY) info(`将删除 ${path.relative(bridge, to)}`);
    else { fs.rmSync(to, { force: true }); info(`已删除 ${path.relative(bridge, to)}`); }
  }

  step(4, '移除 DSH 的 MCP 注册块');
  if (patchFile && fs.existsSync(patchFile)) {
    const text = fs.readFileSync(patchFile, 'utf8');
    const next = removeBlock(text);
    if (next === text) info('没有注册块');
    else {
      const b = backup(patchFile);
      if (b) info(`备份 cordis.patch.yml → ${path.basename(b)}`);
      if (!DRY) fs.writeFileSync(patchFile, next, 'utf8');
      info('已移除 MCP 块');
    }
  }

  step(5, '移除工具白名单前缀');
  const restrictFile = path.join(bridge, 'plugins', 'qq-agent-presets', 'qq-tool-restrict.mjs');
  if (fs.existsSync(restrictFile)) {
    const text = fs.readFileSync(restrictFile, 'utf8');
    if (!text.includes(`'${SAFE_PREFIX}'`)) info(`没有 ${SAFE_PREFIX}`);
    else {
      const b = backup(restrictFile);
      if (b) info(`备份 → ${path.basename(b)}`);
      if (!DRY) fs.writeFileSync(restrictFile, text.replace(`\n  '${SAFE_PREFIX}',`, ''), 'utf8');
      info('已移除');
    }
  }
  info('config.json 里的 socialV2.voice.tts 配置保留（要清自己删）。');
  log('\n卸载完成；重启 DSH 生效。');
}

main();
