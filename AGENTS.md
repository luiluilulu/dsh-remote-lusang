# Repository Guide for Agents

自建 DeepSeek Harness Remote：Host 插件 + Android/VS Code/Browser 客户端 + 开源自部署 Server。
历史实现与验证记录归档在 [docs/archive/agents-history.md](docs/archive/agents-history.md)（按需查阅，
不再每轮注入）。任务与优先级以 `docs/TODO.md` 为准；不得把 TODO 目标写成已完成。

## 当前焦点（2026-11-14）

- **B 线（官方能力接入）**：ASR 语音输入曾实现但体验不达标，`0.6.4-own.14.1` 已移除 Android 入口（Host 侧放行保留）。Host 放行官方
  `@deepseek-ai/dsh-experimental-api-speech-to-text` 命名空间，并在组合中存在 `speechController`
  时通过 `hostCapabilities()` 宣告 `speech.remote.v1`；Android 原生
  `plugins/remote-foreground-service/RemoteAudioRecorderModule.kt`（`DshRemoteAudioRecorder`）
  录 16 kHz mono PCM16 WAV，经 `speech/transcribe` 在电脑端转写后回填草稿，args 约定
  `{ request: { audioBase64, language } }`。TTS/OCR/Fetch/Search 均已实现为 Host 自建端点
  `appApi.tts|ocr|fetch|search`（能力 `app-api.v1` / `app-api.search.v1`，搜索 key 只读
  `DSH_REMOTE_SEARCH_KEY`），设计见 `docs/design/APP-API-INTEGRATION.md`。
  API key 只存电脑端由 Host 代理，手机不落地，不打印密钥。
- **A 线（复刻官方 DeepSeek App UI）**：批次 1–4 已完成聊天页、抽屉、设置、Markdown 主要对齐；
  次级页面（Bot 模式、插件页、自动化任务页、设备列表/主机切换）也已扁平官方化，差距清单见
  `docs/design/OFFICIAL-UI-ALIGNMENT.md`。设计事实源：
  `artifacts/research/lead-ref/OFFICIAL-UI-REFERENCE.md`（已忽略，不入库）。
- **own.14 / own.14.1 已发布（2026-11-14）**：`v0.6.4-own.14`（APK 65,811,469 B）与
  `v0.6.4-own.14.1`（versionCode 85，65,799,385 B，移除语音输入入口并 block 掉 `RECORD_AUDIO`）
  的 tag + GitHub Release 均已发布，`releases/latest` 现指向 own.14.1。
  Host 插件新能力的本地包在 `artifacts/android-build/plugin-release/`（未提交 dist，已本地安装并重启验证）；
  发版流程见 `docs/RELEASE.md`。真机待回归：朗读、取字、链接总结、网页搜索、P2P/Relay 链路。

## 版本号与发布节奏（用户明确要求）

- **小修不单独发版**：日常修复只提交到 `feat/ux-fixes`，不 bump versionName/versionCode、不打 tag、
  不发 Release；真机验收放到下一次成批发版时一起做。
- 攒批再发：功能批次 `0.6.4-own.N+1`；小修批次优先补丁位 `0.6.4-own.N.1`（versionCode 仍每次 +1）。
- 发版必须：annotated tag → 推分支与 tag → **带 APK 附件的 GitHub Release**（否则应用内更新无法下载）。
- `apps/android/src/services/app-update.ts` 的 `isNewerVersion` 需支持 `-own.N.M` 补丁后缀
  （首次使用补丁版本时一起实现，不单独发版）。
- 分支：特性分支从 `feat/ux-fixes` 拉出 → 完成后 fast-forward 合回，随下一批发版打 tag。

## 仓库边界

