# 配置说明

配置文件默认是项目根目录的 `tts.config.json`（`tts.config.example.json` 是模板）。
CLI 用 `--config` 指定，服务端用 `--config` 指定；也可以用环境变量 / 命令行参数覆盖（见 `node src/cli.mjs --help`）。

## 顶层

```json
{
  "provider": "auto",
  "fallback": true,
  "custom": { }
}
```

| 字段 | 取值 | 说明 |
|---|---|---|
| `provider` | `auto` / `custom` / `edge` / `sapi` | `auto` = custom 配好了就先走它，失败按 `fallback` 退 edge，再退 sapi |
| `fallback` | true / false | 自定义接口失败时要不要自动降级。**调试自定义接口时建议临时设 false**，否则会静默降级到 edge，你以为成功了其实没走到你的接口 |
| `custom` | 对象 | 自定义 HTTP 接口的全部参数，见下 |

## `custom` 字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `url` | — | 接口地址，必须 `http(s)://` 开头 |
| `method` | `POST` | `GET` 时把 `{要念的话}` 等塞进 query（有些老服务这么设计） |
| `apiKey` | 空 | 密钥。**只用于 `{密钥}` 占位符**，程序不会自己加 `Authorization` |
| `headersText` | 出厂模板 | 请求头模块：一段 JSON 文本，值里可以有占位符 |
| `bodyText` | 出厂模板 | 请求体模块：一段文本（通常是 JSON），原样发送，只替换占位符 |
| `format` | `mp3` | 期望的容器格式，填进 `{格式}`；也决定落盘扩展名 |
| `voice` | 空 | 音色 id，填进 `{音色}` |
| `model` | 空 | 模型 id，填进 `{模型}` |
| `voiceMode` | `id` | `id` = 用音色名；`file` = 用克隆样本（`{音色样本}` 拿到 `data:` URL） |
| `voiceFile` | 空 | 克隆样本路径（语音库目录内的相对路径，如 `voice-samples/me.mp3`） |
| `responseType` | `auto` | `auto` 按响应的 `Content-Type` 判断；也可强制 `audio` / `json` |
| `responsePath` | 空 | 仅 `responseType=json` 时需要：从 JSON 里取音频的路径，如 `choices.0.message.audio.data` |
| `responseEncoding` | `base64` | JSON 场景下音频是 base64 还是 URL |
| `timeoutMs` | `60000` | 单次请求超时 |

`describeTtsConfig()` / `node src/cli.mjs --describe` 会告诉你哪些字段还没配（`missing` 数组），
并且**永远不回显 apiKey**（只给 `hasApiKey`）。

## 占位符

请求头与请求体里只有这六个位置会被替换，其余字节原样发出：

| 占位符 | 替换成 | 英文别名 |
|---|---|---|
| `{要念的话}` | 本次文字 | `{text}` |
| `{音色}` | `custom.voice` | `{voice}` |
| `{音色样本}` | 克隆样本的 `data:audio/...;base64,…` | `{sample}` |
| `{模型}` | `custom.model` | `{model}` |
| `{格式}` | `custom.format` | `{format}` |
| `{密钥}` | `custom.apiKey` | `{apiKey}` |

长串优先：`{音色样本}` 不会被 `{音色}` 截成「…样本」。

## 出厂模板

`node src/cli.mjs --print-defaults` 可打印。等价于：

```json
// headersText
{
  "api-key": "{密钥}",
  "Content-Type": "application/json"
}
```

```json
// bodyText
{
  "model": "{模型}",
  "messages": [
    { "role": "user", "content": "请用自然口语把下面这段话读出来。" },
    { "role": "assistant", "content": "{要念的话}" }
  ],
  "audio": { "format": "{格式}", "voice": "{音色}" }
}
```

## 三种音色形态

1. **内置音色**（多数云服务）：`voiceMode=id`，`voice` 填接口那边的音色名，body 里留 `audio.voice = "{音色}"`。
2. **声音克隆**：`voiceMode=file` + `voiceFile=voice-samples/me.mp3`。
   - 样本要求：**10 秒左右、单人、无背景音乐**，1 KB ~ 10 MB，mp3/wav/ogg/m4a/aac/flac/opus/amr/silk。
   - 位置限定：只能是语音库目录内的相对路径（`..`、绝对路径、`http(s)://`、`data:`、`base64://` 一律拒绝，且拒绝时不发任何网络请求）。
   - 塞进请求体的是 `data:` URL（`data:audio/mpeg;base64,…`）——**多数克隆接口只认这个，裸 base64 会 400**。
   - 返回值里音色显示成 `克隆样本:<文件名>`，不回显 base64。
3. **语言描述音色**（voice design）：音色写进 body 的 `messages[user]` 描述里，此时**不要再传 `audio.voice`**
   —— 不少接口会回 `audio.voice is not supported for voice design model`。

## 四种常见接口怎么填

### A. OpenAI 兼容（`/v1/audio/speech`，直接回音频字节）

