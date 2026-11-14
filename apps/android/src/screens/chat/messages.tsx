import { heartbeatMessageBody } from '../../ui/heartbeat-message'
import { ChatImageView } from '../../ui/chat-image'
import { ArrowUp, Bot, Check, CircleCheck, ChevronDown, ChevronRight, ChevronUp, Code2, FilePenLine, FileSearch, ListTree, RefreshCw, ShieldAlert, Sparkles, Terminal, Trash2, Wrench, User, X } from 'lucide-react-native'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  Animated,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native'
import * as Clipboard from 'expo-clipboard'
import * as Haptics from 'expo-haptics'
import { strings as zhCN } from '../../locales/i18n'
import { foldHistory, hasVisibleMessageText } from '../../state/event-reducer'
import { readToolHistoryDetail, useAppStore } from '../../state/store'
import { formatQuoteDraftSnippet } from '../../ui/quote-helpers'
import { IconChecklistOutline, IconCheckOutline, IconCopyOutline, IconDatabaseOutline } from '../../ui/dsh-icons'
import type { UiArtifact } from '../../state/ui-artifacts'
import type {
  ApprovalActivity,
  ChatImage,
  ChatItem,
  ChatMessage,
  QuestionActivity,
  ToolActivity,
  ToolDisplayDetail,
} from '../../types'
import { Button, IconButton } from '../../ui/components'
import { NativeMarkdown, useMarkdownLink } from '../../ui/markdown'
import { parseMessageQuotes, QuoteMarkIcon, QuotePreview } from '../../ui/quote-preview'
import { PresentedFileGroup } from '../../ui/file-card'
import { useTheme } from '../../ui/theme-context'
import { useThemedStyles } from '../../ui/use-themed-styles'
import { parseBotReplies } from '../bot/replies'
import { BotReplies } from '../bot/reply-view'
import type { BotObject } from '../../services/bot-catalog'
import type { QueueDockItem } from './use-chat-transcript'
import type { ProcessActivity, ProcessSegment } from '../chat-process'
import { processSummary, processDetail, processSegments, toolActivity, toolDisplayName } from '../chat-process'
import { MessageActions } from '../message-actions'
import { IntelligentUiCard } from '../intelligent-ui-card'
import { createStyles } from './styles'

/** Only activity ranges fold; completing a turn must never hide spoken replies. */
export const ChatProcessGroup = memo(function ChatProcessGroup({ items, artifacts, updatedArtifacts, availableUiIds, busyAction, onApproval, onQuestion }: {
  items: ChatItem[]
  artifacts: UiArtifact[]
  updatedArtifacts: UiArtifact[]
  availableUiIds: ReadonlySet<string>
  busyAction?: string
  onApproval: (itemId: string, outcome: 'allowed-once' | 'rejected') => Promise<void>
  onQuestion: (itemId: string, selected: Record<string, string[]>, custom?: Record<string, string>) => Promise<void>
}) {
  const { colors } = useTheme()
  const styles = useThemedStyles(createStyles)
  const backend = useAppStore(state => state.selectedSession?.backend)
  const last = items.at(-1)
  const codexClosed = backend === 'codex' && !items.some(isActiveChatItem)
    && last?.kind === 'message' && last.role === 'assistant'
  const end = items.find(item => item.turnEnd !== undefined)?.turnEnd
    ?? (codexClosed ? { reason: 'completed' as const, time: 0 } : undefined)
  const segments = useMemo(() => processSegments(items).flatMap((segment):
    (ProcessSegment | { kind: 'botReplies'; key: string; rows: BotObject[]; groupRelay: boolean })[] => {
    if (segment.kind === 'response') return [segment]
    const result: (ProcessSegment | { kind: 'botReplies'; key: string; rows: BotObject[]; groupRelay: boolean })[] = []
    let pending: ChatItem[] = []
    for (const item of segment.items) {
      const replies = item.kind === 'tool' && item.state === 'finished'
        ? parseBotReplies(item.resultDetail?.text) : undefined
      if (!replies?.length) { pending.push(item); continue }
      const groupRelay = item.kind === 'tool' && (item.toolKey ?? item.toolName) === 'group_relay'
      // A completed group relay is conversation content, not a visible tool step.
      // Unrecognized/failed results and all other tools retain their diagnostics.
      if (!groupRelay) pending.push(item)
      if (pending.length) result.push({ kind: 'activity', key: `activity:${pending[0]!.id}`, items: pending })
      pending = []
      result.push({ kind: 'botReplies', key: `bot-replies:${item.id}`, rows: replies, groupRelay })
    }
    if (pending.length) result.push({ kind: 'activity', key: `activity:${pending[0]!.id}`, items: pending })
    return result
  }), [items])
  const unavailableUi = items.filter(item => item.kind === 'tool' && item.state === 'finished'
    && (item.toolKey === 'ui_render' || item.toolKey === 'ui_render_widget' || item.toolKey === 'ui_compose')
    && !availableUiIds.has(item.id)
    && (typeof item.uiResultMeta !== 'object' || item.uiResultMeta === null
      || (item.uiResultMeta as { ok?: unknown }).ok !== false))
  const hasGroupRelayReplies = segments.some(segment => segment.kind === 'botReplies' && segment.groupRelay)
  const hasToolSummary = segments.some(segment => segment.kind === 'activity'
    && segment.items.some(item => item.kind === 'tool'))
  const label = end?.reason === 'stopped' ? zhCN.chatProcess.stopped
    : end?.reason === 'failed' ? zhCN.chat.failed : zhCN.chat.completed
  const onFilePress = useMarkdownLink()
  const editedFiles = useMemo(() => {
    const files: { path: string; name?: string; action?: 'created' | 'edited' }[] = []
    const seen = new Set<string>()
    for (const item of items) {
      if (item.kind !== 'tool' || item.state !== 'finished') continue
      const name = (item.toolKey ?? item.toolName).toLowerCase()
      if (!item.arguments) continue
      try {
        const args = JSON.parse(item.arguments) as Record<string, unknown>
        let path: string | undefined
        let action: 'created' | 'edited' = 'edited'
        if (name === 'write' || name === 'write_file') {
          path = (args.file_path || args.path || args.filename) as string | undefined
          action = 'created'
        } else if (name === 'edit' || name === 'edit_file' || name === 'patch') {
          path = (args.file_path || args.path || args.filename) as string | undefined
          action = 'edited'
        } else if (name === 'str_replace_editor') {
          const cmd = args.command as string | undefined
          if (cmd === 'view') continue // Read-only command does not modify files
          path = (args.path || args.file_path) as string | undefined
          action = cmd === 'create' ? 'created' : 'edited'
        }
        if (typeof path === 'string' && path.trim() && !seen.has(path.trim())) {
          seen.add(path.trim())
          files.push({ path: path.trim(), action })
        }
      } catch {}
    }
    return files
  }, [items])
  const lastResponseIndex = segments.map(s => s.kind).lastIndexOf('response')
  return <View style={styles.processGroup}>
    {end !== undefined && !(end.reason === 'completed' && (hasGroupRelayReplies || hasToolSummary)) && <View style={styles.turnProcessHeader}>
      <Text style={styles.turnProcessLabel}>{label}{end.reason !== 'completed' && end.detail !== undefined ? ` · ${end.detail}` : ''}</Text>
    </View>}
    {segments.map((segment, index) => segment.kind === 'response'
      ? <MessageBubble
          key={segment.key}
          item={segment.item}
          compact
          artifacts={index === lastResponseIndex ? artifacts : undefined}
          editedFiles={index === lastResponseIndex ? editedFiles : undefined}
          onFilePress={onFilePress}
        />
      : segment.kind === 'botReplies' ? <BotReplies key={segment.key} rows={segment.rows} />
      : <ChatActivityGroup key={segment.key} items={segment.items} closed={end !== undefined || index < segments.length - 1}
        busyAction={busyAction} onApproval={onApproval} onQuestion={onQuestion} />)}
    {lastResponseIndex === -1 && <PresentedFileGroup files={editedFiles} onFilePress={onFilePress} />}
    {lastResponseIndex === -1 && artifacts.map(ui => <IntelligentUiCard key={ui.hostId + ':' + ui.sessionId + ':' + ui.uiId} artifact={ui} />)}
    {updatedArtifacts.map(ui => <Text key={'updated:' + ui.uiId} style={[styles.pickerHint, { marginTop: 6 }]}>{ui.title || 'Interactive UI'} updated to version {ui.version}; see its original card above.</Text>)}
    {unavailableUi.map(item => <Text key={'ui-missing:' + item.id} style={[styles.pickerHint, { color: colors.danger, marginTop: 6 }]}>Interactive UI could not be restored from this Host result. Check the original tool output and history metadata.</Text>)}
  </View>
}, (prev, next) => {
  // Every field below is a reference that streaming rebuilds, so compare their
  // contents: a group whose text did not change keeps its rendered subtree.
  if (prev.busyAction !== next.busyAction) return false
  if (prev.onApproval !== next.onApproval || prev.onQuestion !== next.onQuestion) return false
  if (prev.items !== next.items) {
    if (prev.items.length !== next.items.length) return false
    for (let index = 0; index < prev.items.length; index += 1) {
      if (prev.items[index] !== next.items[index]) return false
    }
  }
  if (prev.artifacts !== next.artifacts) return false
  if (prev.updatedArtifacts !== next.updatedArtifacts) return false
  const before = prev.availableUiIds
  const after = next.availableUiIds
  if (before !== after) {
    if (before.size !== after.size) return false
    for (const id of before) {
      if (!after.has(id)) return false
    }
  }
  return true
})

