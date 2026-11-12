import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import { Flag, Layers, PauseCircle, Users } from 'lucide-react-native'
import type { RemoteGatewayStream } from '@dsh-remote/client-core'
import type { BackgroundJob } from '../../services/session-tools'
import type { RemoteSession, TeamMemberSnapshot, TeamTaskSnapshot } from '../../types'
import { requireSessionTools } from '../../state/store'
import { strings } from '../../locales/i18n'
import { IconJobOutline } from '../../ui/dsh-icons'
import { radius, spacing, type as typography, type ThemeColors } from '../../ui/theme'
import { useTheme } from '../../ui/theme-context'
import { useThemedStyles } from '../../ui/use-themed-styles'
import { TaskProgressChecklist, type TodoItem } from './task-progress-checklist'
import { BackgroundJobsCard, formatJobStats } from './background-jobs-card'
import { AgentTeamCard, formatSubagentStats, formatTeamStats, SubagentsCard } from './agents'

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed' }
type Section = 'todos' | 'goal' | 'jobs' | 'subagents' | 'team'
function todosFrom(value: unknown): Todo[] {
  return Array.isArray(value) ? value.filter((item): item is Todo => record(item) && typeof item.content === 'string'
    && ['pending', 'in_progress', 'completed'].includes(String(item.status))) : []
}
function jobsFrom(value: unknown, sessionId: string): BackgroundJob[] {
  return Array.isArray(value) ? value.filter((item): item is BackgroundJob => record(item)
    && typeof item.id === 'string' && typeof item.label === 'string'
    && (item.owner === undefined || item.owner === sessionId)
    && ['running', 'stopping', 'completed', 'killed', 'failed'].includes(String(item.status)))
    .sort((a, b) => Number(b.status === 'running' || b.status === 'stopping') - Number(a.status === 'running' || a.status === 'stopping')
      || (typeof b.startedAt === 'number' ? b.startedAt : 0) - (typeof a.startedAt === 'number' ? a.startedAt : 0)) : []
}

export interface SessionActivityDockProps {
  session: RemoteSession
  childSessions?: RemoteSession[]
  teamState?: {
    members: TeamMemberSnapshot[]
    tasks: TeamTaskSnapshot[]
  }
  sessions?: RemoteSession[]
  onOpenSession?: (session: RemoteSession) => void
}

