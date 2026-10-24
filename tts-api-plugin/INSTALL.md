# 装进已有的 qq-bridge（一条命令）

前置：这台机器上**已经装好了 qq-bridge**（有 `<qq-bridge>/src/bridge.js` 和 `config.json`），
并且 `npm install` 跑过（MCP SDK 在里面）。DSH 装过、跑过一次（有 `~/.dsh`）。

```bash
node install.mjs
```

就这样。它自己找桥接、找 DSH profile、把该放的文件放好、把该开的开关打开。

---

## 它会做什么（9 步，每一步都打印出来）

| 步骤 | 动作 | 说明 |
|---|---|---|
| 1 | 找 qq-bridge | 依次看 `--bridge` 参数 / `QQ_BRIDGE_DIR` / 当前目录 / `../qq-bridge` / `~/qq-bridge` / 各盘根目录下的 `qq-bridge`；判据是 `src/bridge.js` + `package.json` 里 name 含 qq-bridge |
| 2 | 找 DSH profile | `DSH_HOME` 或 `~/.dsh`；profile 优先 `desktop`，其次 `web`；也可以用 `--profile 名字` 指定 |
| 3 | 复制三个文件 | `src/tts.mjs`、`src/models.mjs`、`src/mcp-tts.js` → `<qq-bridge>/src/`；**内容相同就跳过**，覆盖前先 `xxx.bak-<时间戳>` 备份 |
| 4 | 检查依赖 | 有没有 `<qq-bridge>/node_modules/@modelcontextprotocol/sdk`；缺了就提示先 `npm install` |
| 5 | 合并 `config.json` | 缺 `socialV2.voice.tts` 才补默认项（**只补缺失，绝不覆盖你已有的值**）；首次安装顺手打开 `voice.enabled` 与工具 `sendVoice`；补 `ttsMaxChars=200`；建语音库目录 |
| 6 | 注册 MCP | 在 `cordis.patch.yml` 里维护 `# === tts-plugin MCP BEGIN/END ===` 一块，`serverName: tts`，命令是本机的 `node`，脚本指向 `<qq-bridge>/src/mcp-tts.js` |
| 7 | 放行工具前缀 | 如果桥接里有 `plugins/qq-agent-presets/qq-tool-restrict.mjs` 的白名单数组，就把 `'mcp__tts__'` 加进去（不加的话 QQ 群里调会被「不在白名单」拒掉） |
| 8 | 自检 | 直接跑 `node <qq-bridge>/src/mcp-tts.js --selftest`，打印工具清单和就绪状态 |
| 9 | 告诉你下一步 | 重启 DSH（MCP 只在启动时拉起）、重启桥接（改了 config 才需要）、填 url + apiKey |

改动的三个文件都会先备份成 `*.bak-<时间戳>`，装坏了能直接换回去。

---

## 装完之后

1. **重启 DSH**（关掉再开）。MCP server 只在 DSH 启动时拉起，重启前 QQ 侧看不到 `tts_*` 工具。
2. **重启桥接**（`start.bat` 或 `npm start`）。这一步是为了让 `config.json` 的语音开关生效。
3. **填接口和密钥**，两种方式都行：
   - 让 AI 调 `tts_configure`：`tts_configure { url: "https://api.xiaomimimo.com/v1/chat/completions", apiKey: "sk-…", model: "mimo-v2.5-tts", voice: "冰糖" }`
   - 或者直接改 `<qq-bridge>/config.json` 的 `socialV2.voice.tts.custom`
4. **确认**：调 `tts_status`，看到「就绪：是」即可；再 `tts_speak { text: "测试一下" }` 合成一条听听。

---

## 她（AI）会拿到什么工具

| 工具 | 干什么 |
|---|---|
| `tts_status` | 看现在用的引擎、接口、有没有密钥、模型/音色、语音库、上限、还缺什么 |
| `tts_speak` | 把一段文字合成成语音**存进语音库**，返回文件名；随后用 `qq_send_voice { voice: "<文件名>" }` 发到 QQ |
| `tts_models` | 按接口地址读模型列表（`/v1/chat/completions` → `/v1/models`） |
| `tts_configure` | 改 url / 密钥 / 模型 / 音色 / 格式（只改你传的字段，写回 config.json） |

注意：`tts_speak` 只负责合成，**发不发**由 `qq_send_voice` 决定，而且只有它返回
`verified=true` 才算真的发出去了。

---

## 常用参数

```bash
node install.mjs --dry-run          # 只看计划，不动任何文件
node install.mjs --bridge D:\qq-bridge --profile desktop
QQ_BRIDGE_DIR=D:\qq-bridge DSH_HOME=C:\Users\me\.dsh node install.mjs
node install.mjs --uninstall        # 卸掉：删复制的文件（被改过的保留）、撤 MCP 块、撤白名单
```

`--uninstall` 只删「内容和插件自带的一模一样」的文件；你自己改过的会保留并提醒你。
`config.json` 里的 `socialV2.voice.tts` 配置会保留（那是你的密钥，不替你删）。

---

## 出问题怎么看

| 现象 | 原因 / 处理 |
|---|---|
| 第 1 步找不到桥接 | 加 `--bridge <路径>`；或者 `cd` 到桥接目录里再跑 |
| 第 4 步说没有 MCP SDK | `cd <qq-bridge> && npm install`，再重跑安装器 |
| 重启后 QQ 里没有 `tts_*` 工具 | 确认重启的是 **DSH**（不是桥接）；再看 `cordis.patch.yml` 里有没有 `# === tts-plugin MCP BEGIN ===` 那块 |
| 调工具报「不在 QQ 桥接白名单内」 | 第 7 步没生效（桥接里没有那个 preset 文件，或文件结构变了）；手动把 `'mcp__tts__'` 加进 `SAFE_PREFIXES`，然后重启 DSH |
| `tts_speak` 报 `custom: HTTP 400 …` | 接口/密钥/请求体不对，先 `tts_models` 验证密钥，再 `tts_status` 看请求体模板 |
| 没有密钥也想先出声 | 把 `provider` 改成 `edge`（免密钥、需要 `python -m pip install edge-tts`）或 `sapi`（Windows 本机） |