/** Bottom-of-card collapse affordance: collapsing never requires scrolling back to the card header. */
function CollapseBar({ onPress, label }: { onPress: () => void; label?: string }) {
  const { colors } = useTheme()
  const styles = useThemedStyles(createStyles)
  const text = label ?? zhCN.chat.collapseDetails
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={text}
      onPress={onPress}
      style={({ pressed }) => [styles.collapseBar, pressed && styles.reasoningHeaderPressed]}
    >
      <ChevronUp size={16} color={colors.muted} />
      <Text style={styles.collapseText}>{text}</Text>
    </Pressable>
  )
}

export const ChatActivityGroup = memo(function ChatActivityGroup({ items, closed, dense = false, busyAction, onApproval, onQuestion }: {
  items: ChatItem[]
  closed: boolean
  dense?: boolean
  busyAction?: string
  onApproval: (itemId: string, outcome: 'allowed-once' | 'rejected') => Promise<void>
  onQuestion: (itemId: string, selected: Record<string, string[]>, custom?: Record<string, string>) => Promise<void>
}) {
  const { colors } = useTheme()
  const styles = useThemedStyles(createStyles)
  const { height } = useWindowDimensions()
  const [open, setOpen] = useState(false)
  const body = useRef<ScrollView>(null)
  const pending = items.some(item => (item.kind === 'approval' || item.kind === 'question') && item.outcome === undefined)
  const expanded = pending || open
  const tools = items.filter((item): item is ToolActivity => item.kind === 'tool')
  const latestTool = tools.at(-1)
  const activeTool = closed ? undefined : tools.findLast(item => item.state === 'running')
  const runningReasoning = closed ? undefined : items.findLast(item => item.kind === 'message' && item.streamingPhase === 'reasoning')
  const running = activeTool !== undefined || runningReasoning !== undefined
  const counts = new Map<ProcessActivity, number>()
  for (const tool of tools) counts.set(toolActivity(tool), (counts.get(toolActivity(tool)) ?? 0) + 1)
  const labels = zhCN.chatProcess.processActivity
  const completedSummary = tools.length > 0 && !running && closed
  const label = completedSummary
    ? `${zhCN.chat.completed} · ${tools.length} ${zhCN.chatProcess.toolCalls}`
    : tools.length > 0 ? processSummary(counts) : pending ? labels.questions.running
      : running ? labels[activeTool === undefined ? 'thinking' : toolActivity(activeTool)].running
        : processSummary(counts)
  const primary = activeTool ? toolActivity(activeTool) : [...counts].sort((a, b) => b[1] - a[1])[0]?.[0]
  const ActivityIcon = completedSummary ? CircleCheck : primary === 'commands' || primary === 'code' ? Terminal
    : primary === 'read' || primary === 'search' || primary === 'readImage' ? FileSearch
      : primary === 'edit' || primary === 'write' ? FilePenLine
        : primary === 'plan' ? ListTree : tools.length > 0 ? Wrench : Sparkles
  const detail = latestTool !== undefined ? processDetail(latestTool)
    : runningReasoning && runningReasoning.kind === 'message' ? compactActivityText(runningReasoning.reasoning)?.slice(-160) : undefined
  return <View style={styles.activityGroup}>
    <Pressable accessibilityRole="button" accessibilityLabel={detail === undefined ? label : `${label} · ${detail}`}
      accessibilityState={{ expanded, disabled: pending }} disabled={pending}
      onPress={() => setOpen(value => !value)}
      hitSlop={dense ? { top: 6, bottom: 6 } : undefined}
      style={({ pressed }) => [styles.processHeader, dense && { minHeight: 32 }, pressed && styles.reasoningHeaderPressed]}>
      <View style={styles.processIcon}><ActivityIcon size={17} color={colors.muted} /></View>
      <Text style={styles.processLabel} numberOfLines={1} ellipsizeMode="clip">{label}</Text>
      {expanded ? <ChevronUp size={17} color={colors.muted} /> : <ChevronDown size={17} color={colors.muted} />}
    </Pressable>
    {(latestTool !== undefined || running) && !expanded && <View style={styles.processCurrent} accessibilityLiveRegion="polite">
      {latestTool === undefined || (!closed && latestTool.state === 'running')
        ? <ReplyStatusDots />
        : latestTool.state === 'failed' ? <X size={14} color={colors.muted} /> : <CircleCheck size={14} color={colors.muted} />}
      <Text style={styles.processCurrentText} numberOfLines={2}>{latestTool ? toolDisplayName(latestTool) : labels.thinking.running}{detail ? ` · ${detail}` : ''}</Text>
    </View>}
    {expanded && <View style={styles.activityExpandedBody}>
      <ScrollView ref={body} style={{ maxHeight: Math.min(320, height * 0.4) }} nestedScrollEnabled
        keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
        onLayout={() => { if (running) body.current?.scrollToEnd({ animated: false }) }}
        contentContainerStyle={styles.processBody}>
        {items.map(item => item.kind === 'message' && item.role === 'assistant' && !hasVisibleMessageText(item.text) && !item.images?.length
          ? <View key={item.id} style={styles.activityReasoning}><NativeMarkdown text={item.reasoning ?? ''} /></View>
          : <ChatItemView key={item.id} item={item} compact={item.kind === 'tool'} busyAction={busyAction} onApproval={onApproval} onQuestion={onQuestion} />)}
      </ScrollView>
      {!pending && <CollapseBar onPress={() => setOpen(false)} />}
    </View>}
  </View>
})

