import { useEffect, useMemo, useRef } from 'react'
import { isSubagentSession } from '../../lib/session-kind'
import { hasVisibleMessageText } from '../../state/event-reducer'
import type { ChatSection } from '../../state/message-helpers'
import { chatSections, inboxQueuedItems, inboxRpcIds, mergeReplyReasoning } from '../../state/message-helpers'
import type { ChatItem, RemoteSession, TeamMemberSnapshot, TeamTaskSnapshot } from '../../types'
import { useAppStore } from '../../state/store'
import { useSessionUiArtifacts } from './use-session-ui-artifacts'

/** One row of the queue dock, whether the Host admitted it or it is still local. */
export interface QueueDockItem {
  /** Stable React key; generated from id/messageId/index when a producer omits it. */
  key?: string
  /** Host inbox item id; the only value `session/updateQueue` accepts. */
  id?: string
  rpcId?: string
  /** Local optimistic message id, used for a device-local removal. */
  messageId?: string
  preview: string
  /** True until the Host inbox projection admits this prompt into a row with an id. */
  local?: boolean
}

/**
 * Conversation that owns the agent roster. Subagent children only publish
 * their own projections, so the team view must be read from the root of the
 * subagent chain. Forks also carry `parentSessionId` but are not subagents, so
 * only `origin: 'subagent'` rows continue the walk. A missing ancestor (not in
 * the loaded catalogue) or a cycle stops at the closest known session, which
 * still gives the dock a usable roster instead of an empty one.
 */
export function resolveRootSession(
  session: RemoteSession | undefined,
  sessions: readonly RemoteSession[],
): RemoteSession | undefined {
  if (session === undefined) return undefined
  let current = session
  const seen = new Set<string>([current.sessionId])
  while (isSubagentSession(current)) {
    const parent = sessions.find(item => item.sessionId === current.parentSessionId)
    if (parent === undefined || seen.has(parent.sessionId)) return current
    seen.add(parent.sessionId)
    current = parent
  }
  return current
}

/** Read the `agentTeam` projection, if the session published one. */
function teamStateFrom(session: RemoteSession | undefined): { members: TeamMemberSnapshot[]; tasks: TeamTaskSnapshot[] } | undefined {
  const raw = (session?.projections?.values as Record<string, unknown> | undefined)?.agentTeam
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const members = Array.isArray(record.members) ? record.members.filter((entry): entry is TeamMemberSnapshot =>
    typeof entry === 'object' && entry !== null && typeof (entry as Record<string, unknown>).id === 'string') : []
  const tasks = Array.isArray(record.tasks) ? record.tasks.filter((entry): entry is TeamTaskSnapshot =>
    typeof entry === 'object' && entry !== null && typeof (entry as Record<string, unknown>).id === 'string') : []
  return { members, tasks }
}