/** Current Host projections only. No inferred goals or locally persisted task state. */
export function SessionActivityDock({
  session,
  childSessions,
  teamState,
  sessions,
  onOpenSession,
}: SessionActivityDockProps) {
  const { colors } = useTheme()
  const styles = useThemedStyles(createStyles)
  const copy = strings.sessionActivity
  const values = session.projections?.values
  const todos = todosFrom(values?.todos)
  const projection = record(values?.goal) ? values.goal : undefined
  const goal = record(projection?.goal) && typeof projection.goal.objective === 'string' ? projection.goal : undefined
  const [expanded, setExpanded] = useState<Section | undefined>()
  const toggle = (section: Section) => setExpanded(value => value === section ? undefined : section)
  // One pill row carries goal/jobs/subagents/team; every pill opens its details
  // underneath and tapping the same pill again folds the dock back to one line.
  const pillStyle = (section: Section) => ({ pressed }: { pressed: boolean }) => [
    styles.compactPill,
    expanded === section && styles.compactPillOpen,
    pressed && styles.compactPillPressed,
  ]
  const { height } = useWindowDimensions()
  const detailsHeight = Math.min(180, height * 0.24)
  const [jobs, setJobs] = useState<BackgroundJob[]>([])
  const [jobError, setJobError] = useState(false)
  const [jobsLoading, setJobsLoading] = useState(true)
  const [attempt, setAttempt] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const phase = (value: unknown) => value === 'complete' || value === 'completed' ? copy.complete
    : value === 'paused' ? copy.paused : value === 'blocked' ? copy.blocked
      : value === 'failed' ? copy.failed : value === 'killed' ? copy.killed
        : value === 'stopping' ? copy.stopping : value === 'pending' ? copy.pending : copy.active
  // Subagents and the agent team share one slim, tappable pill row so they never
  // stack two full-width cards above the composer. Tapping a pill opens the
  // existing list inline; tapping it again folds it back to the single row.
  const subagentSessions = childSessions ?? []
  const teamMembers = teamState?.members ?? []
  const subagentStats = formatSubagentStats(subagentSessions)
  const teamStats = formatTeamStats(teamMembers, sessions ?? [])
  const hasSubagents = subagentSessions.length > 0
  const hasTeam = teamMembers.length > 0
  const jobsStats = formatJobStats(jobs)
  const jobsVisible = jobsLoading || jobError || jobs.length > 0
  const goalRounds = typeof projection?.roundsStarted === 'number' && typeof goal?.maxGoalRounds === 'number'
    ? `${projection.roundsStarted}/${goal.maxGoalRounds}`
    : undefined
  const goalPillStats = goal === undefined ? '' : [phase(goal.phase), goalRounds].filter((item): item is string => item !== undefined && item.length > 0).join(' ')
  const jobsPillStats = jobsLoading && jobs.length === 0 ? copy.loading : jobError && jobs.length === 0 ? copy.failed : jobsStats.statsText
  const hasPills = goal !== undefined || jobsVisible || hasSubagents || hasTeam

  useEffect(() => {
    const controller = new AbortController()
    let stream: RemoteGatewayStream | undefined
    setJobs([])
    setJobError(false)
    setJobsLoading(true)
    void (async () => {
      try {
        const tools = requireSessionTools(session.sessionId)
        if (!tools.watchJobs) { setJobsLoading(false); setRefreshing(false); return }
        stream = await tools.watchJobs(session.sessionId, controller.signal)
        if (controller.signal.aborted) return
        for await (const frame of stream) {
          if (controller.signal.aborted) return
          if (!record(frame) || frame.type !== 'rows' || !Array.isArray(frame.jobs)) throw new Error('Invalid job roster')
          setJobs(jobsFrom(frame.jobs, session.sessionId))
          setJobsLoading(false)
        }
        if (!controller.signal.aborted) setJobError(true)
      } catch {
        if (!controller.signal.aborted) setJobError(true)
      } finally {
        if (!controller.signal.aborted) { setJobsLoading(false); setRefreshing(false) }
        await stream?.close().catch(() => {})
      }
    })()
    return () => { controller.abort(); void stream?.close().catch(() => {}) }
  }, [session.sessionId, attempt])

  return <View style={styles.dock}>
    {todos.length > 0 && (
      <TaskProgressChecklist
        todos={todos}
        expanded={expanded === 'todos'}
        onToggle={() => toggle('todos')}
        maxHeight={detailsHeight}
      />
    )}
    {(goal !== undefined || jobsVisible || hasSubagents || hasTeam) && (
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        style={styles.compactScroll}
        contentContainerStyle={styles.compactRow}
        testID="session-activity-compact"
      >
        {goal !== undefined && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${copy.goal} · ${goalPillStats}`}
            accessibilityState={{ expanded: expanded === 'goal' }}
            onPress={() => toggle('goal')}
            hitSlop={{ top: 8, bottom: 8, left: 2, right: 2 }}
            style={pillStyle('goal')}
            testID="session-activity-goal-pill"
          >
            {goal.phase === 'paused'
              ? <PauseCircle size={13} color={expanded === 'goal' ? colors.primary : colors.muted} />
              : <Flag size={13} color={expanded === 'goal' ? colors.primary : colors.muted} />}
            <Text style={styles.compactPillText} numberOfLines={1}>{copy.goal}</Text>
            <Text style={styles.compactPillCount} numberOfLines={1}>{goalPillStats}</Text>
          </Pressable>
        )}
        {jobsVisible && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${copy.jobs} · ${jobsPillStats}`}
            accessibilityState={{ expanded: expanded === 'jobs' }}
            onPress={() => toggle('jobs')}
            hitSlop={{ top: 8, bottom: 8, left: 2, right: 2 }}
            style={pillStyle('jobs')}
            testID="session-activity-jobs-pill"
          >
            <IconJobOutline size={13} color={expanded === 'jobs' ? colors.primary : colors.muted} />
            <Text style={styles.compactPillText} numberOfLines={1}>{copy.jobs}</Text>
            {jobsLoading && jobs.length === 0
              ? <ActivityIndicator size={12} color={colors.primary} />
              : jobError && jobs.length === 0
                ? <View style={styles.compactPillDot} />
                : <Text style={styles.compactPillCount} numberOfLines={1}>{jobsStats.statsText}</Text>}
          </Pressable>
        )}
        {hasSubagents && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${copy.subagents} · ${subagentStats.statsText}`}
            accessibilityState={{ expanded: expanded === 'subagents' }}
            onPress={() => toggle('subagents')}
            hitSlop={{ top: 8, bottom: 8, left: 2, right: 2 }}
            style={pillStyle('subagents')}
            testID="session-activity-subagents-pill"
          >
            <Layers size={13} color={expanded === 'subagents' ? colors.primary : colors.muted} />
            <Text style={styles.compactPillText} numberOfLines={1}>{copy.subagents}</Text>
            <Text style={styles.compactPillCount} numberOfLines={1}>{subagentStats.statsText}</Text>
          </Pressable>
        )}
        {hasTeam && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${copy.team} · ${teamStats.statsText}`}
            accessibilityState={{ expanded: expanded === 'team' }}
            onPress={() => toggle('team')}
            hitSlop={{ top: 8, bottom: 8, left: 2, right: 2 }}
            style={pillStyle('team')}
            testID="session-activity-team-pill"
          >
            <Users size={13} color={expanded === 'team' ? colors.primary : colors.muted} />
            <Text style={styles.compactPillText} numberOfLines={1}>{copy.team}</Text>
            <Text style={styles.compactPillCount} numberOfLines={1}>{teamStats.statsText}</Text>
          </Pressable>
        )}
      </ScrollView>
    )}
    {expanded === 'goal' && goal !== undefined && (
      <View style={styles.expandedSection}>
        <ScrollView style={[styles.details, { maxHeight: detailsHeight }]} nestedScrollEnabled>
          <Text selectable style={styles.detailText}>{String(goal.objective)}</Text>
          <Text style={styles.muted}>{phase(goal.phase)}{goalRounds === undefined ? '' : ` · ${goalRounds}`}</Text>
          {record(goal.blockedReason) && typeof goal.blockedReason.message === 'string' && <Text selectable style={styles.detailText}>{goal.blockedReason.message}</Text>}
        </ScrollView>
      </View>
    )}
    {expanded === 'jobs' && jobsVisible && (
      <View style={styles.expandedSection}>
        <BackgroundJobsCard
          headerless
          jobs={jobs}
          sessionId={session.sessionId}
          expanded
          loading={jobsLoading}
          error={jobError}
          onRefresh={() => { setRefreshing(true); setAttempt(value => value + 1) }}
          refreshing={refreshing}
          maxHeight={detailsHeight}
        />
      </View>
    )}
    {expanded === 'subagents' && hasSubagents && (
      <SubagentsCard
        headerless
        sessions={subagentSessions}
        expanded
        onOpen={onOpenSession}
        maxHeight={detailsHeight}
      />
    )}
    {expanded === 'team' && hasTeam && (
      <AgentTeamCard
        headerless
        members={teamMembers}
        tasks={teamState?.tasks ?? []}
        sessions={sessions ?? []}
        expanded
        onOpen={onOpenSession}
        maxHeight={detailsHeight}
      />
    )}
  </View>
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  dock: { gap: spacing.xxs, marginHorizontal: spacing.xs, marginBottom: spacing.xs },
  // One slim, horizontally scrollable row replaces the stacked goal/jobs cards.
  compactScroll: { flexGrow: 0 },
  compactRow: { minHeight: 28, flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  compactPill: { height: 26, maxWidth: 240, flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, borderRadius: radius.pill, backgroundColor: colors.surfaceStrong, borderWidth: StyleSheet.hairlineWidth, borderColor: 'transparent' },
  compactPillOpen: { backgroundColor: colors.primarySoft, borderColor: colors.primary },
  compactPillPressed: { opacity: 0.72 },
  compactPillText: { ...typography.caption, color: colors.ink, flexShrink: 1 },
  compactPillCount: { ...typography.caption, color: colors.muted, fontVariant: ['tabular-nums'] },
  compactPillDot: { width: 6, height: 6, borderRadius: radius.pill, backgroundColor: colors.danger },
  expandedSection: { borderRadius: radius.xl, backgroundColor: colors.card, overflow: 'hidden', paddingTop: spacing.xs },
  details: { maxHeight: 160, paddingHorizontal: spacing.sm, marginBottom: spacing.xs },
  jobs: { maxHeight: 220 },
  todo: { flexDirection: 'row', gap: spacing.xs, paddingVertical: spacing.xs, alignItems: 'flex-start' },
  todoText: { ...typography.small, color: colors.ink, flex: 1 },
  detailText: { ...typography.small, color: colors.ink, paddingBottom: spacing.xs },
  muted: { ...typography.caption, color: colors.muted },
  progressTrack: { height: 3, backgroundColor: colors.surfaceStrong, marginHorizontal: spacing.sm, marginBottom: spacing.xs, borderRadius: 2 },
  progressFill: { height: 3, backgroundColor: colors.primary, borderRadius: 2 },
  progressComplete: { backgroundColor: colors.success },
  jobHeader: { minHeight: 48, padding: spacing.sm, flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  jobCopy: { flex: 1, gap: spacing.xxs },
  output: { paddingHorizontal: spacing.sm, paddingBottom: spacing.sm },
  outputText: { ...typography.small, color: colors.ink, fontFamily: 'monospace' },
  empty: { ...typography.small, color: colors.muted, padding: spacing.sm },
  jobActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  retry: { minHeight: 44, paddingHorizontal: spacing.sm, justifyContent: 'center' },
  retryText: { ...typography.small, color: colors.primary },
})