export const ChatItemView = memo(function ChatItemView({ item, busyAction, compact, onApproval, onQuestion, artifacts, onSendPrompt, resendIds, resendStatus, resendMissingImages }: {
  item: ChatItem
  busyAction?: string
  compact: boolean
  onApproval: (itemId: string, outcome: 'allowed-once' | 'rejected') => Promise<void>
  onQuestion: (itemId: string, selected: Record<string, string[]>, custom?: Record<string, string>) => Promise<void>
  artifacts?: UiArtifact[]
  onSendPrompt?: (text: string) => Promise<boolean>
  /** Undelivered rows retried by the one compact row; only the newest row gets them. */
  resendIds?: string[]
  resendStatus?: string
  resendMissingImages?: boolean
}) {
  if (item.kind === 'approval') return <ApprovalCard item={item} busy={busyAction === `approval:${item.id}`} onRespond={onApproval} />
  if (item.kind === 'question') return <QuestionCard item={item} busy={busyAction === `question:${item.id}`} onRespond={onQuestion} />
  if (item.kind === 'tool') return <ToolRow item={item} compact={compact} />
  const hasArtifacts = artifacts !== undefined && artifacts.length > 0
  if (!compact && item.role === 'assistant'
    && !hasArtifacts
    && !hasVisibleMessageText(item.text) && !item.images?.length
    && hasVisibleMessageText(item.reasoning ?? '')) return <ReasoningDisclosure item={item} />
  return <MessageBubble item={item} compact={compact} artifacts={artifacts} onSendPrompt={onSendPrompt}
    resendIds={resendIds} resendStatus={resendStatus} resendMissingImages={resendMissingImages} />
})

