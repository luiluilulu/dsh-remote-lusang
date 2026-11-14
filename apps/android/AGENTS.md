# Android Agent Notes

历史实现与验证记录归档在 [../../docs/archive/agents-android.md](../../docs/archive/agents-android.md)。

## Expo 版本

Expo HAS CHANGED — 写代码前先读 https://docs.expo.dev/versions/v57.0.0/ 的精确版本文档。

## 输入框离线契约（Issue #7 / #409）

`editable` 由 `chat/composer-gate.ts` 的 `composerEditable({ permissionSelecting, uploading })` 计算，
只有权限切换与上传中会锁定，不随连接状态禁用；动作入口（`+`、快捷提示、附件、工具、权限）仍按
`composerDisabled`（含 `!connected`）。`submit()` 先过 `submitIntent()`，`'offline'` 在
`applyDraft('')` / `setQuotes([])` 之前返回，草稿留在加密的 `browse-memory` 条目；发送按钮禁用，
并在 `!connected && draft.length > 0` 时显示 `chat.offlineSendBlocked`。`sendMessage` 在插入
`local:` 乐观行之前对非 `connected` 返回 `'rejected'`（离线不能走 `'kept'`）。全屏输入框只在
会话切换时收起，不因 carrier 掉线重置。

## 模块边界

`chat-screen.tsx` 只做页面编排与会话操作；`chat/composer.tsx`、`chat/action-menu.tsx` 负责输入区与
更多菜单；附件、消息投影、滚动、命令与引用、快捷提示、返回键分别在 `chat/use-chat-*.ts`。
语音输入：`services/voice.ts`（权限/语言）、`screens/chat/use-voice-input.ts`（idle/recording/
transcribing 状态机）、`chat/composer.tsx` 录音条；原生
`plugins/remote-foreground-service/RemoteAudioRecorderModule.kt`（`DshRemoteAudioRecorder`，
16 kHz mono PCM16 WAV）。语音入口只在 Harness 会话且 Host 宣告 `speech.remote.v1` 时显示。

## 验证

`pnpm --filter @dsh-remote/android check`（renderer 生成 + 工作区数据面校验 + `tsc --noEmit`）与
`test`（vitest）。未构建 APK 或未做真机验收的改动必须在交付说明中注明。
