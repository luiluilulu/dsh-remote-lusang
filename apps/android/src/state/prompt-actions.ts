import * as Haptics from 'expo-haptics'
import { friendlyError, isRecoverableTransportError, isRpcTimeoutError } from '../lib/errors'
import { strings as zhCN } from '../locales/i18n'
import { createNativeRpcId } from '../services/rpc-id'
import {
  codexPermissionPresetFromResponse,
  codexThreadId,
  readCodexHistoryPage,
} from '../services/codex'
import { cursorNativeId } from '../services/cursor'
import { browseScope, saveSessionMessagesSnapshot } from '../services/browse-memory'
import type { ChatItem } from '../types'
import { withCodexPermissionState } from './codex-session-state'
import { pruneDeliveredLocalDuplicates } from './event-reducer'
import { findApproval, findQuestion, inboxQueuedItems, inboxRpcIds, mapApprovalOutcome, mapQuestionAnswered } from './message-helpers'
import type { SessionAccess } from './session-runtime'
import { isRecord, record, stringValue, withActiveCodexTurn } from './session-state'
import type { AppState } from './store-state'

/** How long a local queued prompt waits for its Host inbox row before acting locally. */
const QUEUE_ADOPTION_WAIT_MS = 1_500
const QUEUE_ADOPTION_POLL_MS = 100

/** Local undelivered user rows that the delete affordances may hide. */
function isLocallyUndeliveredUserRow(item: ChatItem): boolean {
  if (item.kind !== 'message' || item.role !== 'user' || item.nativeSeq !== undefined) return false
  return item.sendState === 'failed' || item.sendState === 'unconfirmed' || item.sendState === 'canceled'
    || (item.sendState === 'queued' && item.queuedAdopted !== true)
}