```json
{
  "provider": "custom",
  "custom": {
    "url": "https://api.openai.com/v1/audio/speech",
    "apiKey": "sk-…",
    "headersText": "{ \"Authorization\": \"Bearer {密钥}\", \"Content-Type\": \"application/json\" }",
    "bodyText": "{ \"model\": \"{模型}\", \"voice\": \"{音色}\", \"input\": \"{要念的话}\", \"response_format\": \"{格式}\" }",
    "format": "mp3",
    "voice": "alloy",
    "model": "tts-1",
    "responseType": "auto"
  }
}
```

### B. 返回 JSON + base64

```json
{
  "custom": {
    "url": "https://vendor.example.com/v1/tts",
    "headersText": "{ \"api-key\": \"{密钥}\" }",
    "bodyText": "{ \"text\": \"{要念的话}\", \"voice\": \"{音色}\", \"format\": \"{格式}\" }",
    "responseType": "json",
    "responsePath": "data.audio",
    "responseEncoding": "base64"
  }
}
```

### B2. 小米 MiMo（`mimo-v2.5-tts`，复用 chat/completions 出音频）

```json
{
  "custom": {
    "url": "https://api.xiaomimimo.com/v1/chat/completions",
    "headersText": "{ \"api-key\": \"{密钥}\", \"Content-Type\": \"application/json\" }",
    "bodyText": "{ \"model\": \"{模型}\", \"messages\": [ { \"role\": \"user\", \"content\": \"请用自然口语把下面这段话读出来。\" }, { \"role\": \"assistant\", \"content\": \"{要念的话}\" } ], \"audio\": { \"format\": \"{格式}\", \"voice\": \"{音色}\" } }",
    "model": "mimo-v2.5-tts",
    "voice": "冰糖",
    "format": "mp3",
    "responseType": "auto"
  }
}
```

- 音色可选：`mimo_default` / `冰糖` / `茉莉` / `苏打` / `白桦` / `Mia` / `Chloe` / `Milo` / `Dean`（仅 `mimo-v2.5-tts`）。
- 模型：`mimo-v2.5-tts`（内置音色）、`mimo-v2.5-tts-voiceclone`（克隆）、`mimo-v2.5-tts-voicedesign`（语言描述）。
- 响应是 `choices[0].message.audio.data` 的 base64 —— `responseType: auto` 会自动找到。
- 模型列表：`GET https://api.xiaomimimo.com/v1/models`（`api-key` 头）。

### C. 返回 JSON + 音频 URL

```json
{
  "custom": {
    "responseType": "json",
    "responsePath": "data.audio_url",
    "responseEncoding": "url"
  }
}
```

### D. 自建本地服务（GPT-SoVITS / Fish / CosyVoice 的 HTTP 包装）

```json
{
  "custom": {
    "url": "http://127.0.0.1:9880/tts",
    "apiKey": "",
    "headersText": "{ \"Content-Type\": \"application/json\" }",
    "bodyText": "{ \"text\": \"{要念的话}\", \"text_lang\": \"zh\", \"ref_audio_path\": \"ref.wav\" }",
    "responseType": "audio",
    "format": "wav"
  }
}
```

本地服务通常不要鉴权，`headersText` 只留 `Content-Type` 就行。

## 验证顺序（建议照这个来）

```bash
node src/cli.mjs --describe            # 1) 配全了吗、缺什么
node src/cli.mjs --list-models         # 2) 密钥通不通（读得到模型就说明地址+鉴权没问题）
node src/cli.mjs --text "测试" --out t.mp3   # 3) 真合成一条
```

第 3 步一直失败时，把 `fallback` 设成 `false` 再跑一次 —— 这样能看到自定义接口的真实报错，
而不是「降级到 edge 成功了」。

## 硬约束（实现层面，改配置绕不过去）

1. 请求头只替换占位符，**不自动补 `Content-Type` / `Authorization`**（要就自己写进 `headersText`）。
2. 请求体原样发送：不 `JSON.parse`、不重排字段、不补前缀后缀。所以模板写成一行还是多行都可以。
3. 返回值小于 **1024 字节判失败** —— 有些接口出错时回一段 HTML/JSON，长度够短，不拦就会当成音频落盘。
4. 响应形态三种（音频字节 / JSON+base64 / JSON+URL）自动识别，靠 `Content-Type` 与内置的取值路径表。
5. `apiKey` 永不出现在任何响应、日志里；克隆样本的 base64 也不回显。
6. 失败一定带原因：非 2xx 会带上响应体前 300 字符，超时会说超时多少毫秒。

## 实测记录（2026-10，Windows 11 + Node 24）

- MiMo `mimo-v2.5-tts` + `冰糖`：一条 10 字中文 → mp3 20 KB 左右，耗时 1–3 秒。
- `responseType: auto` 对 MiMo 的 base64 响应能直接识别，无需配置 `responsePath`。
- 克隆模式首次报 `audio.voice must not be empty for voice clone model`，把 body 里 `audio.voice` 写成 `{音色样本}` 后通过；
  再报 `audio.voice must be a DataURL for voice clone model`，把样本改成 `data:` URL 后通过。
- edge 引擎需要 `python -m pip install edge-tts`；本机没装 ffmpeg 也能发（网关侧会转码），
  只是拿不到时长（`seconds: null`）。