/** Compact retry affordance for the conversation's kept failed/unconfirmed batch. */
function UserRowResend({ ids, status, missingImages }: { ids: string[]; status: string; missingImages: boolean }) {
  const { colors } = useTheme()
  const styles = useThemedStyles(createStyles)
  const busyAction = useAppStore(state => state.busyAction)
  // The newest undelivered row is last in the batch. Its delivery state and raw
  // reason live in the store; read them as one primitive signature so streaming
  // updates elsewhere in the session do not re-render this row.
  const targetId = ids.at(-1)
  const targetSignature = useAppStore(state => {
    const sessionId = state.selectedSession?.sessionId
    if (sessionId === undefined || targetId === undefined) return ''
    const row = (state.messages[sessionId] ?? []).find(item => item.id === targetId)
    if (row?.kind !== 'message' || (row.sendState !== 'failed' && row.sendState !== 'unconfirmed')) return ''
    return `${row.sendState}\u0000${row.sendError ?? ''}`
  })
  const separator = targetSignature.indexOf('\u0000')
  const targetState = separator < 0 ? undefined : targetSignature.slice(0, separator)
  const storeReason = (separator < 0 ? '' : targetSignature.slice(separator + 1)).trim()
  // `status` is chat-screen's `sendError ?? localized status`. A raw RPC/transport
  // string must never sit in the primary label, so it only feeds the long-press
  // detail and the screen-reader suffix; the visible status is always localized.
  const localizedStatus = targetState === 'unconfirmed'
    ? zhCN.chat.sendUnconfirmed
    : status === zhCN.chat.sendUnconfirmed ? zhCN.chat.sendUnconfirmed : zhCN.chat.sendFailed
  const reason = storeReason !== ''
    ? storeReason
    : status === zhCN.chat.sendFailed || status === zhCN.chat.sendUnconfirmed ? undefined : status
  const disabled = busyAction !== undefined || missingImages
  // One short row for the whole batch: a single failure names its status, a batch
  // leads with the count so the user can tell why one tap resends several rows.
  const label = missingImages
    ? zhCN.chat.resendImageMissing
    : `${ids.length > 1 ? `${ids.length} × ` : ''}${localizedStatus} · ${zhCN.chat.resend}`
  const retry = () => {
    const state = useAppStore.getState()
    const selected = state.selectedSession
    const backend = selected === undefined
      ? undefined
      : state.sessions.find(row => row.sessionId === selected.sessionId)?.backend ?? selected.backend
    const resend = async () => {
      for (const [index, id] of ids.entries()) {
        // Harness keeps `send-message` busy until the turn event acknowledges the
        // prompt, so wait (bounded) for that guard before the next row; only a
        // real refusal from the store stops the batch.
        if (index > 0 && !(await waitForResendIdle())) return
        if (!(await useAppStore.getState().retrySendMessage(id))) return
      }
    }
    // Harness dedupes by request rpcId (official hasPromptRequest), so only the
    // carriers without request ids need the double-execution warning.
    const unconfirmed = selected !== undefined && (state.messages[selected.sessionId] ?? []).some(row =>
      row.kind === 'message' && ids.includes(row.id) && row.sendState === 'unconfirmed')
    if (unconfirmed && backend !== undefined && backend !== 'harness') {
      Alert.alert(zhCN.chat.sendUnconfirmed, zhCN.chat.resendConfirm, [
        { text: zhCN.common.cancel, style: 'cancel' },
        { text: zhCN.chat.resend, onPress: () => { void resend() } },
      ])
    } else void resend()
  }
  // Long press surfaces the original transport cause that the inline label keeps
  // out of the way; an empty cause falls back to the existing retry explanation.
  const showReason = () => {
    Alert.alert(localizedStatus, reason ?? zhCN.chat.resendConfirm, [
      { text: zhCN.common.cancel, style: 'cancel' },
      { text: zhCN.chat.resend, onPress: retry },
    ])
  }
  // Batch stop-loss: with two or more undelivered notices the single retry row
  // also offers "clear all". The store deletes only local markers (a delivered
  // echo or an adopted queue row stays) and reports the removed/kept counts.
  const undeliveredCount = useAppStore(state => {
    const sessionId = state.selectedSession?.sessionId
    if (sessionId === undefined) return 0
    return (state.messages[sessionId] ?? []).filter(item => item.kind === 'message' && item.role === 'user'
      && item.nativeSeq === undefined
      && (item.sendState === 'failed' || item.sendState === 'unconfirmed' || item.sendState === 'canceled'
        || item.sendState === 'queued')).length
  })
  const clearAll = () => {
    Alert.alert(zhCN.chat.clearUndeliveredTitle, zhCN.chat.clearUndeliveredBody(undeliveredCount), [
      { text: zhCN.common.cancel, style: 'cancel' },
      {
        text: zhCN.chat.clearUndeliveredAction,
        style: 'destructive',
        onPress: () => {
          void useAppStore.getState().deleteUndeliveredMessages().then(result => {
            Alert.alert(zhCN.chat.clearUndeliveredTitle, zhCN.chat.clearUndeliveredDone(result.deleted, result.kept))
          })
        },
      },
    ])
  }
  return (
    <View style={localUserRowStyles.resendWrap}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={reason === undefined ? label : `${label}。${reason}`}
        accessibilityState={{ disabled }}
        disabled={disabled}
        hitSlop={8}
        onPress={retry}
        onLongPress={showReason}
        style={({ pressed }) => [styles.resendRow, compactResendStyles.row, pressed && !disabled && styles.resendRowPressed, disabled && styles.resendRowDisabled]}
      >
        <RefreshCw size={12} color={disabled ? colors.muted : colors.danger} />
        <Text numberOfLines={1} style={[styles.resendText, compactResendStyles.text, disabled && styles.resendTextMuted, !disabled && styles.resendTextFailed]}>
          {label}
        </Text>
      </Pressable>
      {undeliveredCount >= 2 && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={zhCN.chat.clearUndelivered(undeliveredCount)}
          hitSlop={8}
          onPress={clearAll}
          style={({ pressed }) => [localUserRowStyles.clearAll, pressed && styles.resendRowPressed]}
        >
          <Text style={[localUserRowStyles.clearAllText, { color: colors.danger }]}>{zhCN.chat.clearUndelivered(undeliveredCount)}</Text>
        </Pressable>
      )}
    </View>
  )
}

/**
 * The retry row is deliberately shorter than the shared 44 dp `resendRow`: this
 * conversation keeps exactly one of them at the bottom of the list. Local styles
 * are used because `chat/styles.ts` is owned by another in-flight change.
 */
const compactResendStyles = StyleSheet.create({
  row: { minHeight: 22, paddingVertical: 2, marginBottom: 2, alignSelf: 'flex-end' },
  text: { fontSize: 12, lineHeight: 16, flexShrink: 1 },
})

/**
 * Local-only removal for a user message the Host never delivered. The protocol
 * has no recall, so this affordance is deliberately limited to rows that still
 * carry `nativeSeq === undefined` (failed/unconfirmed/canceled/local queued).
 */
function UserRowDelete({ itemId }: { itemId: string }) {
  const { colors } = useTheme()
  const confirm = () => {
    Alert.alert(zhCN.chat.deleteMessageTitle, zhCN.chat.deleteMessageBody, [
      { text: zhCN.common.cancel, style: 'cancel' },
      {
        text: zhCN.common.delete,
        style: 'destructive',
        onPress: () => {
          void useAppStore.getState().deleteChatMessage(itemId).then(removed => {
            // Never fail silently: the row may have been delivered meanwhile.
            if (!removed) Alert.alert(zhCN.chat.deleteMessageFailedTitle, zhCN.chat.deleteMessageFailedBody)
          })
        },
      },
    ])
  }
  return (
    <View style={localUserRowStyles.actions}>
      <IconButton label={zhCN.chat.deleteMessage} icon={Trash2} dense tint={colors.muted} onPress={confirm} />
    </View>
  )
}

const localUserRowStyles = StyleSheet.create({
  outcome: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 2, alignSelf: 'flex-end' },
  actions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 10, marginTop: 6, minHeight: 28 },
  resendWrap: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', alignSelf: 'flex-end', gap: 6, flexWrap: 'wrap' },
  clearAll: { paddingHorizontal: 8, paddingVertical: 3, minHeight: 22, justifyContent: 'center' },
  clearAllText: { fontSize: 12, lineHeight: 16 },
})

/** Bounded pause between sequential retries; the store refuses while busy. */
const RESEND_SETTLE_TIMEOUT_MS = 4_000
async function waitForResendIdle(): Promise<boolean> {
  const deadline = Date.now() + RESEND_SETTLE_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (useAppStore.getState().busyAction === undefined) return true
    await new Promise<void>(resolve => setTimeout(resolve, 50))
  }
  return useAppStore.getState().busyAction === undefined
}
function HeartbeatMessage({ text, body }: { text: string; body: string }) {
  const [expanded, setExpanded] = useState(false)
  const { colors } = useTheme()
  const styles = useThemedStyles(createStyles)
  return <View>
    <NativeMarkdown text={body} />
    <Pressable accessibilityRole="button" accessibilityState={{ expanded }}
      onPress={() => setExpanded(value => !value)} style={styles.reasoningHeader}>
      <Code2 size={16} color={colors.muted} />
      <Text style={styles.reasoningLabel}>{expanded ? zhCN.chat.heartbeatCollapse : zhCN.chat.heartbeatExpand}</Text>
      {expanded ? <ChevronUp size={17} color={colors.muted} /> : <ChevronDown size={17} color={colors.muted} />}
    </Pressable>
    {expanded && <Text selectable style={styles.toolDetailCode}>{text}</Text>}
  </View>
}