/** Prompt actions use the store's single connection/session runtime. */
export function createPromptActions({ get, set, runtime }: SessionAccess): Pick<AppState,
  'sendMessage' | 'updateQueueItem' | 'resolveQueuedHostItemId' | 'deleteChatMessage' | 'deleteUndeliveredMessages'
  | 'pruneDeliveredLocalDuplicates' | 'retrySendMessage' | 'stopSession' | 'respondApproval' | 'respondQuestion'> {
  /** Keep the in-memory transcript and the local browse snapshot in sync. */
  const commitSessionMessages = (sessionId: string, next: ChatItem[]): void => {
    set(state => ({ messages: { ...state.messages, [sessionId]: next } }))
    const state = get()
    if (state.config?.baseUrl === undefined || state.selectedDevice?.identityKey === undefined) return
    try {
      saveSessionMessagesSnapshot(browseScope(state), sessionId, next)
    } catch {
      // The snapshot is a convenience cache; the in-memory transcript is truth.
    }
  }
  return {
    async sendMessage(input, images = [], reuseRpcId) {
      if (get().busyAction?.startsWith('session:')) return 'rejected'
      runtime.flushPendingMuxFrames()
      set({ commandResult: undefined })
      const session = get().selectedSession
      const text = input.trim()
      if (session === undefined || (text.length === 0 && images.length === 0)) return 'rejected'
      // The Codex live stream carries turn events; a Prompt sent while it is
      // missing would run on the Host but never display a reply. The previous
      // code returned silently, so the composer restored the draft with no
      // explanation. Surface an actionable reason instead (chat screen shows
      // `state.error` for a rejected send) and keep the no-mutation contract.
      const codexNotReady = session.backend === 'codex' && (get().connection.phase !== 'connected'
        || get().codexReadySessionId !== session.sessionId || runtime.activeCodexStream === undefined
        || runtime.activeCodexTimeline?.session.nativeId !== codexThreadId(session))
      if (codexNotReady) {
        set({
          error: get().connection.phase !== 'connected'
            ? CODEX_OFFLINE_MESSAGE
            : CODEX_SESSION_NOT_READY_MESSAGE,
        })
        return 'rejected'
      }
      if ((session.backend === undefined || session.backend === 'harness') && /^\/(?:file|goal|plan|feedback|compact|export)(?:\s|$)/u.test(text)) {
        set({ busyAction: 'command', error: undefined })
        try {
          // Commands are not prompts: never fabricate an optimistic user turn.
          if (images.length > 0) throw new Error(zhCN.messageActions.unavailable)
          const result = await runtime.connection.requireProxy().sessionExecuteCommand(session.sessionId, text)
          if (result.kind === 'error') throw new Error(result.text ?? zhCN.messageActions.failed)
          set({
            busyAction: undefined, commandResult: result.text?.trim()
              ? { sessionId: session.sessionId, text: result.text } : undefined
          })
          return 'sent'
        } catch (error) {
          set({ busyAction: undefined, error: friendlyError(error) })
          return 'rejected'
        }
      }
      const requestRpcId = reuseRpcId ?? createNativeRpcId()
      // DSH semantics (`ui-conversation.busyEnter`): while a turn is active a
      // prompt is queued (`mode:'queue'`), not merged into the running turn.
      const queuedAtSend = session.running === true || get().busyAction === 'send-message'
      const optimistic: ChatItem = {
        kind: 'message',
        // `local:` prefix is load-bearing for mergeCodexLive's optimistic matching;
        // the rpcId suffix keeps the id unique when several prompts are queued in
        // the same millisecond (duplicate keys corrupt the merged timeline).
        id: `local:${requestRpcId}`,
        sessionId: session.sessionId,
        role: 'user',
        text,
        ...(images.length === 0 ? {} : { images: images.map(image => ({ uri: image.uri, name: image.name })) }),
        createdAt: Date.now(),
        requestRpcId,
        // Retry material travels with the row (not a module map) so image rows
        // stay resendable across reconnects and cannot leak after cleanup.
        promptImages: images,
      }
      set(state => ({
        messages: {
          ...state.messages, [session.sessionId]: [
            ...(state.messages[session.sessionId] ?? []).filter(item => item.id !== optimistic.id),
            optimistic,
          ]
        },
        busyAction: 'send-message',
        error: undefined,
      }))
      try {
        if (session.backend === 'codex') {
          const client = runtime.connection.requireCodex()
          const threadId = codexThreadId(session)
          const promptInput = [
            ...(text.length === 0 ? [] : [{ type: 'text', text }]),
            ...images.map(image => ({ type: 'image', mediaType: image.mediaType, data: image.data })),
          ]
          const activeTurnId = runtime.activeCodexTimeline?.session.nativeId === threadId
            ? runtime.activeCodexTimeline.activeTurnId
            : undefined
          if (activeTurnId !== undefined) {
            await client.request('turn/steer', { threadId, expectedTurnId: activeTurnId, input: promptInput })
          } else {
            const selection = get().sessionModels?.current
            // Continuing a thread inherits its current Host policy. Permission
            // overrides belong to selectPermission, where the user changes it.
            const resumeResult = await client.request('thread/resume', {
              threadId,
              ...(selection?.provider === 'codex' ? { model: selection.model } : {}),
            })
            const serverPreset = codexPermissionPresetFromResponse(resumeResult)
            if (serverPreset !== undefined) {
              set(state => withCodexPermissionState(state, session.sessionId, serverPreset))
            }
            const result = record(await client.request('turn/start', {
              threadId,
              input: promptInput,
              ...(selection?.provider === 'codex' ? {
                model: selection.model,
                ...(selection.reasoningEffort === undefined ? {} : { effort: selection.reasoningEffort }),
              } : {}),
            }))
            const turnId = stringValue(record(result.turn).id)
            if (runtime.activeCodexTimeline?.session.nativeId === threadId) {
              runtime.activeCodexTimeline = {
                ...runtime.activeCodexTimeline,
                ...(turnId === undefined ? {} : { activeTurnId: turnId }),
                session: { ...runtime.activeCodexTimeline.session, status: 'running' },
              }
            }
            set(state => ({
              sessions: state.sessions.map(item => item.sessionId === session.sessionId ? { ...item, running: true } : item),
              selectedSession: state.selectedSession?.sessionId === session.sessionId
                ? { ...state.selectedSession, running: true }
                : state.selectedSession,
            }))
          }
        } else if (session.backend === 'cursor' || session.backend === 'antigravity' || session.backend === 'pi' || session.backend === 'opencode' || session.backend === 'claude' || session.backend === 'hermes') {
          if (session.backend === 'cursor' && images.length > 0) throw new Error(zhCN.runtime.cursorTextOnly)
          if (session.backend === 'pi' && images.length > 0) throw new Error(zhCN.runtime.piTextOnly)
          // Always re-bind the ACP stream on the current RemoteClientCore before
          // prompting. After WebRTC flaps / Metro reload the module-level handle
          // can point at a dead core while RPC still works on a new one.
          const streamGeneration = runtime.sessionLoadGeneration
          await runtime.ensureCursorStream(session, () => streamGeneration === runtime.sessionLoadGeneration
            && get().selectedSession?.sessionId === session.sessionId)
          set(state => ({
            sessions: state.sessions.map(item => item.sessionId === session.sessionId ? { ...item, running: true, blank: false, title: item.blank ? text.slice(0, 60) || zhCN.chat.unnamedImage : item.title } : item),
            selectedSession: state.selectedSession?.sessionId === session.sessionId
              ? { ...state.selectedSession, running: true, blank: false, title: state.selectedSession.blank ? text.slice(0, 60) || zhCN.chat.unnamedImage : state.selectedSession.title }
              : state.selectedSession,
          }))
          // Host may return immediately with stopReason=in_progress so frames can
          // interleave; keep running until prompt_completed / failure.
          const acpClient = session.backend === 'claude' ? runtime.connection.requireClaude() : session.backend === 'hermes' ? runtime.connection.requireHermes() : session.backend === 'opencode'
            ? runtime.connection.requireOpencode()
            : session.backend === 'pi'
              ? runtime.connection.requirePi()
              : session.backend === 'antigravity' ? runtime.connection.requireAntigravity() : runtime.connection.requireCursor()
          const promptResult = await acpClient.prompt(cursorNativeId(session), text, undefined, images.map(image => ({
            type: 'image' as const, mimeType: image.mediaType, data: image.data,
          })), session.backend)
          const inProgress = isRecord(promptResult)
            && promptResult.accepted === true
            && promptResult.stopReason === 'in_progress'
          if (!inProgress) {
            set(state => ({
              sessions: state.sessions.map(item => item.sessionId === session.sessionId ? { ...item, running: false } : item),
              selectedSession: state.selectedSession?.sessionId === session.sessionId
                ? { ...state.selectedSession, running: false }
                : state.selectedSession,
            }))
          }
        } else {
          await runtime.connection.requireProxy().sessionPrompt(session.sessionId, text, requestRpcId, images)
          // `session.prompt` acknowledges receipt only; keep busyAction until the
          // event stream shows the turn starting. When a turn was already active
          // the Host queued the prompt (`inbox` projection is authoritative), so
          // the row leaves the timeline and appears in the queue dock.
          set(state => {
            const latest = state.selectedSession?.sessionId === session.sessionId
              ? state.selectedSession : state.sessions.find(item => item.sessionId === session.sessionId)
            const inInbox = inboxRpcIds(latest?.projections?.values?.inbox).has(requestRpcId)
            return {
              messages: {
                ...state.messages,
                [session.sessionId]: (state.messages[session.sessionId] ?? []).map(item =>
                  item.id === optimistic.id && item.kind === 'message' && item.sendState !== 'canceled'
                    ? {
                      ...item,
                      // A projection may already have queued or released this
                      // row while the acknowledgement was still in flight.
                      sendState: item.queuedAdopted === true ? item.sendState
                        : inInbox ? 'queued' : item.sendState ?? (queuedAtSend ? 'queued' : undefined),
                      ...(inInbox ? { queuedAdopted: true as const } : {}),
                    }
                    : item),
              },
            }
          })
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
          return 'sent'
        }
        set({ busyAction: undefined })
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
        return 'sent'
      } catch (error) {
        // Keep the row as the single error surface (inline state + retry). A
        // deleted row plus a Host that already accepted the prompt is exactly the
        // "message vanished / reappears after reload" mismatch; timeout/transport
        // errors leave the outcome unknown and must never be judged by timers.
        const unconfirmed = isRpcTimeoutError(error) || isRecoverableTransportError(error)
        // The Codex writer is an exclusive cross-process lease. When the desktop
        // Codex app holds it, the Host rejects the Prompt as CODEX_THREAD_BUSY;
        // show an actionable reason + keep the retryable row instead of a raw
        // English upstream message.
        const busyMessage = codexBusyMessage(error)
        set(state => ({
          messages: {
            ...state.messages,
            [session.sessionId]: (state.messages[session.sessionId] ?? []).map(item =>
              item.id === optimistic.id && item.kind === 'message'
                && item.queuedAdopted !== true && item.sendState !== 'canceled'
                ? { ...item, sendState: unconfirmed ? 'unconfirmed' : 'failed', sendError: busyMessage ?? friendlyError(error) }
                : item),
          },
          // Only a deterministic failure may claim the agent is idle again; an
          // unconfirmed outcome leaves `running` untouched (the prompt may have
          // started on the Host).
          ...((session.backend === 'cursor' || session.backend === 'antigravity' || session.backend === 'pi' || session.backend === 'opencode' || session.backend === 'claude' || session.backend === 'hermes') && !unconfirmed ? {
            sessions: state.sessions.map(item => item.sessionId === session.sessionId ? { ...item, running: session.running ?? false } : item),
            selectedSession: state.selectedSession?.sessionId === session.sessionId ? { ...state.selectedSession, running: session.running ?? false } : state.selectedSession,
          } : {}),
          busyAction: undefined,
        }))
        return 'kept'
      }
    },

    async updateQueueItem(itemId, action, rpcId) {
      runtime.flushPendingMuxFrames()
      const session = get().selectedSession
      // Harness rows may carry `backend: undefined`; only the explicit non-harness
      // backends lack queue actions. The previous strict `'harness'` check silently
      // short-circuited every plain harness session — the queue buttons did
      // nothing with no error.
      if (session === undefined || (session.backend !== undefined && session.backend !== 'harness')
        || get().connection.phase !== 'connected') return false
      try {
        await runtime.connection.requireProxy().sessionUpdateQueue(session.sessionId, itemId, { kind: action })
      } catch (error) {
        set({ error: friendlyError(error) })
        return false
      }
      // Settle the matching local optimistic row together with the Host queue:
      // the dock lists local `queued` rows the inbox has not adopted, so without
      // this the steered/removed item is immediately re-listed from local state
      // and the buttons look like no-ops. Steer hands the row back to the
      // timeline (its echo replaces it); remove retires it quietly.
      if (rpcId !== undefined) {
        set(state => ({
          messages: {
            ...state.messages,
            [session.sessionId]: (state.messages[session.sessionId] ?? []).map(item =>
              item.kind === 'message' && item.requestRpcId === rpcId && item.id.startsWith('local:')
                && item.nativeSeq === undefined && (item.sendState === 'queued' || item.sendState === 'unconfirmed')
                ? { ...item, queuedAdopted: true, sendState: action === 'steer' ? 'unconfirmed' as const : 'canceled' as const, sendError: undefined }
                : item),
          },
        }))
      }
      return true
    },

    async resolveQueuedHostItemId(rpcId) {
      // A local `queued` row can be shown before the Host inbox projection
      // admits it into a row with an id. Wait a bounded moment (applying mux
      // frames as they arrive) so the dock can still address the Host row
      // instead of only offering a local remove.
      const session = get().selectedSession
      if (session === undefined || session.backend !== undefined && session.backend !== 'harness'
        || get().connection.phase !== 'connected' || rpcId.length === 0) return undefined
      const deadline = Date.now() + QUEUE_ADOPTION_WAIT_MS
      while (true) {
        runtime.flushPendingMuxFrames()
        const current = get().selectedSession?.sessionId === session.sessionId
          ? get().selectedSession
          : get().sessions.find(item => item.sessionId === session.sessionId)
        const id = inboxQueuedItems(current?.projections?.values?.inbox)
          .find(item => item.rpcId === rpcId)?.id
        if (id !== undefined) return id
        if (Date.now() >= deadline) return undefined
        await new Promise<void>(resolve => setTimeout(resolve, QUEUE_ADOPTION_POLL_MS))
      }
    },

    async deleteChatMessage(itemId) {
      runtime.flushPendingMuxFrames()
      const session = get().selectedSession
      if (session === undefined) return false
      const rows = get().messages[session.sessionId] ?? []
      const row = rows.find(item => item.id === itemId)
      // Only local rows can be hidden; the Host protocol has no recall, so a
      // delivered row must stay in the conversation.
      if (row === undefined || !isLocallyUndeliveredUserRow(row)) return false
      // A delivered echo under the same request means the prompt reached the
      // Host after all. The local failed copy is then only a duplicate marker:
      // allow hiding it here (the real message stays), unlike the old guard
      // which refused silently and left the row stuck at the bottom forever.
      commitSessionMessages(session.sessionId, rows.filter(item => item.id !== itemId))
      return true
    },

    async deleteUndeliveredMessages() {
      runtime.flushPendingMuxFrames()
      const session = get().selectedSession
      if (session === undefined) return { deleted: 0, kept: 0 }
      const rows = get().messages[session.sessionId] ?? []
      let deleted = 0
      let kept = 0
      const next = rows.filter(item => {
        // Host-adopted queue rows are visible in the queue dock, not as failed
        // rows; leave them for the queue remove action and report them as kept.
        if (item.kind === 'message' && item.role === 'user' && item.nativeSeq === undefined
          && item.sendState === 'queued' && item.queuedAdopted === true) {
          kept += 1
          return true
        }
        if (!isLocallyUndeliveredUserRow(item)) return true
        deleted += 1
        return false
      })
      if (deleted > 0) commitSessionMessages(session.sessionId, next)
      return { deleted, kept }
    },

    pruneDeliveredLocalDuplicates(sessionId) {
      runtime.flushPendingMuxFrames()
      const target = sessionId ?? get().selectedSession?.sessionId
      if (target === undefined) return
      const rows = get().messages[target]
      if (rows === undefined || rows.length === 0) return
      const next = pruneDeliveredLocalDuplicates(rows)
      if (next !== rows) commitSessionMessages(target, next)
    },

    async retrySendMessage(itemId) {
      runtime.flushPendingMuxFrames()
      const state = get()
      if (state.busyAction !== undefined) return false
      const session = state.selectedSession
      if (session === undefined) return false
      const row = (state.messages[session.sessionId] ?? []).find(item => item.id === itemId)
      if (row?.kind !== 'message' || (row.sendState !== 'failed' && row.sendState !== 'unconfirmed') || row.requestRpcId === undefined) return false
      // Reuse the original request rpcId: a prompt the Host already accepted
      // (unconfirmed outcome) must not be executed twice where the Host dedupes.
      return (await get().sendMessage(row.text, row.promptImages ?? [], row.requestRpcId)) === 'sent'
    },

    async stopSession() {
      const session = get().selectedSession
      if (session === undefined) return
      set({ busyAction: 'stop-session' })
      try {
        if (session.backend === 'codex') {
          const threadId = codexThreadId(session)
          const client = runtime.connection.requireCodex()
          let turnId = runtime.activeCodexTimeline?.session.nativeId === threadId
            ? runtime.activeCodexTimeline.activeTurnId
            : undefined
          if (turnId === undefined) {
            const history = await readCodexHistoryPage(client, threadId, undefined, 1)
            turnId = history.activeTurnId
            if (turnId !== undefined && runtime.activeCodexTimeline?.session.nativeId === threadId) {
              runtime.activeCodexTimeline = withActiveCodexTurn(runtime.activeCodexTimeline, turnId)
            }
          }
          if (turnId === undefined) throw new Error(zhCN.runtime.codexTurnUnavailable)
          await client.interrupt(threadId, turnId)
        } else if (session.backend === 'cursor' || session.backend === 'antigravity' || session.backend === 'pi' || session.backend === 'opencode' || session.backend === 'claude' || session.backend === 'hermes') {
          const acpClient = session.backend === 'claude' ? runtime.connection.requireClaude() : session.backend === 'hermes' ? runtime.connection.requireHermes() : session.backend === 'opencode'
            ? runtime.connection.requireOpencode()
            : session.backend === 'pi'
              ? runtime.connection.requirePi()
              : session.backend === 'antigravity' ? runtime.connection.requireAntigravity() : runtime.connection.requireCursor()
          await acpClient.cancel(cursorNativeId(session))
          set(state => ({
            sessions: state.sessions.map(item => item.sessionId === session.sessionId ? { ...item, running: false } : item),
            selectedSession: state.selectedSession?.sessionId === session.sessionId
              ? { ...state.selectedSession, running: false }
              : state.selectedSession,
          }))
        } else {
          await runtime.connection.requireProxy().sessionCancel(session.sessionId)
        }
      } catch (error) {
        set({ error: friendlyError(error) })
      } finally {
        set({ busyAction: undefined })
      }
    },

    async respondApproval(itemId, outcome) {
      runtime.flushPendingMuxFrames()
      set({ busyAction: `approval:${itemId}`, error: undefined })
      try {
        const item = findApproval(get().messages, itemId)
        if (item === undefined) {
          throw new Error(zhCN.runtime.openSessionFirst)
        }
        const session = get().sessions.find(value => value.sessionId === item.sessionId) ?? get().selectedSession
        if (session?.backend === 'codex') {
          await runtime.connection.requireCodex().respond(item.approvalId, outcome === 'allowed-once' ? 'accept' : 'decline')
        } else if (session?.backend === 'cursor' || session?.backend === 'antigravity' || session?.backend === 'pi' || session?.backend === 'opencode' || session?.backend === 'claude' || session?.backend === 'hermes') {
          const acpClient = session.backend === 'claude' ? runtime.connection.requireClaude() : session.backend === 'hermes' ? runtime.connection.requireHermes() : session.backend === 'opencode'
            ? runtime.connection.requireOpencode()
            : session.backend === 'pi'
              ? runtime.connection.requirePi()
              : session.backend === 'antigravity' ? runtime.connection.requireAntigravity() : runtime.connection.requireCursor()
          await acpClient.respond(
            item.approvalId,
            outcome === 'allowed-once' ? 'allow-once' : 'reject-once',
          )
        } else {
          if (item.frameRpcId === undefined) throw new Error(zhCN.runtime.openSessionFirst)
          await runtime.connection.requireProxy().respondApproval(item.frameRpcId, item.sessionId, item.approvalId, outcome)
        }
        set(state => ({
          messages: mapApprovalOutcome(state.messages, itemId, outcome),
          busyAction: undefined,
        }))
        await Haptics.notificationAsync(outcome === 'rejected'
          ? Haptics.NotificationFeedbackType.Warning
          : Haptics.NotificationFeedbackType.Success)
      } catch (error) {
        set({ busyAction: undefined, error: friendlyError(error) })
      }
    },

    async respondQuestion(itemId, selected, custom) {
      runtime.flushPendingMuxFrames()
      set({ busyAction: `question:${itemId}`, error: undefined })
      try {
        const proxy = runtime.connection.requireProxy()
        const item = findQuestion(get().messages, itemId)
        if (item === undefined || item.frameRpcId === undefined) {
          throw new Error(zhCN.runtime.openSessionFirst)
        }
        const answers = item.questions.map(question => {
          const freeText = custom?.[question.id]?.trim()
          return {
            id: question.id,
            selected: selected[question.id] ?? [],
            // Official answer shape carries `custom`; keep it out when empty.
            ...(freeText === undefined || freeText.length === 0 ? {} : { custom: freeText }),
          }
        })
        await proxy.respondQuestion(item.frameRpcId, item.sessionId, { answers })
        set(state => ({
          messages: item.callId === undefined ? mapQuestionAnswered(state.messages, itemId) : state.messages,
          busyAction: undefined,
        }))
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
      } catch (error) {
        set({ busyAction: undefined, error: friendlyError(error) })
      }
    },
  }
}

// User-facing reasons for the Codex paths that used to fail silently. The
// locale catalog is generated elsewhere; keep these actionable strings next to
// the only place that can surface them.
const CODEX_OFFLINE_MESSAGE = 'Codex 连接尚未就绪，消息未发送，请检查网络后重试。'
const CODEX_SESSION_NOT_READY_MESSAGE = 'Codex 会话尚未就绪，消息未发送，请重新打开会话或稍后重试。'
const CODEX_BUSY_MESSAGE = '该会话正被电脑上的 Codex 占用，请关闭电脑端对话或稍后重试。'

/** `CODEX_THREAD_BUSY` from the Host means the desktop Codex app holds the writer lease. */
function codexBusyMessage(error: unknown): string | undefined {
  const code = errorCodeOf(error)
  return code === 'CODEX_THREAD_BUSY' || code === 'CODEX_THREAD_CLOSING' ? CODEX_BUSY_MESSAGE : undefined
}

function errorCodeOf(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}