export function useChatTranscript({ session, sessions, messages, hostId }: { session: RemoteSession | undefined; sessions: RemoteSession[]; messages: ChatItem[]; hostId: string | undefined }) {
  const visibleMessages = useMemo(() => (session?.backend === 'codex' ? mergeReplyReasoning(messages) : messages).filter(item =>
    item.kind !== 'message' || (item.role !== 'system' && !item.context && item.sendState !== 'queued'
      && (
        hasVisibleMessageText(item.text)
        || hasVisibleMessageText(item.reasoning ?? '')
        || (item.images?.length ?? 0) > 0
        // Output-less failure turns keep an empty assistant row carrying only the
        // turnEnd reason — it must stay visible so the failure is explainable.
        || item.turnEnd !== undefined))), [messages, session?.backend])
  // Feed the previous list back so untouched groups keep their identity; the
  // streaming delta then only rebuilds the group that actually changed.
  const previousSectionsRef = useRef<readonly ChatSection[]>([])
  const visibleSections = useMemo(() => {
    const next = chatSections(visibleMessages, previousSectionsRef.current)
    previousSectionsRef.current = next
    return next
  }, [visibleMessages])
  const { uiBySection, visibleUiIds } = useSessionUiArtifacts({
    messages,
    visibleSections,
    hostId,
    sessionId: session?.sessionId,
    backend: session?.backend,
  })

  // The previousSectionsRef describes one transcript. Switching sessions must drop it,
  // otherwise the first render of the next session would compare against a
  // foreign list (harmless for correctness, wasteful for memory).
  useEffect(() => {
    previousSectionsRef.current = []
  }, [session?.sessionId])
  // A local failed copy whose prompt already reached the Host (delivered echo)
  // is only a duplicate marker. Leaving it pins "failed · re-add the image" at
  // the bottom of a conversation that actually ran, with the image gone. The
  // reducer prunes the live case; this effect also heals history restores and
  // cached transcripts that were merged on reconnect. The action persists the
  // pruned list, so a reload cannot revive it.
  const pruneDeliveredLocalDuplicates = useAppStore(state => state.pruneDeliveredLocalDuplicates)
  const sessionId = session?.sessionId
  const pruneSignature = useMemo(() => {
    let localUndelivered = 0
    let delivered = 0
    for (const item of messages) {
      if (item.kind !== 'message' || item.role !== 'user') continue
      if (item.nativeSeq !== undefined) delivered += 1
      else if (item.sendState === 'failed' || item.sendState === 'unconfirmed'
        || item.sendState === 'canceled' || item.sendState === 'queued') localUndelivered += 1
    }
    // Streaming and tool updates leave this signature untouched; it only moves
    // when a local notice appears or a delivered echo lands.
    return localUndelivered === 0 ? '' : `${localUndelivered}:${delivered}`
  }, [messages])
  useEffect(() => {
    if (pruneSignature === '' || sessionId === undefined) return
    pruneDeliveredLocalDuplicates(sessionId)
  }, [pruneSignature, pruneDeliveredLocalDuplicates, sessionId])
  // Queued prompts: the Host `inbox` projection is authoritative (includes
  // items queued from other devices); local `queued` rows are the fallback for
  // Hosts without projections. Rows in this state are hidden from the timeline.
  const inboxProjection = (session?.projections?.values as Record<string, unknown> | undefined)?.inbox
  const queueItems = useMemo<QueueDockItem[]>(() => {
    const inboxItems: QueueDockItem[] = (inboxProjection === undefined ? [] : inboxQueuedItems(inboxProjection))
      .map((item, index) => ({
        key: item.id === undefined ? `inbox:${item.rpcId ?? index}` : `inbox:${item.id}`,
        ...(item.id === undefined ? {} : { id: item.id }),
        ...(item.rpcId === undefined ? {} : { rpcId: item.rpcId }),
        preview: item.preview,
        local: false,
      }))
    const adopted = inboxRpcIds(inboxProjection)
    const pending: QueueDockItem[] = messages.flatMap(item => item.kind === 'message' && item.role === 'user'
      && item.sendState === 'queued' && item.queuedAdopted !== true
      && (item.requestRpcId === undefined || !adopted.has(item.requestRpcId))
      ? [{
        key: `local:${item.id}`,
        ...(item.requestRpcId === undefined ? {} : { rpcId: item.requestRpcId }),
        messageId: item.id,
        preview: item.text,
        local: true,
      }]
      : [])
    // Union (the official QueueDock's pendingQueue behaviour): inbox rows are
    // authoritative and local rows not yet admitted by the projection cover the
    // lag window, so a queued prompt is never invisible on both ends. Rows the
    // Host has not admitted keep their local message id so the dock can still
    // show actions (resolve by rpcId, then local removal) instead of going blank.
    return [...inboxItems, ...pending]
  }, [inboxProjection, messages])
  // Subagent children only carry their own projections. Reading the team from
  // the current session would collapse the dock to 1/1 and drop the other
  // members as soon as a member conversation is opened, so the roster and the
  // sibling list are both resolved from the root conversation.
  const rootSession = useMemo(() => resolveRootSession(session, sessions), [session, sessions])
  const rosterSessionId = rootSession?.sessionId ?? session?.sessionId
  const childSessions = useMemo(
    () => sessions.filter(item => isSubagentSession(item) && item.parentSessionId === rosterSessionId),
    [sessions, rosterSessionId])
  // Agent team: the `agentTeam` projection carries the durable roster
  // (member name + role description + phase) and the task board (subject +
  // status + owning member). This is the team view — distinct from the
  // subagent child-session list above.
  const teamState = useMemo(
    () => teamStateFrom(rootSession) ?? (rootSession?.sessionId === session?.sessionId ? undefined : teamStateFrom(session)),
    [rootSession, session])
  return { visibleMessages, visibleSections, uiBySection, visibleUiIds, queueItems, childSessions, teamState, rootSession }
}