实现：Host 插件、Android / VS Code / Browser 客户端、Protocol/Crypto/WebRTC/Client Core、
开源自部署 Server（单账号）、Mock Host。
禁止：完整多账号 Server、Remote Web 会话界面、Admin、完整 Server 的数据库/队列/K8s 等基础设施；
空 Web/UI 预留目录不应创建。必须保留 `docs/server.md` 与 `docs/protocol.md`；不得把自部署版本
描述成完整 Server 已实现的能力。

## 项目结构

```text
apps/{android,vscode,browser,server}
packages/{plugin,protocol,crypto,webrtc,client-core}
examples/mock-host
docs/{design,TODO.md,protocol.md,server.md,plugin-integration.md}
```

仓库根同时是 DSH Desktop 的 GitHub 安装边界：必须保留 `dsh.bundle.patch`、Host/Client exports、
CLI bin、`cordis.patch.yml`，以及可提交的发布入口 `index.js`、`packages/plugin/dist/index.js`、
`client.github.js`、`packages/plugin/bin/ds-harness-remote.js`。根包不标 `private`。
Plugin bundle 用 esbuild 统一依赖路径标签；CI 重建后 `dist` 必须与提交版本一致。
根 `package.json` 刻意不声明 `scripts`，避免 GitHub 安装被误判为需要构建。

## 开发命令

环境：Node.js 24.9、pnpm 9.15.4（Android 另需 Android Studio/SDK/JDK）。

```bash
pnpm install
pnpm --filter './packages/**' -r build
pnpm -r check
node scripts/verify-dsh-plugin.mjs
pnpm -r test
NODE_ENV=production pnpm --workspace-concurrency=1 -r build
```

全仓 build 必须 `--workspace-concurrency=1`（Android prebuild 会再次编译共享包）。
Android：`pnpm --filter @dsh-remote/android android|start`（不能用 Expo Go）。
Server：`pnpm --filter @dsh-remote/protocol build`、`pnpm --filter @dsh-remote/server check|test|build`。
已知警告：Metro 对 `@noble/hashes/crypto.js` 使用 package exports fallback（见 docs/TODO.md，
不得静默删除说明）。

## 实现规则

1. `docs/protocol.md` 是线协议权威来源。代码与文档冲突时先按协议实现；必要的协议澄清必须同步更新文档与共享类型。
2. Plugin 不监听公网端口，只建立出站连接。
3. Remote business message 只能进入已认证的加密 channel；明文、未知 connection、错误 target、重放和 identity mismatch 必须 fail closed。
4. Server membership 与 Host 本地 trusted peer 必须同时成立。
5. v1 permission decision 只允许 `allow_once | deny`，禁止恢复 `allow_session`。
6. 按用户 2026-09-20 授权，支持官方原生文件树/只读预览、默认开启且可在详细 Remote 设置中关闭的 `terminal.enabled` 交互终端，以及 `loopback.ports` 明确授权的 HTTP/WebSocket 预览。文件通过官方 `workspaceFiles`/`officeToPdf` 或已有 dsh-file-viewer provider 读取，除下述 2026-10-18 workspace upload 与 2026-10-21 workspace/create 目录创建授权外，禁止新增直接 filesystem 写入、远程桌面或通用 Harness tool RPC。终端以 Host 用户权限运行，独立于 Agent 审批；按设备固定终端归属与连接输入权，断线不重放输入。loopback Host 只出站连接 `127.0.0.1` 白名单端口；Desktop Client 可监听随机本机端口承载独立预览 origin，禁止监听公网、任意目标、CONNECT 和通用 TCP 转发。
7. Token、私钥、主机匹配码、prompt、源码和工具输出不得写日志。
8. Harness v0.1.1 rc.2 ApiProxy 已移除；v0.1.2 alpha.1–rc.1 与 v0.1.5 rc.1 / v0.1.6 alpha.1 Session V3 业务层只使用官方 `TypertGateway` Remote carrier；原生侧栏使用官方 `workspaceFiles` / `officeToPdf` / `terminal` 固定 allowlist；保留 dsh-file-viewer provider 通道。除规则 10 规定的 CodeX 内存展示载体外，禁止增加 session/agent/workspace/permission adapter、另一套 Harness wire format 或通用文件系统协议。
9. 不修改用户已有变更，不提交 `node_modules`、Expo cache、Android build 产物或个人 Agent 配置；唯一允许提交的 `dist` 是根 DSH GitHub Bundle 所需的 `packages/plugin/dist/index.js` 与 `client.github.js`，另需保留根 Host 入口 `index.js`。
10. Codex 支持必须保留在现有 Remote Plugin 内，并作为 `packages/plugin/src/codex/` 独立业务领域实现；默认开启且可在设置中关闭，使用独立 capability/RPC/event/state。允许 Client Plugin 以临时 Typert 载体复用 DSH 原生 UI，也允许 Android 直接消费同一 `codex.app.*` 并只在内存中投影其移动端 Workspace/Session/Chat；两者都禁止写入 DSH SessionStore、Workspace 数据库或 Harness 日志。远端只允许编译期固定 App Server allowlist；Workspace authority 优先来自 CodeX App Server 的 `project/list`，该接口不可用或无可用根目录时才可回退到 App Server 已通过 `thread/list` 返回的绝对 `cwd`。`project/create` 只可注册 Host 上已存在的单个绝对目录，Host 必须执行 `realpath` 并确认目标是目录，且上游返回的新 Project 才能扩展 authority。新 Thread 还可使用这些 authority 根内经过词法路径与 `realpath` 双重校验的真实子目录，禁止推测共同父目录或越界接受 Client 自报路径。