/**
 * In-place free text selection on assistant prose (Figure 2 / IMG_1488).
 * Allows the user to freely select any snippet using native handles.
 * When text is selected, floating callout menu [询问智能体] [拷贝] appears
 * right above the selection.
 */
function AssistantMessageCallout({ item }: { item: ChatMessage }) {
  const styles = useThemedStyles(createStyles)
  const body = heartbeatMessageBody(item.text, 'assistant')
  return (
    <View style={styles.assistantProseWrap}>
      {body === undefined ? <NativeMarkdown text={item.text} /> : <HeartbeatMessage text={item.text} body={body} />}
    </View>
  )
}

function MessageBubble({ item, compact, artifacts, editedFiles, onFilePress, onSendPrompt, resendIds, resendStatus, resendMissingImages }: {
  item: ChatMessage
  compact: boolean
  artifacts?: UiArtifact[]
  editedFiles?: { path: string; name?: string; action?: 'created' | 'edited' }[]
  onFilePress?: (path: string) => void
  onSendPrompt?: (text: string) => Promise<boolean>
  resendIds?: string[]
  resendStatus?: string
  resendMissingImages?: boolean
}) {
  const { colors } = useTheme()
  const styles = useThemedStyles(createStyles)
  const user = item.role === 'user'
  const remote = item.role === 'assistant'
  const showReasoning = !compact && remote && hasVisibleMessageText(item.reasoning ?? '')
  const showText = hasVisibleMessageText(item.text)
  const showImages = item.images !== undefined && item.images.length > 0
  const showStreaming = item.streaming === true && item.streamingPhase !== 'reasoning'
  const hasArtifacts = artifacts !== undefined && artifacts.length > 0

  // Harness renders assistant prose directly on the conversation canvas.
  if (remote) {
    return (
      <View style={styles.assistantBlock}>
        {showReasoning && <ReasoningDisclosure item={item} />}
        {showImages && <ChatImages images={item.images!} />}
        {showText && (
          <AssistantMessageCallout item={item} />
        )}
        {showStreaming && (
          <View style={styles.assistantText}>
            <StreamingCursor />
          </View>
        )}
        {artifacts?.map(ui => (
          <IntelligentUiCard key={ui.hostId + ':' + ui.sessionId + ':' + ui.uiId} artifact={ui} onSendPrompt={onSendPrompt} />
        ))}
        {editedFiles?.length && onFilePress ? <PresentedFileGroup files={editedFiles} onFilePress={onFilePress} /> : null}
        {!item.streaming && (showText || hasArtifacts) && <MessageActions item={item} />}
      </View>
    )
  }

  if (user) {
    const undelivered = item.sendState === 'failed' || item.sendState === 'unconfirmed'
    // Only rows that never reached the Host can be removed locally; delivered
    // messages keep the protocol's no-recall semantics.
    const localUndelivered = item.nativeSeq === undefined
      && (undelivered || item.sendState === 'canceled')
    const heartbeatBody = heartbeatMessageBody(item.text, 'user')
    const { quotes, body } = parseMessageQuotes(item.text)
    return <View style={styles.userBlock}>
      <View style={styles.userContent}>
        {showImages && <ChatImages images={item.images!} alignEnd />}
        {heartbeatBody !== undefined ? <HeartbeatMessage text={item.text} body={heartbeatBody} /> : quotes.length > 0 ? (
          <View style={styles.userMessageInlineWrap}>
            {quotes.map((quoteText, index) => (
              <View key={`quote:${index}`} style={styles.composerInlineQuoteBadge}>
                <QuoteMarkIcon size={14} color={colors.linkText} />
                <Text numberOfLines={1} style={[styles.composerInlineQuoteText, { color: colors.linkText, maxWidth: 200 }]}>
                  “{formatQuoteDraftSnippet(quoteText, 16)}”
                </Text>
              </View>
            ))}
            {hasVisibleMessageText(body) && (
              <Text selectable style={styles.userMessageInlineText}>{body}</Text>
            )}
          </View>
        ) : (
          hasVisibleMessageText(body) && <Text selectable style={styles.userMessageInlineText}>{body}</Text>
        )}
      </View>
      {item.sendState === 'canceled'
        ? <View style={localUserRowStyles.outcome}>
          <Text style={styles.canceledText}>{zhCN.chat.sendCanceled}</Text>
          {localUndelivered && <UserRowDelete itemId={item.id} />}
        </View>
        : <>
          {/* One compact retry row for the whole conversation belongs to the
              newest undelivered row; older failures keep only their actions. */}
          {undelivered && resendIds !== undefined && resendStatus !== undefined && (
            <UserRowResend ids={resendIds} status={resendStatus} missingImages={resendMissingImages === true} />
          )}
          {/* Failed rows keep their actions: losing copy would be a regression.
              Undelivered rows may also be deleted from this device. */}
          <View style={localUserRowStyles.actions}>
            <MessageActions item={item} />
            {localUndelivered && <UserRowDelete itemId={item.id} />}
          </View>
        </>}
    </View>
  }

  return (
    <View style={[styles.messageRow, user && styles.messageRowUser]}>
      <View style={[styles.avatar, user ? styles.avatarUser : styles.avatarAssistant]}>
        {user ? (
          <User size={16} color={colors.white} />
        ) : (
          <Bot size={17} color={colors.primary} />
        )}
      </View>
      <View style={[styles.messageBody, user && styles.messageBodyUser]}>
        <Text style={styles.messageLabel}>{user ? zhCN.chat.you : zhCN.chat.system}</Text>
        {showImages && <ChatImages images={item.images!} alignEnd={user} />}
        {showText && <NativeMarkdown text={item.text} />}
        {showStreaming && <StreamingCursor />}
      </View>
    </View>
  )
}

