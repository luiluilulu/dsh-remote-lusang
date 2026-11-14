# DeepSeek「全家桶应用 API」接入设计（B 线 recon + MVP 拆分）

状态：recon 完成，MVP-0（ASR）已落地，MVP-1 起待实现。
日期：2026-11-14。相关代码：`packages/plugin/src/`、`apps/android/src/services/`。

## 1. 目标与约束

手机端只提供入口，**能力全部在电脑端执行**：

- ASR 语音输入（已实现）、TTS 朗读、OCR 取字、Search/Fetch（链接总结）。
- API key 只存电脑端（Host 插件设置），**手机不落地 key**，任何日志/响应不得回显 key。
- 不新增通用 HTTP 代理、任意文件读写或远程桌面；沿用既有加密 Remote 通道与 base64/transfer 传输。

## 2. 已核实的事实

| 能力 | 电脑端现状 | 结论 |
| --- | --- | --- |
| ASR | DSH 自带官方实验命名空间 `@deepseek-ai/dsh-experimental-api-speech-to-text`（`speech/transcribe`，canonical base64 WAV，4 MiB / 120 s，SenseVoice 本地识别，无 key） | 已接入：Host allowlist + `speech.remote.v1` 能力；Android 原生录 16 kHz mono PCM16 WAV 回填草稿 |
| TTS | DSH 安装包内无 TTS Remote 命名空间；Windows 本机 `powershell.exe` + `System.Speech` 实测可用（Huihui zh-CN / Zira en-US，输出 WAV） | 自建 Host 端点 + Windows SAPI（离线、无 key） |
| OCR | 无官方 Remote API；`Windows.Media.Ocr` 实测可用（en-US、zh-Hans-CN） | 自建 Host 端点 + WinRT OCR（离线、无 key） |
| Fetch | 无官方 Remote API；DSH 的 `web_fetch` 是 Agent 工具而非 Remote 端点 | 自建 Host 端点，Node `fetch` + 正文提取（无 key） |
| Search | 无官方 Remote API；无内置搜索供应商 | 自建 Host 端点，需在 Host 设置中配置搜索 API key（Brave/Tavily/Bing 等），未配置则能力不可用 |

注：以上「无官方 Remote API」指当前 DSH 安装包内未发现可直接复用的 Remote 命名空间；如后续官方提供，优先改用官方端点并删除自建实现。

## 3. 架构

沿用 CodeX 域已验证的自建端点通道：

- Host：`packages/plugin/src/rpc-router.ts` 新增固定端点（与 `codex.app.*` 同一 RPC 路由）+
  `packages/plugin/src/app-apis/` 领域实现；同时在 `hostCapabilities()` 宣告 `app-api.v1`。
- 手机：`events`/`rpc` 走既有加密连接；新增方法只在 `connection.ts` 内封装，不暴露通用 RPC。
- 端点（固定 allowlist，逐字段 Zod 校验）：

| 端点 | 入参 | 出参 | 上限 |
| --- | --- | --- | --- |
| `appApi.tts` | `{ text, voice?, rate? }` | `{ audioBase64, format: 'wav', durationMs }` | 文本 ≤ 2 000 字，WAV ≤ 4 MiB |
| `appApi.ocr` | `{ imageBase64, language? }` | `{ text, lines: string[] }` | 图片 ≤ 8 MiB |
| `appApi.fetch` | `{ url }` | `{ url, title, text }` | 响应 ≤ 1 MiB，正文 ≤ 20 000 字 |
| `appApi.search` | `{ query, limit? }` | `{ results: [{ title, url, snippet }] }` | 结果 ≤ 10 条 |

- 密钥与配置：只存 Host 插件设置（`search.apiKey` 等）；设置项只在本机可读写；任何错误信息不得包含 key；
  未配置时端点返回 `APP_API_UNAVAILABLE`，手机隐藏入口而不是报错。
- 传输：base64 超过 2 MiB 时走既有 gateway transfer 路径，无需新协议。

## 4. 逐项设计

### TTS 朗读（MVP-1）

- Host：用 `powershell.exe -NoProfile` 调 `System.Speech.Synthesis.SpeechSynthesizer`，
  `SetOutputToWaveStream` 输出 WAV（实测 73 876 B / 短语），临时文件放 Host tmp 且用后删除；
  同文本+voice+rate 做内存 LRU（48 条）避免重复合成。
- Android：新增原生 `RemoteAudioPlayerModule.kt`（`MediaPlayer`，播放 base64 WAV，start/stop/释放）；
  助手消息操作行增加「朗读」按钮，再点停止；不落盘（缓存到 `cacheDir` 且退出清理）。
- 边界：仅 Windows Host 可用；语音列表由 Host 提供（`appApi.voices` 可选，MVP 用默认）。

### OCR 取字（MVP-1）

- Host：`powershell.exe -NoProfile -File ocr.ps1`（脚本随插件安装，WinRT `Windows.Media.Ocr`），
  图片写 Host tmp → 识别 → 删除；语言默认取系统识别器（en-US / zh-Hans-CN）。
- Android：图片预览与相册图片的操作菜单增加「取字」，结果回填草稿（不自动发送）。
- 边界：手写/竖排/表格识别质量有限；图片 ≤ 8 MiB；非 Windows Host 不可用。

### Fetch 链接总结（MVP-2，已实现）

- Host：Node `fetch`，仅允许 `http/https`；**SSRF 防护**：解析目标主机全部地址，拒绝
  私有/环回/链路本地/保留地址，禁止重定向到非法地址（最多 3 跳）；超时 10 s；
  HTML 去脚本/样式后提取 `<title>` 与正文文本；返回截断后的正文。
- Android：输入框粘贴 URL 时提供「总结链接」入口（或分享面板导入），把 `title + 正文摘要请求`
  作为草稿内容，由用户确认发送。
- 边界：不做 JS 渲染（SPA 需后续方案）；不做通用代理。

### Search（MVP-3）

- Host：按 Host 设置中的供应商与 key 调搜索 API（默认支持 Brave Search，可扩展 Tavily/Bing），
  返回 `title/url/snippet`；key 只读自 Host 设置，未配置返回不可用。
- Android：输入框「搜索」入口，选中结果后把链接插入草稿并触发 Fetch 总结。
- 边界：需要用户自备 key；供应商条款与配额由用户负责；key 永不进日志/手机。

## 5. 里程碑与验证

1. **MVP-1（TTS + OCR）**：Host 端点 + 能力探测 + Android 原生播放/图片取字入口。
   验证：`tsc --noEmit`；Host 侧端点 schema 与 SSRF/大小上限的契约测试（按 Test Policy 只测核心边界）；
   真机播放与取字人工验收。
2. **MVP-2（Fetch）**：端点 + SSRF 拒绝测试（环回/私有地址/重定向）+ Android 入口。
3. **MVP-3（Search）**：设置项 + 供应商适配 + key 不泄漏检查（响应/日志）。

每批完成后随下一次成批发版（`own.N`），不单独发版。

## 6. 未验证 / 风险

- TTS/OCR 依赖 `powershell.exe`（Windows 专属）；非 Windows Host 必须显式返回不可用。
- `System.Speech` 音质与长文本延迟未测；OCR 对竖排、表格、低分辨率图片效果未测。
- 搜索供应商未定，key 存储位置（插件设置 vs 独立凭据文件）待实现时定；
  插件设置在本机 `settings.yaml` 中为明文，需要文档明确提示。
- 音频回传走 base64/transfer，长文 WAV 可能触发 transfer 路径，端到端未测。
