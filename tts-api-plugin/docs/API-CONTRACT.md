# 对接契约

两份契约：**别人接你的语音**（你当服务端）、**你接别人的语音**（你当客户端）。
两边都是「尽量少的要求 + 明确的失败判据」，照这个写接口，换一家服务只改配置不改代码。

---

## 方向 A：你实现服务端（本插件当客户端）

### A1. 最小契约（只要这三条就能跑通）

1. 接受 `POST`，请求体是 JSON。
2. 返回 **HTTP 200**，body 是音频字节，`Content-Type: audio/mpeg`（或 `audio/wav` 等）。
3. 音频长度 **> 1024 字节**。

够了。剩下的都是可选项。

### A2. 客户端会给你什么

```json
{
  "text": "要念的话",
  "voice": "音色 id 或名称",
  "format": "mp3",
  "model": "模型 id（如果你有多个）",
  "apiKey": "密钥（只在模板里引用，不会自动加头）"
}
```

但**实际发出去的字段由客户端的 `bodyText` 决定** —— 你写什么模板它就发什么，不会多。
所以如果你的服务需要特殊字段（`text_lang`、`ref_audio_path`、`speed`…），直接写进模板即可。

鉴权同理：客户端不会自动加 `Authorization`。要 Bearer 就写进 `headersText`：

```json
{ "Authorization": "Bearer {密钥}" }
```

### A3. 响应形态（三选一，客户端都能吃）

**形态 1：直接回音频字节**（最简单，推荐）

```
HTTP/1.1 200 OK
Content-Type: audio/mpeg

<binary>
```

**形态 2：JSON 里套 base64**

```json
{ "ok": true, "audio": "<base64>", "format": "mp3" }
```

客户端取 `responsePath`（如 `data.audio` / `choices.0.message.audio.data`）；
配 `responseType: auto` 时会自动在常见路径里找（内置 13 条，含 `data.audio`、`audio`、`data` 等）。

**形态 3：JSON 里给音频 URL**

```json
{ "ok": true, "audio_url": "https://cdn.example.com/abc.mp3" }
```

配 `responseEncoding: url` + `responsePath: audio_url`。客户端会再下载一次（支持重定向）。

### A4. 失败怎么报（客户端会原样显示给你）

| 你的行为 | 客户端表现 |
|---|---|
| 非 2xx | `custom: HTTP 400 {"error":…}`（带响应体前 300 字符） |
| 200 但 < 1024 字节 | `custom: 返回的音频过小（N 字节）` |
| 200 但是 JSON 且找不到音频 | `custom: 响应是 JSON 但里面没找到音频数据（找过 …）` |
| 超时 | `custom: 请求超时（60000ms）` |
| 音频容器与 `format` 不符 | 客户端不管，落盘扩展名按 `format` —— 播放器可能打不开，自己保证一致 |

**别用 200 + 错误 JSON 表示失败**：那会被当成「JSON 响应但没音频」，报错文本对你 troubleshooting 没帮助。

### A5. 自检

仓库自带一个最小参考服务端（只回静音 WAV，用来先验证链路）和一份自检脚本：

```bash
node examples/tts-server-min.mjs --port 8899        # 起一个假的
node examples/tts-check.mjs http://127.0.0.1:8899/tts
# → 5/5 通过：200 / Content-Type / ≥1024 字节 / 空 text 非 200 / 超长 text 不 5xx
```

把自己的地址换进去，全过就说明契约对上了。

---

## 方向 B：你接别人的服务（本插件当客户端）

你需要准备四样东西，填进 `tts.config.json` 的 `custom`：

| 你要知道 | 填哪 |
|---|---|
| 请求地址 | `url` |
| 鉴权方式（`api-key` 头？`Authorization: Bearer`？query 参数？） | `headersText`（或 `url` 里带 query） |
| 请求体长什么样（字段名、嵌套、是否要 `messages`） | `bodyText` |
| 音频从响应的哪里出（字节 / base64 路径 / URL 路径） | `responseType` + `responsePath` + `responseEncoding` |

**顺序建议**：先 `curl` 手动打通一次 → 把 curl 的 `-H` 抄进 `headersText`、`-d` 抄进 `bodyText`
→ `node src/cli.mjs --describe` 看配全没 → `--text "测试" --out t.mp3`。

调试时把 `fallback` 设成 `false`：否则自定义接口失败会自动降级到 edge，
你听到「有声音」但其实根本没走到你的接口（配置文件里的 `fallback` 就是为这个场景准备的开关）。

---

## 附：curl 速查

```bash
# 方向 A：你的服务（最小契约）
curl -s -o out.mp3 -X POST http://127.0.0.1:8899/tts \
  -H "Content-Type: application/json" \
  -d '{"text":"你好","voice":"冰糖","format":"mp3"}'

# 方向 A：只要元数据、不要音频（有些服务支持）
curl -s -X POST http://127.0.0.1:8899/tts -H "Content-Type: application/json" \
  -d '{"text":"你好","dryRun":true}'

# 方向 B：读模型列表（OpenAI 兼容）
curl -s https://api.example.com/v1/models -H "api-key: $KEY"

# 本插件服务端的健康检查
curl -s http://127.0.0.1:8899/healthz
```