function ReasoningDisclosure({ item }: { item: ChatMessage }) {
  const { colors } = useTheme()
  const styles = useThemedStyles(createStyles)
  const { height } = useWindowDimensions()
  const [expanded, setExpanded] = useState(false)
  const active = item.streamingPhase === 'reasoning'
  const label = active ? zhCN.chat.reasoningActive : zhCN.chat.reasoning
  const preview = compactActivityText(item.reasoning) ?? ''
  const actionLabel = expanded ? zhCN.chat.reasoningCollapse : zhCN.chat.reasoningExpand
  return (
    <View style={styles.reasoningCard}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${actionLabel}。${preview}`}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(value => !value)}
        style={({ pressed }) => [styles.reasoningHeader, pressed && styles.reasoningHeaderPressed]}
      >
        <Sparkles size={16} color={active ? colors.accent : colors.muted} />
        <Text style={[styles.reasoningLabel, active && styles.reasoningLabelActive]}>{label}</Text>
        <Text style={styles.activitySeparator}>·</Text>
        <Text style={styles.reasoningPreview} numberOfLines={1}>{preview}</Text>
        {expanded
          ? <ChevronDown size={17} color={colors.muted} />
          : <ChevronRight size={17} color={colors.muted} />}
      </Pressable>
      {expanded && <View style={styles.reasoningBody}>
        <ScrollView style={{ maxHeight: Math.min(320, height * 0.4) }} nestedScrollEnabled>
          <NativeMarkdown text={item.reasoning ?? ''} />
        </ScrollView>
        <CollapseBar onPress={() => setExpanded(false)} />
      </View>}
    </View>
  )
}

function ToolRow({ item: original, compact }: { item: ToolActivity; compact: boolean }) {
  const [loaded, setLoaded] = useState<ToolActivity>()
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [detailError, setDetailError] = useState<string>()
  const detailAbort = useRef<AbortController | undefined>(undefined)
  const item = loaded ?? original
  useEffect(() => {setLoaded(undefined); setLoadingDetail(false); setDetailError(undefined); return () => detailAbort.current?.abort()}, [original.remoteDetail?.detailId])
  const loadDetail = async () => {
    if (loadingDetail || loaded !== undefined || original.remoteDetail === undefined) return
    const controller = new AbortController(); detailAbort.current = controller
    setLoadingDetail(true); setDetailError(undefined)
    try {
      const record = await readToolHistoryDetail(original.remoteDetail, controller.signal) as {event: import('../../types').NativeSessionEvent; view?: import('../../types').HistoryEntry['view']}
      if (controller.signal.aborted) return
      const full = foldHistory([record], original.sessionId).find(row => row.kind === 'tool' && row.id === original.id)
      if (full?.kind !== 'tool') throw new Error(zhCN.comfort.toolInvalid)
      setLoaded({...original, ...full, callDetail: original.callDetail, remoteDetail: undefined})
    } catch (error) {if (!controller.signal.aborted) setDetailError(error instanceof Error ? error.message : zhCN.comfort.toolUnavailable)}
    finally {if (!controller.signal.aborted) setLoadingDetail(false)}
  }
  const { colors } = useTheme()
  const styles = useThemedStyles(createStyles)
  const { height } = useWindowDimensions()
  const [expanded, setExpanded] = useState(false)
  const stateText = item.state === 'running' ? zhCN.status.running : item.state === 'failed' ? zhCN.chat.failed : zhCN.chat.completed
  const detail = processDetail(item)
  const name = toolDisplayName(item)
  const hasDetail = (item.callDetail !== undefined || item.resultDetail !== undefined || item.remoteDetail !== undefined)
  return (
    <View style={[styles.toolCard, expanded && styles.toolCardExpanded]}>
      <Pressable
        accessibilityRole={hasDetail ? 'button' : undefined}
        accessibilityLabel={hasDetail ? (expanded ? zhCN.chat.toolCollapse(name) : zhCN.chat.toolExpand(name)) : undefined}
        accessibilityState={hasDetail ? { expanded } : undefined}
        disabled={!hasDetail}
        onPress={() => {if (!expanded) void loadDetail(); setExpanded(value => !value)}}
        style={({ pressed }) => [styles.toolRow, pressed && hasDetail && styles.toolRowPressed]}
      >
        <View style={styles.toolIcon}>
          {item.toolName === 'todo_write' || (item.toolKey ?? '').endsWith('todo_write') ? (
            <IconChecklistOutline size={16} color={colors.primary} />
          ) : /command|bash|shell|命令|终端/i.test(item.toolName) ? (
            <Terminal size={16} color={colors.muted} />
          ) : (
            <Code2 size={16} color={colors.muted} />
          )}
        </View>
        <View style={styles.toolCopy}>
          <Text style={styles.toolName} numberOfLines={1}>{name}</Text>
          {detail !== undefined && <Text style={styles.activitySeparator}>·</Text>}
          {detail !== undefined && <Text style={styles.toolSummary} numberOfLines={1}>{detail}</Text>}
        </View>
        {item.state === 'failed' && <Text style={styles.toolFailed}>{stateText}</Text>}
        {hasDetail && (expanded
          ? <ChevronDown size={17} color={colors.muted} />
          : <ChevronRight size={17} color={colors.muted} />)}
      </Pressable>
      {item.images !== undefined && item.images.length > 0 && <ChatImages images={item.images} tool />}
      {expanded && hasDetail && (
        <View style={styles.toolDetails}>
          <ScrollView style={{ maxHeight: Math.min(320, height * 0.4) }} nestedScrollEnabled>
            {loadingDetail && <Text>{zhCN.comfort.toolLoading}</Text>}
            {detailError !== undefined && <Pressable accessibilityRole="button" onPress={() => void loadDetail()}><Text>{detailError} · {zhCN.common.retry}</Text></Pressable>}
            {item.callDetail !== undefined && <ToolDetailView label={zhCN.chat.toolCall} detail={item.callDetail} />}
            {item.resultDetail !== undefined && <ToolDetailView label={zhCN.chat.toolResult} detail={item.resultDetail} />}
          </ScrollView>
          <CollapseBar onPress={() => setExpanded(false)} label={zhCN.chat.toolCollapse(name)} />
        </View>
      )}
    </View>
  )
}

export function ChatImages({ images, alignEnd = false, tool = false }: { images: ChatImage[]; alignEnd?: boolean; tool?: boolean }) {
  const styles = useThemedStyles(createStyles)
  return (
    <View style={[styles.messageImages, alignEnd && styles.messageImagesUser, tool && styles.toolImages]}>
      {images.map((image, index) => <ChatImageView key={`${image.attachmentId ?? image.name ?? 'image'}:${index}`} image={image} />)}
    </View>
  )
}

function ToolDetailView({ label, detail }: { label: string; detail: ToolDisplayDetail }) {
  const { colors } = useTheme()
  const styles = useThemedStyles(createStyles)
  return (
    <View style={styles.toolDetailBlock}>
      <Text style={styles.toolDetailLabel}>{label}</Text>
      {detail.format === 'markdown'
        ? <NativeMarkdown text={detail.text} />
        : <Text selectable style={styles.toolDetailCode}>{detail.text}</Text>}
      {detail.truncated && <Text style={styles.toolDetailTruncated}>{zhCN.chat.toolTruncated}</Text>}
    </View>
  )
}

function compactActivityText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const compact = value.replace(/\\[nrt]/g, ' ').replace(/\s+/g, ' ').trim()
  return compact.length === 0 ? undefined : compact
}

function ApprovalCard({ item, busy, onRespond }: {
  item: ApprovalActivity
  busy: boolean
  onRespond: (itemId: string, outcome: 'allowed-once' | 'rejected') => Promise<void>
}) {
  const { colors } = useTheme()
  const styles = useThemedStyles(createStyles)
  if (item.outcome !== undefined) {
    const denied = item.outcome === 'rejected' || item.outcome === 'cancelled' || item.outcome === 'unavailable'
    const handledElsewhere = item.outcome === 'unavailable'
    return (
      <View style={styles.permissionResolved}>
        {denied && !handledElsewhere ? <X size={18} color={colors.danger} /> : <Check size={18} color={colors.success} />}
        <Text style={styles.permissionResolvedText}>{handledElsewhere ? zhCN.chat.approvalHandled : denied ? zhCN.chat.denied : zhCN.chat.allowedOnce}</Text>
      </View>
    )
  }
  return (
    <View style={styles.permissionCard} accessibilityRole="alert">
      <View style={styles.permissionHeader}>
        <View style={styles.permissionIcon}><ShieldAlert size={20} color={colors.warning} /></View>
        <View style={styles.permissionHeaderCopy}>
          <Text style={styles.permissionTitle}>{zhCN.chat.permissionTitle}</Text>
          <Text style={styles.permissionKind}>{zhCN.chat.hostOperation(item.toolName)}</Text>
        </View>
      </View>
      {item.reason !== undefined && (
        <View style={styles.permissionDetail}>
          <Text selectable style={styles.permissionText}>{item.reason}</Text>
        </View>
      )}
      <Text style={styles.permissionScope}>{zhCN.chat.permissionScope}</Text>
      <View style={styles.permissionActions}>
        <Button label={zhCN.chat.allowOnce} onPress={() => void onRespond(item.id, 'allowed-once')} loading={busy} />
        <Button label={zhCN.chat.deny} variant="quiet" onPress={() => void onRespond(item.id, 'rejected')} disabled={busy} />
      </View>
    </View>
  )
}

function QuestionCard({ item, busy, onRespond }: {
  item: QuestionActivity
  busy: boolean
  onRespond: (itemId: string, selected: Record<string, string[]>, custom?: Record<string, string>) => Promise<void>
}) {
  const { colors } = useTheme()
  const styles = useThemedStyles(createStyles)
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  const [custom, setCustom] = useState<Record<string, string>>({})
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (item.deadline === undefined || item.outcome !== undefined) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [item.deadline, item.outcome])
  const remaining = item.deadline === undefined ? undefined : Math.max(0, Math.ceil((item.deadline - now) / 1000))

  if (item.outcome !== undefined) {
    return (
      <View style={styles.permissionResolved}>
        <Check size={18} color={colors.success} />
        <Text style={styles.permissionResolvedText}>{item.outcome === 'answered' ? zhCN.chat.answered : item.outcome === 'queued' ? zhCN.chat.questionQueued : zhCN.chat.questionCancelled}</Text>
      </View>
    )
  }

  const toggle = (questionId: string, label: string, multi: boolean) => {
    const values = selected[questionId] ?? []
    const next = multi
      ? (values.includes(label) ? values.filter(value => value !== label) : [...values, label])
      : values.includes(label) ? [] : [label]
    // Custom text is mutually exclusive with a selection: clear it only when an
    // option becomes selected, never when the user merely deselects.
    if (!multi && next.length > 0) {
      setCustom(current => (current[questionId] ?? '') === '' ? current : { ...current, [questionId]: '' })
    }
    setSelected(current => ({ ...current, [questionId]: next }))
  }

  const allAnswered = item.questions.every(question => (selected[question.id] ?? []).length > 0
    || (custom[question.id] ?? '').trim().length > 0)

  return (
    <View style={styles.questionCard} accessibilityRole="alert">
      <View style={styles.permissionHeader}>
        <View style={styles.permissionIcon}><ShieldAlert size={20} color={colors.accent} /></View>
        <View style={styles.permissionHeaderCopy}>
          <Text style={styles.permissionTitle}>{zhCN.chat.questionTitle}</Text>
          <Text style={styles.permissionKind}>{item.questionState === 'continued' ? zhCN.chat.questionContinued : remaining === undefined ? zhCN.chat.answerToContinue : zhCN.chat.questionRemaining(remaining)}</Text>
        </View>
      </View>
      {item.questions.map(question => (
        <View key={question.id} style={styles.questionBlock}>
          <Text style={styles.questionText}>{question.question}</Text>
          {question.detail !== undefined && <Text selectable style={styles.questionDetail}>{question.detail}</Text>}
          {(question.options ?? []).map(option => {
            const chosen = (selected[question.id] ?? []).includes(option.label)
            return (
              <Pressable
                key={option.label}
                accessibilityRole="button"
                accessibilityState={{ selected: chosen }}
                onPress={() => toggle(question.id, option.label, question.multiSelect === true)}
                style={[styles.optionRow, chosen && styles.optionChosen]}
              >
                <View style={[styles.optionDot, chosen && styles.optionDotChosen]}>{chosen && <Check size={12} color={colors.white} />}</View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.optionLabel}>{option.label}</Text>
                  {option.description !== undefined && (
                    <Text style={styles.optionDescription}>{option.description}</Text>
                  )}
                </View>
              </Pressable>
            )
          })}
          <TextInput
            style={styles.questionCustom}
            accessibilityLabel={zhCN.chat.questionCustomPlaceholder}
            placeholder={zhCN.chat.questionCustomPlaceholder}
            placeholderTextColor={colors.muted}
            value={custom[question.id] ?? ''}
            onChangeText={text => {
              // Official semantics: a single-select question keeps selection and
              // custom text mutually exclusive; multi-select allows both.
              if (question.multiSelect !== true && text.trim().length > 0) {
                setSelected(current => ({ ...current, [question.id]: [] }))
              }
              setCustom(current => ({ ...current, [question.id]: text }))
            }}
            multiline
          />
        </View>
      ))}
      <Button label={zhCN.chat.submitAnswer} onPress={() => void onRespond(item.id, selected, custom)} loading={busy} disabled={!allAnswered || (item.questionState === 'open' && remaining === 0)} />
    </View>
  )
}

/** Compact DSH QueueDock mirror: queued prompts waiting for the next turn. */
export function QueueDock({ items }: { items: QueueDockItem[] }) {
  const { colors } = useTheme()
  const styles = useThemedStyles(createStyles)
  const [busyKey, setBusyKey] = useState<string>()
  // A local queued row can be shown before the Host inbox projection admits it
  // into a row with an id. Resolve by rpcId with a bounded wait so the dock can
  // still steer/remove on the Host instead of rendering no action at all.
  const hostItemId = async (item: QueueDockItem): Promise<string | undefined> => {
    if (item.id !== undefined) return item.id
    if (item.rpcId === undefined) return undefined
    return await useAppStore.getState().resolveQueuedHostItemId(item.rpcId)
  }
  const run = async (key: string, action: () => Promise<void>) => {
    if (busyKey !== undefined) return
    setBusyKey(key)
    try {
      await action()
    } finally {
      setBusyKey(undefined)
    }
  }
  const reportFailure = (reason?: string) => {
    Alert.alert(
      zhCN.chat.queueActionUnavailableTitle,
      reason ?? useAppStore.getState().error ?? zhCN.chat.queueActionUnavailableBody,
    )
  }
  const steer = (item: QueueDockItem, key: string) => void run(key, async () => {
    const id = await hostItemId(item)
    if (id === undefined) return reportFailure(zhCN.chat.queueActionUnavailableBody)
    const accepted = await useAppStore.getState().updateQueueItem(id, 'steer', item.rpcId)
    if (!accepted) reportFailure()
  })
  const remove = (item: QueueDockItem, key: string) => void run(key, async () => {
    const id = await hostItemId(item)
    if (id !== undefined) {
      const accepted = await useAppStore.getState().updateQueueItem(id, 'remove', item.rpcId)
      if (!accepted) reportFailure()
      return
    }
    // No Host row exists yet, so a Host-side removal is impossible. Offer the
    // device-local removal with an explicit caveat instead of a dead button.
    if (item.messageId === undefined) return reportFailure(zhCN.chat.queueActionUnavailableBody)
    Alert.alert(zhCN.chat.queueLocalRemoveTitle, zhCN.chat.queueLocalRemoveBody, [
      { text: zhCN.common.cancel, style: 'cancel' },
      {
        text: zhCN.chat.queueRemove,
        style: 'destructive',
        onPress: () => {
          void useAppStore.getState().deleteChatMessage(item.messageId!)
            .then(removed => { if (!removed) reportFailure() })
        },
      },
    ])
  })
  return (
    <View style={styles.queueDock} accessibilityRole="summary" accessibilityLabel={zhCN.chat.queueTitle(items.length)}>
      <View style={styles.queueDockHeader}>
        <ListTree size={14} color={colors.primary} />
        <Text style={styles.queueDockTitle}>{zhCN.chat.queueTitle(items.length)}</Text>
      </View>
      {items.map((item, index) => {
        const key = item.key ?? item.id ?? item.messageId ?? `queue:${index}`
        return (
          <View key={key} style={styles.queueDockRow}>
            <Text style={styles.queueDockText} numberOfLines={1}>{item.preview.trim().length > 0 ? item.preview.trim() : zhCN.chat.queuePending}</Text>
            {item.local === true && <Text style={[localQueueStyles.localTag, { color: colors.muted }]}>{zhCN.chat.queueLocalPending}</Text>}
            {busyKey === key
              ? <ActivityIndicator size="small" color={colors.primary} />
              : <>
                {/* The stop-loss path: without remove/steer a mis-queued prompt can
                    only be stopped by killing the running task (official QueueDock
                    offers edit/remove/steer per row). Both actions stay rendered for
                    every row; a row without a Host id falls back to a local cancel
                    with an explanation rather than showing an empty trailing area. */}
                <IconButton label={zhCN.chat.queueSteer} icon={ArrowUp} dense onPress={() => steer(item, key)} />
                <IconButton label={zhCN.chat.queueRemove} icon={X} dense onPress={() => remove(item, key)} />
              </>}
          </View>
        )
      })}
    </View>
  )
}

const localQueueStyles = StyleSheet.create({
  localTag: { fontSize: 11, marginRight: 2, flexShrink: 0 },
})

export function WelcomeMessage() {
  const styles = useThemedStyles(createStyles)
  const { width } = useWindowDimensions()
  // Official empty state is one centered greeting: no logo, no badge, no slogan.
  return (
    <View style={styles.welcome} accessibilityRole="header">
      <Text style={[styles.welcomeGreeting, width >= 440 && styles.welcomeGreetingWide]}>
        {zhCN.chat.welcomeGreeting}
      </Text>
    </View>
  )
}

function StreamingCursor() {
  const opacity = useRef(new Animated.Value(1)).current
  const styles = useThemedStyles(createStyles)

  useEffect(() => {
    const animation = Animated.loop(Animated.sequence([
      Animated.timing(opacity, { toValue: 0.2, duration: 450, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 1, duration: 450, useNativeDriver: true }),
    ]))
    animation.start()
    return () => animation.stop()
  }, [opacity])

  return <Animated.View style={[styles.streamingCursor, { opacity }]} accessibilityLabel={zhCN.chat.generating} />
}

export function ReplyStatusDots() {
  const { colors } = useTheme()
  const styles = useThemedStyles(createStyles)
  const progress = useRef(new Animated.Value(0)).current
  const [reduceMotion, setReduceMotion] = useState(false)

  useEffect(() => {
    let mounted = true
    void AccessibilityInfo.isReduceMotionEnabled().then(enabled => {
      if (mounted) setReduceMotion(enabled)
    })
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion)
    return () => {
      mounted = false
      subscription.remove()
    }
  }, [])

  useEffect(() => {
    if (reduceMotion) return
    const animation = Animated.loop(Animated.timing(progress, {
      toValue: 3,
      duration: 900,
      useNativeDriver: true,
    }))
    animation.start()
    return () => animation.stop()
  }, [progress, reduceMotion])

  return (
    <View style={styles.replyDots} importantForAccessibility="no-hide-descendants">
      {[0, 1, 2].map(index => (
        <Animated.Text
          key={index}
          style={[styles.replyDot, {
            color: colors.accent, opacity: reduceMotion ? 1 : progress.interpolate({
              inputRange: [index, index + 0.5, index + 1],
              outputRange: [0.25, 1, 0.25],
              extrapolate: 'clamp',
            })
          }]}
        >·</Animated.Text>
      ))}
    </View>
  )
}

export function isActiveChatItem(item: ChatItem): boolean {
  if (item.turnEnd !== undefined) return false
  if (item.kind === 'message') return item.streaming === true
  if (item.kind === 'tool') return item.state === 'running'
  if (item.kind === 'approval' || item.kind === 'question') return item.outcome === undefined
  return false
}
