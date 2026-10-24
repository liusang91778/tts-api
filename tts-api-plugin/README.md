# tts-api-plugin

把一串文字变成一段语音 —— 一套零依赖的核心，配一个命令行和一个参考服务端。

设计上只有一条硬规矩：**请求头和请求体是你写的那两段文本，发出去就是那两段文本**。
程序只替换花括号里的中文占位符，不补 `Content-Type`、不补 `Authorization`、不重新 `JSON.stringify`、
不重排字段顺序。你写什么，对面收到什么。

---

## 它支持什么

| 引擎 | 说明 | 需要什么 |
|---|---|---|
| `custom` | 你自己接的任意 HTTP 接口（OpenAI 兼容、火山、MiniMax、本地 GPT-SoVITS / XTTS 都行） | 接口地址 + 密钥 + 请求头/请求体两段模板 |
| `edge` | 微软 Edge 在线语音（免密钥） | 本机有 `python` 且 `pip install edge-tts` |
| `sapi` | Windows 本机离线语音（`System.Speech`） | 仅 Windows |
| `auto` | 配好 `custom` 就先走它，失败按 `fallback` 退 `edge`，再退 `sapi` | — |

响应形态**自动识别**：直接给音频字节、JSON 里套 base64、JSON 里给 URL，三种都能吃；
返回小于 1 KB 一律判失败（防止把错误页当音频）。

## 三条能力线

- **内置音色**：接口自带音色表（如 `冰糖 / 茉莉 / 苏打 …`），传 `--voice 冰糖`。
- **声音克隆**：`--voice-mode file --voice-file voice-samples/me.mp3`，样本会以
  `data:audio/mpeg;base64,…` 塞进 `{音色样本}`（多数服务的硬要求，裸 base64 会被拒）。
- **语言描述音色**：把音色写成一句话放在请求体的 `messages[user]` 里（服务端叫 voice design 的那种），
  此时不要再传音色 id（有些接口传了会 400）。

## 网页配置界面（独立，不依赖 qq-bridge）

不想手改 JSON 就用自带的网页：

```bash
npm run web        # = node src/server.mjs --port 8899
# 浏览器打开 http://127.0.0.1:8899/
```

页面上能改：接口地址（带 MiMo / OpenAI 两个一键填充）、密钥、模型（**从接口实时读取**，`GET /v1/models`）、
音色、格式、超时、引擎与降级开关；**请求头**与**请求体**各是独立一块，可单独保存、可一键复原成出厂模板
（复原目标写死在代码里，保存改不到它）。底部「合成并试听」只在本机合成并播放，不发给任何人。

保存写入 `tts.config.json` 并立即生效，不用重启。密钥只写不读——`GET /config` 只回 `hasApiKey`。

同一份界面也通过 MCP 暴露给 AI：`tts_status` / `tts_speak` / `tts_models` / `tts_configure`，
所以「人点页面」和「AI 调工具」改的是同一份配置。


## 装进已有的 qq-bridge（一条命令）

如果你机器上已经装好了 [qq-bridge](https://github.com/Derpyu520/qq-bridge)，想让 QQ 里的 AI
用上这套 TTS：

```bash
node install.mjs
```

它自动找桥接、找 DSH profile、把 `src/tts.mjs` / `src/models.mjs` / `src/mcp-tts.js` 放进去、
合并 `config.json`（只补缺失，不覆盖你已有的值）、在 `cordis.patch.yml` 注册 MCP、把
`mcp__tts__` 加进 QQ 工具白名单，最后跑自检；改动前全部 `*.bak-<时间戳>` 备份。
装完重启 DSH 即可，AI 就有了 `tts_status` / `tts_speak` / `tts_models` / `tts_configure` 四个工具。

细节、参数、排错见 **[INSTALL.md](INSTALL.md)**。

```bash
node install.mjs --dry-run      # 只看计划
node install.mjs --uninstall    # 卸掉
```

## 快速上手

```bash
# 1) 配置
cp tts.config.example.json tts.config.json     # Windows: copy
#   编辑 tts.config.json：url / apiKey / model / voice

# 2) 合成一句话
node src/cli.mjs --text "你好，这是一段测试语音" --out hello.mp3

# 3) 看看这个接口有哪些模型
node src/cli.mjs --list-models

# 4) 看出厂模板（写请求头/请求体时可以对着改）
node src/cli.mjs --print-defaults
```

不写配置文件也能跑 —— 全部用环境变量或命令行参数给：

```bash
TTS_URL=https://api.example.com/v1/audio/speech \
TTS_KEY=sk-xxx \
node src/cli.mjs --text "hello" --out hello.mp3
```

## 当服务用

```bash
node src/server.mjs --port 8899 --config ./tts.config.json
curl -s -o out.mp3 -X POST http://127.0.0.1:8899/tts \
  -H "Content-Type: application/json" \
  -d '{"text":"你好","voice":"冰糖"}'
```

`server.mjs` 不落盘（合成完读完就删临时目录），适合挂在别人背后当「我的 TTS 网关」。
加鉴权：`--token my-secret`，之后请求要带 `Authorization: Bearer my-secret`。

## 当库用

```js
import { synthesize, describeTtsConfig } from './src/tts.mjs';

const cfg = { provider: 'custom', custom: { url, apiKey, headersText, bodyText, format: 'mp3', voice: '冰糖' } };
const r = await synthesize({ text: '你好', dir: './audio', voiceName: '冰糖', ttsCfg: cfg });
if (r.ok) console.log(r.path, r.bytes); else console.error(r.error);
```

导出清单见 `src/tts.mjs` 头部注释；`describeTtsConfig(cfg)` 会告诉你「配全了没、缺哪个字段」，
并且**永远不回显密钥**（只给 `hasApiKey`）。

## 文档

- [`docs/CONFIG.md`](docs/CONFIG.md) —— 配置字段逐个解释 + 四种可照抄的请求模板（OpenAI 兼容 / JSON+base64 / 小米 MiMo / 本地 GPT-SoVITS）+ 三种音色形态 + 实测记录
- [`docs/API-CONTRACT.md`](docs/API-CONTRACT.md) —— 双向契约：别人接你的语音（最小要求 / 三种响应形态 / 失败判据）、你接别人的语音（要准备哪四样）
- `examples/tts-server-min.mjs` —— 最简服务端（可只回静音 WAV，用来先跑通链路）
- `examples/tts-check.mjs` —— 契约自检：`node examples/tts-check.mjs http://127.0.0.1:8899/tts`

## 占位符

| 占位符 | 替换成 | 英文别名 |
|---|---|---|
| `{要念的话}` | 本次要念的文字 | `{text}` |
| `{音色}` | 音色 id / 名称 | `{voice}` |
| `{音色样本}` | 克隆样本的 `data:` URL | `{sample}` |
| `{模型}` | 模型 id | `{model}` |
| `{格式}` | mp3 / wav … | `{format}` |
| `{密钥}` | API 密钥 | `{apiKey}` |

长占位符优先匹配（`{音色样本}` 不会被 `{音色}` 抢先截断）。

## 环境要求

Node.js **≥ 22.13**（用到了内置 `fetch`）。`edge` 引擎额外需要 `python -m pip install edge-tts`；
`sapi` 只在 Windows 上有。

## License

MIT，见 [LICENSE](LICENSE)。