Android 的本机浏览状态可单独保存加密草稿、收藏、阅读位置与最近访问记录；不再持久化对话正文预览，
按 Server/账号/Host identity 隔离；不保存审批句柄、待发送请求、权限或图片字节，不写 DSH
SessionStore/Workspace。联网历史与原生权限仍是执行依据。

## 测试政策

非核心功能不写测试。测试预算只用于：协议编解码/schema、身份与加密篡改重放、账号授权与
Control/Relay 授权、RPC correlation 与权限 fail-closed、Typert allowlist、transport
fallback/reconnect 等核心状态机。纯展示 UI、文案、样式、非关键脚本不新增测试；禁止用源码字符串、
组件布局、图标、配色或文案断言扩充测试。同一契约只在所属 package 测一次；输入变体用命名场景矩阵，
场景间复用 setup/teardown，失败要报告具体场景并继续执行同组。不得用 skip/exclude 隐藏测试。
测试数量指注册的契约测试数，不代表边界输入数。

## 文档规范

- 调试/验收截图、录屏不提交到仓库；本地留档用已忽略的 `artifacts/` 或 `docs/screenshots/`。
- 对外发布说明与 CHANGELOG 只写用户可感知的功能、修复、兼容性与贡献者；不附测试数量、构建命令、
  bundle 校验、未验收清单或构建警告。
- 入口：`README.md`（英文默认，与 `README.en.md` 一致）、`README.zh.md`、`AGENTS.md`（本文件）、
  `docs/TODO.md`、`docs/CHANGELOG.md`、`docs/PRIVACY.md`、`docs/RELEASE.md`、`docs/design/{PRODUCT,DESIGN,APP-API-INTEGRATION,OFFICIAL-UI-ALIGNMENT}.md`、
  `apps/server/README*.md`、`docs/{server,protocol,plugin-integration}.md`、`docs/archive/vibe-coding.md`。
- 文档范围或路径变化时同步更新相对链接与以上入口。

## 历史记录

2026-11-14 之前的实现与验证记录（A 线 UI 批次详情、ACP/CodeX/WebRTC/Server 各轮、发布验收等）
已归档到 [docs/archive/agents-history.md](docs/archive/agents-history.md)。新增实现记录先写在本文件
顶部附近，整理时再移入归档。
