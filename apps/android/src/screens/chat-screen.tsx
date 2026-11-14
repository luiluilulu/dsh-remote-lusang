import * as Haptics from 'expo-haptics'
import { ArrowLeft, FileText, ListTree, Menu, MessageSquare, Pencil, RefreshCw, ScanText, X } from 'lucide-react-native'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  AppState,
  DeviceEventEmitter,
  FlatList,
  Image,
  Keyboard,
  Modal,
  NativeModules,
  PanResponder,
  Pressable,
  ScrollView,
  Text,
  View
} from 'react-native'
import { shouldConfirmSwipeRightOpen, shouldStartSwipeRightToOpen } from '../lib/gesture-swipe-rules'
import { isSubagentSession } from '../lib/session-kind'
import { workspaceStableKey } from '../lib/workspace-key'
import { strings } from '../locales/i18n'
import { sessionPermissions } from '../services/session-permissions'
import { extractTextFromImage, imageOcrAvailable } from '../services/ocr'
import type { CustomPrompt } from '../services/storage'
import { BUILT_IN_PROMPTS } from '../services/storage'
import type { ChatSection } from '../state/message-helpers'
import { isKnownBotSessionId, useBotTeamStore } from '../state/bot-store'
import { chatImageConnectionGeneration, fetchLink, requireConnectionRpc, requireSessionTools, sessionChatImageLoader, supportsAppApis, useAppStore } from '../state/store'
import { type UiArtifact } from '../state/ui-artifacts'
import type {
  ChatItem,
  ChatMessage,
  ModelCatalogModel,
  ModelProviderGroup,
  PermissionSelect,
  PromptImage,
  WorkspaceView
} from '../types'
import { AnimatedEllipsis } from '../ui/animated-ellipsis'
import { ChatImageProvider } from '../ui/chat-image'
import { BlurHeaderFrame, IconButton, TopBar } from '../ui/components'
import { KeyboardInset } from '../ui/keyboard-inset'
import { decodeSessionMentionUri, markdownFilePath, MarkdownLinkProvider, openSafeExternalUrl } from '../ui/markdown'
import { OfficialMenuIcons } from '../ui/official-menu-icons'
import { useResponsiveLayout } from '../ui/responsive'
import { spacing } from '../ui/theme'
import { useTheme } from '../ui/theme-context'
import { useThemedStyles } from '../ui/use-themed-styles'
import { AutomationTasksModal } from './automation-tasks-modal'
import { ChatErrorBoundary } from './chat-error-boundary'
import {
  formatFileBytes,
  formatUploadedFilesPrompt,
  formatUploadedFilesReferencePrompt,
  MAX_TOTAL_FILES_BYTES,
  uploadStagedFilesToWorkspace,
  type StagedFile
} from './chat-files'
import { ChatTrajectory } from './chat-trajectory'
import { promptImageFromBase64, sessionImageLimits, validatePromptImages } from './chat-images'
import { ChatActionMenu } from './chat/action-menu'
import { ChatComposer } from './chat/composer'
import { composerEditable, submitIntent } from './chat/composer-gate'
import { ExpandedComposer } from './chat/expanded-composer'
import { ImageEditor, type ImageEditorExport } from './chat/image-editor'
import {
  ChatImages,
  ChatItemView,
  ChatProcessGroup,
  isActiveChatItem,
  QueueDock,
  WelcomeMessage
} from './chat/messages'
import {
  agentPresetName,
  builtinPresetName,
  ModelPicker,
  ModePicker,
  permissionDisplayName,
  PermissionPicker,
  PromptEditor,
  PromptsManager,
  PromptsPicker,
  ToolAccessPicker,
  WorkspacePicker,
} from './chat/pickers'
import { sessionTitle } from './chat/presentation'
import { SessionActivityDock } from './chat/session-activity'
import { SessionInfo } from './chat/session-info'
import { createStyles } from './chat/styles'
import { useChatAttachments } from './chat/use-chat-attachments'
import { useChatBackHandler } from './chat/use-chat-back-handler'
import { useChatMentions } from './chat/use-chat-mentions'
import { useChatPrompts } from './chat/use-chat-prompts'
import { useChatScroll } from './chat/use-chat-scroll'
import { useChatTranscript } from './chat/use-chat-transcript'
import { useVoiceInput } from './chat/use-voice-input'
import { useLiveSessionStatus } from './device-screens'
import { BotModeScreen } from './bot-mode-screen'
import { HostSessionsDrawer } from './host-sessions-drawer'
import { PluginsModal } from './plugins-modal'
import { ReferenceChatModal, ReferencedChatPills } from './bot/reference-chat-modal'
import type { ReferenceChatCandidate } from './bot/at-menu'
import { SessionToolsPanel } from './session-tools-panel'

import { browseKey, browseScope, updateBrowseEntry, useBrowseMemory } from '../services/browse-memory'
import { formatQuoteText, QuotePreview } from '../ui/quote-preview'
const EMPTY_QUOTES: string[] = []
const EMPTY_IMAGES: PromptImage[] = []
const EMPTY_CHAT_ITEMS: ChatItem[] = []
const EMPTY_UI_ARTIFACTS: UiArtifact[] = []

/** Hard cap mirroring the largest backend prompt budget (ACP/CodeX 256 KiB). */
const LONG_DRAFT_MAX = 256_000

export function ChatScreen({
  onBack = () => {},
  onOpenDevices: _onOpenDevices,
  onNewSession,
  onOpenWorkspaces,
  onOpenDeviceInfo,
  onOpenHostSwitcher,
  onOpenSettings,
  botMode = false,
  botConversationId,
  onBotModeChange,
  onSelectBot,
}: {
  onBack?: () => void
  onOpenDevices?: () => void
  onNewSession?: () => void
  onOpenWorkspaces?: (focusWorkspaceKey?: string) => void
  onOpenDeviceInfo?: () => void
  onOpenHostSwitcher?: () => void
  onOpenSettings?: () => void
  botMode?: boolean
  botConversationId?: string
  onBotModeChange?: (botMode: boolean) => void
  onSelectBot?: (id?: string) => void
}) {
  // New subagent children and running-state changes must reach `sessions`
  // without leaving the chat (the list screens unmount here).
  const session = useAppStore(state => state.selectedSession)
  const archivedSessionIds = useAppStore(state => state.archivedSessionIds)
  useLiveSessionStatus(!botMode && session !== undefined && (session.backend ?? 'harness') === 'harness')
  const hostId = useAppStore(state => state.selectedDevice?.deviceId)
  const hostPlatform = useAppStore(state => state.selectedDevice?.platform)
  const messages = useAppStore(state => session === undefined ? EMPTY_CHAT_ITEMS : state.messages[session.sessionId] ?? EMPTY_CHAT_ITEMS)
  const busy = useAppStore(state => state.busyAction)
  const codexReadySessionId = useAppStore(state => state.codexReadySessionId)
  const connection = useAppStore(state => state.connection)
  const imageGeneration = chatImageConnectionGeneration()
  const imageLoader = useMemo(() => session === undefined || connection.phase !== 'connected'
    ? undefined : sessionChatImageLoader(session), [session?.sessionId, session?.backend, hostId, imageGeneration, connection.phase])
  const historyHasMore = useAppStore(state => state.historyHasMore)
  const historyLoadingOlder = useAppStore(state => state.historyLoadingOlder)
  const sessionModels = useAppStore(state => state.sessionModels)
  const modelSelecting = useAppStore(state => state.modelSelecting)
  const permissionSelecting = useAppStore(state => state.permissionSelecting)
  const sendMessage = useAppStore(state => state.sendMessage)
  const stopSession = useAppStore(state => state.stopSession)
  const reconnect = useAppStore(state => state.reconnect)
  const openSession = useAppStore(state => state.openSession)
  const respondApproval = useAppStore(state => state.respondApproval)
  const respondQuestion = useAppStore(state => state.respondQuestion)
  const loadOlderHistory = useAppStore(state => state.loadOlderHistory)
  const selectModel = useAppStore(state => state.selectModel)
  const selectPermission = useAppStore(state => state.selectPermission)
  const loadAgentPresets = useAppStore(state => state.loadAgentPresets)
  const selectAgentPreset = useAppStore(state => state.selectAgentPreset)
  const createSession = useAppStore(state => state.createSession)
  const archiveSession = useAppStore(state => state.archiveSession)
  const workspaces = useAppStore(state => state.workspaces)
  const sessions = useAppStore(state => state.sessions)
  const agentPresetOptions = useAppStore(state => state.agentPresetOptions)
  const agentPresetLoading = useAppStore(state => state.agentPresetLoading)
  const agentPresetSelecting = useAppStore(state => state.agentPresetSelecting)
  const previewImageUri = useAppStore(state => state.previewImageUri)
  const setPreviewImageUri = useAppStore(state => state.setPreviewImageUri)
  const memoryScope = browseScope(useAppStore.getState())
  const memoryKey = browseKey(memoryScope, session?.sessionId ?? '')
  const draft = useBrowseMemory(state => state.entries[memoryKey]?.draft ?? '')
  const memoryError = useBrowseMemory(state => state.error)
  const setDraft = (value: string) => updateBrowseEntry(memoryScope, session?.sessionId ?? '', {draft: value})
  const [trajectory, setTrajectory] = useState(false)
  const [composingDuringRun, setComposingDuringRun] = useState(false)
  const [ocrBusy, setOcrBusy] = useState(false)

  const [sessionsOpen, setSessionsOpen] = useState(true)
  // Cold start parks the sidebar full-screen before any page is chosen; swiping
  // or pressing back must not drop the user into an arbitrary conversation.
  const [drawerSwipeUnlocked, setDrawerSwipeUnlocked] = useState(false)
  const markConversationChosen = () => setDrawerSwipeUnlocked(true)
  const lastHostIdRef = useRef(hostId)
  useEffect(() => {
    if (hostId === lastHostIdRef.current) return
    lastHostIdRef.current = hostId
    setDrawerSwipeUnlocked(false)
    setSessionsOpen(true)
  }, [hostId])
  const [automationTasksOpen, setAutomationTasksOpen] = useState(false)
  const [pluginsOpen, setPluginsOpen] = useState(false)
  const pluginsAvailable = useAppStore(state => state.connection.phase === 'connected')
  const [sessionInfoOpen, setSessionInfoOpen] = useState(false)

  // Web-style blue marks: `/` commands and `@` references render in accent blue.
  const images = useBrowseMemory(state => state.entries[memoryKey]?.images ?? EMPTY_IMAGES)
  const setImages = (value: PromptImage[] | ((previous: PromptImage[]) => PromptImage[])) => {
    const previous = useBrowseMemory.getState().entries[memoryKey]?.images ?? EMPTY_IMAGES
    updateBrowseEntry(memoryScope, session?.sessionId ?? '', {images: typeof value === 'function' ? value(previous) : value})
  }
  const quotes = useBrowseMemory(state => state.entries[memoryKey]?.quotes ?? EMPTY_QUOTES)
  const setQuotes = (value: string[] | ((previous: string[]) => string[])) => {
    const previous = useBrowseMemory.getState().entries[memoryKey]?.quotes ?? EMPTY_QUOTES
    updateBrowseEntry(memoryScope, session?.sessionId ?? '', {quotes: typeof value === 'function' ? value(previous) : value})
  }
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [permissionPickerOpen, setPermissionPickerOpen] = useState(false)
  const mentionInput = useChatMentions({
    session, sessions, workspaces, connectionPhase: connection.phase, draft, setDraft,
    setPermissionPickerOpen, setModelPickerOpen,
  })
  const { composerInputRef, draftRef, mentionType, setMentionType, applyDraft, closeMention, resetSelection } = mentionInput
  // The phone only records; the computer transcribes through the official
  // experimental speech namespace, so the entry exists for Harness sessions only.
  const harnessVoice = (session?.backend ?? 'harness') === 'harness'
  const voice = useVoiceInput({
    enabled: connection.phase === 'connected' && harnessVoice,
    onTranscript: text => {
      const current = draftRef.current
      applyDraft(current === '' ? text : `${current} ${text}`)
    },
    onError: message => Alert.alert(strings.chat.voiceInput, message),
  })
  useEffect(() => {
    void voice.cancel()
  }, [session?.sessionId, voice.cancel])

  // "取字": the computer runs Windows OCR; the recognized text lands in the
  // composer draft, never sent automatically.
  const runImageOcr = () => {
    if (previewImageUri === undefined || ocrBusy) return
    setOcrBusy(true)
    void extractTextFromImage(previewImageUri)
      .then(text => {
        if (text === '') {
          Alert.alert(strings.chat.ocrExtract, strings.chat.ocrEmpty)
          return
        }
        setPreviewImageUri(undefined)
        const current = draftRef.current
        applyDraft(current === '' ? text : `${current} ${text}`)
      })
      .catch(error => {
        Alert.alert(
          strings.chat.ocrExtract,
          error instanceof Error && error.message !== '' ? error.message : strings.chat.ocrUnavailable,
        )
      })
      .finally(() => setOcrBusy(false))
  }

  // Link summary: the Host fetches the page (SSRF-guarded) and its readable text
  // becomes a quote, so the model can summarize it in the next message.
  const summarizeLink = (url: string) => {
    void fetchLink(url)
      .then(page => {
        const title = page.title !== '' ? page.title : url
        const excerpt = page.text.slice(0, 12_000)
        setQuotes(current => [...current, `${title}\n${page.url}\n\n${excerpt}`])
      })
      .catch(error => {
        Alert.alert(
          strings.chat.linkSummary,
          error instanceof Error && error.message !== '' ? error.message : strings.messageActions.unavailable,
        )
      })
  }
  const lastQuoteCountRef = useRef(quotes.length)
  useEffect(() => {
    if (quotes.length > lastQuoteCountRef.current) {
      composerInputRef.current?.focus()
    }
    lastQuoteCountRef.current = quotes.length
  }, [quotes.length, composerInputRef])

  useEffect(() => {
    if (NativeModules.DshProcessText?.getInitialText) {
      NativeModules.DshProcessText.getInitialText().then((text: string | null) => {
        if (text && text.trim().length > 0) {
          setQuotes(current => [...current, text.trim()])
          composerInputRef.current?.focus()
        }
      }).catch(() => {})
    }

    const sub = DeviceEventEmitter.addListener('onProcessText', (text: string) => {
      if (text && text.trim().length > 0) {
        setQuotes(current => [...current, text.trim()])
        composerInputRef.current?.focus()
      }
    })

    return () => {
      sub.remove()
    }
  }, [setQuotes, composerInputRef])
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([])
  const [uploadingFiles, setUploadingFiles] = useState(false)
  const uploadingRef = useRef(false)
  const uploadControllerRef = useRef<AbortController | undefined>(undefined)
  const sessionGenerationRef = useRef(0)
  // The in-app canvas editor is the only editor: one screen with crop + blue marks.
  // A fresh capture or a single library pick opens it right away; a staged thumbnail
  // reopens it from its pencil badge (tapping the thumbnail itself only previews).
  const [imageEditorTarget, setImageEditorTarget] = useState<{ image: PromptImage; index?: number }>()
  const pendingEditorResolve = useRef<((image: PromptImage | undefined) => void) | undefined>(undefined)
  useLayoutEffect(() => {
    let lastSessionId = useAppStore.getState().selectedSession?.sessionId
    return useAppStore.subscribe((state) => {
      const currentId = state.selectedSession?.sessionId
      if (currentId !== lastSessionId) {
        lastSessionId = currentId
        sessionGenerationRef.current += 1
        uploadControllerRef.current?.abort()
        setStagedFiles([])
        // An editor opened from the previous conversation must not stage into this one.
        setImageEditorTarget(undefined)
        const resolve = pendingEditorResolve.current
        pendingEditorResolve.current = undefined
        resolve?.(undefined)
      }
    })
  }, [])
  const imageEditLimits = session === undefined ? undefined : sessionImageLimits(session)
  const imageEditorMaxEdge = Math.min(3072, imageEditLimits?.maxImageDimension ?? 3072)
  const editedPromptImage = (exported: ImageEditorExport, template: PromptImage): PromptImage =>
    promptImageFromBase64({
      // The tray renders the result from this in-memory URI; only `data` is sent.
      uri: `data:image/jpeg;base64,${exported.base64}`,
      base64: exported.base64,
      mimeType: 'image/jpeg',
      ...(template.name === undefined ? {} : { name: template.name }),
      width: exported.width,
      height: exported.height,
    })
  const closeImageEditor = (kept: PromptImage | undefined) => {
    setImageEditorTarget(undefined)
    const resolve = pendingEditorResolve.current
    pendingEditorResolve.current = undefined
    resolve?.(kept)
  }
  const editPickedImage = (image: PromptImage): Promise<PromptImage | undefined> => new Promise(resolve => {
    pendingEditorResolve.current = resolve
    setImageEditorTarget({ image })
  })
  const openStagedImageEditor = (image: PromptImage, index: number) => {
    Keyboard.dismiss()
    pendingEditorResolve.current = undefined
    setImageEditorTarget({ image, index })
  }
  const cancelImageEditor = () => {
    const target = imageEditorTarget
    if (target === undefined) return
    // Cancelling a fresh capture keeps the untouched photo so nothing is lost; a
    // cancelled staged edit simply leaves the staged image alone.
    closeImageEditor(target.index === undefined ? target.image : undefined)
  }
  const saveEditedImage = (exported: ImageEditorExport): string | undefined => {
    const target = imageEditorTarget
    if (target === undefined) return strings.chat.imageEditorFailedBody
    let built: PromptImage
    try {
      built = editedPromptImage(exported, target.image)
    } catch {
      return strings.chat.imageEditorFailedBody
    }
    if (target.index === undefined) {
      const problem = validatePromptImages([...images, built], imageEditLimits)
      if (problem !== undefined) return problem
      closeImageEditor(built)
      return undefined
    }
    const next = images.map((image, index) => index === target.index ? built : image)
    const problem = validatePromptImages(next, imageEditLimits)
    if (problem !== undefined) return problem
    setImages(next)
    setImageEditorTarget(undefined)
    return undefined
  }
  useEffect(() => () => {
    const resolve = pendingEditorResolve.current
    pendingEditorResolve.current = undefined
    resolve?.(undefined)
  }, [])
  useEffect(() => () => { uploadControllerRef.current?.abort() }, [])
  useEffect(() => {
    if (connection.phase !== 'connected') uploadControllerRef.current?.abort()
  }, [connection.phase])
  const { canAttachImages, attachmentPicking, pickImages, takePhoto, pickFiles } = useChatAttachments({
    session, memoryKey, images, setImages, stagedFiles, setStagedFiles, sessionGenerationRef, editPickedImage,
  })
  const [plusMenuOpen, setPlusMenuOpen] = useState(false)
  const [referenceChatOpen, setReferenceChatOpen] = useState(false)
  const [stagedReferences, setStagedReferences] = useState<ReferenceChatCandidate[]>([])
  const [modePickerOpen, setModePickerOpen] = useState(false)
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false)
  const [toolPickerOpen, setToolPickerOpen] = useState(false)
  const [toolsMode, setToolsMode] = useState<'files' | 'terminal'>()
  const [fileLinkPath, setFileLinkPath] = useState<string>()
  const { promptsPickerOpen, setPromptsPickerOpen, customPrompts, promptEditing,
    setPromptEditing, promptsManagerOpen, setPromptsManagerOpen, promptsLoading, savePromptEdit, deletePrompt } = useChatPrompts(connection.phase)
  const [permissionOptions, setPermissionOptions] = useState<PermissionSelect['options']>()
  const [permissionError, setPermissionError] = useState<string>()
  const [permissionRevision, setPermissionRevision] = useState(0)
  const [permissionLoading, setPermissionLoading] = useState(false)
  const inlinePermissionOptions = session?.projections?.values?.permissions
  useEffect(() => {
    setPermissionOptions(undefined)
    setPermissionError(undefined)
    setPermissionLoading(false)
    if (session === undefined || session.backend === 'codex' || connection.phase !== 'connected') return
    const projected = sessionPermissions(session)
    if (projected === undefined || projected.options.length > 0) return
    const controller = new AbortController()
    setPermissionLoading(true)
    void Promise.resolve().then(() => requireSessionTools().permissionOptions(controller.signal))
      .then(options => { if (!controller.signal.aborted) setPermissionOptions(options) })
      .catch(() => { if (!controller.signal.aborted) setPermissionError(strings.tools.permissionUnavailable) })
      .finally(() => { if (!controller.signal.aborted) setPermissionLoading(false) })
    return () => controller.abort()
  }, [session?.sessionId, session?.backend, inlinePermissionOptions, connection.phase, permissionPickerOpen, permissionRevision])
  // A carrier drop must not close the full-screen editor: the draft stays
  // editable offline, so only a conversation change collapses it.
  useEffect(() => { setToolsMode(undefined) }, [session?.sessionId, connection.phase])
  useEffect(() => { setComposerExpanded(false) }, [session?.sessionId])
  // The mode (agent-preset) roster is deployment-level; fetch it once per connection.
  useEffect(() => {
    if (connection.phase !== 'connected' || session?.backend === 'codex') return
    if (useAppStore.getState().agentPresetOptions !== undefined) return
    void loadAgentPresets()
  }, [connection.phase, session?.sessionId, session?.backend, loadAgentPresets])
  const [composerExpanded, setComposerExpanded] = useState(false)
  const [reconnectingSession, setReconnectingSession] = useState(false)
  const [newSessionPending, setNewSessionPending] = useState(false)
  const creatingSessionRef = useRef(false)
  const lastNewSessionTimeRef = useRef(0)
  const { visibleMessages, visibleSections, uiBySection, visibleUiIds, queueItems, childSessions, teamState, rootSession } = useChatTranscript({ session, sessions, messages, hostId })
  // A subagent conversation belongs to the root agent's team. The header offers
  // one tap back to that conversation (hardware back keeps returning to the
  // immediate parent), and the dock reads the same root, so the roster and the
  // return target can never disagree.
  const rootAgentSession = session !== undefined && isSubagentSession(session)
    ? (rootSession !== undefined && rootSession.sessionId !== session.sessionId
      ? rootSession
      : sessions.find(item => item.sessionId === session.parentSessionId))
    : undefined
  // Sent-failure affordance: the whole conversation keeps one compact retry row,
  // rendered only under the newest failed/unconfirmed message. Older failures
  // keep their message actions but lose the full-width red row that was crowding
  // the bottom of the list. The ids array is memoised by value so assistant
  // streaming updates do not invalidate every list cell through `renderChatItem`.
  const undeliveredMessages = visibleMessages.filter((item): item is ChatMessage =>
    item.kind === 'message' && (item.sendState === 'failed' || item.sendState === 'unconfirmed'))
  const latestUndelivered = undeliveredMessages.at(-1)
  const resendLatestId = latestUndelivered?.id
  const resendIdsKey = undeliveredMessages.map(item => item.id).join('\u0000')
  const resendIds = useMemo(() => resendIdsKey.length === 0 ? undefined : resendIdsKey.split('\u0000'), [resendIdsKey])
  // Keep the live lang binding read here (not inside the memo) so a language
  // change is reflected on the next render, same as the rest of the screen.
  const resendStatus = latestUndelivered === undefined
    ? undefined
    : latestUndelivered.sendError ?? (latestUndelivered.sendState === 'failed' ? strings.chat.sendFailed : strings.chat.sendUnconfirmed)
  // A retry that lost its image payloads must not resend as text-only.
  const resendMissingImages = undeliveredMessages.some(item =>
    (item.images?.length ?? 0) > 0 && (item.promptImages?.length ?? 0) === 0)
  const panelOpen = composerExpanded || plusMenuOpen || modelPickerOpen || modePickerOpen || permissionPickerOpen
    || workspacePickerOpen || toolPickerOpen || toolsMode !== undefined || trajectory || mentionType !== null
    || promptsPickerOpen || promptsManagerOpen || promptEditing !== null || sessionInfoOpen
  // The chat no longer renders a floating "jump to latest" button: tapping it
  // kept re-anchoring the list and was the source of the reported jumping. The
  // scroll hook still auto-follows the latest turn and re-pins on a manual fling
  // to the bottom, so jumping back stays available without an overlay control.
  const { listRef, viewability, beginSendScroll,
    onListLayout, onListContentSizeChange, onListScroll, onListDragEnd, onListMomentumEnd,
    onScrollBeginDrag, onMomentumScrollBegin } = useChatScroll({
    session, messages, visibleMessages, visibleSections, memoryScope, memoryKey,
    panelOpen, historyLoadingOlder, busy, setTrajectory,
  })

  const { colors } = useTheme()
  const styles = useThemedStyles(createStyles)
  // Landscape phones are short: keep the composer compact when the IME is up
  // and let the list use a readable centred column on wide windows.
  const { landscape, compactHeight, height, width, contentMaxWidth } = useResponsiveLayout()
  const compactComposer = landscape || compactHeight
  const composerInputMaxHeight = compactComposer ? Math.max(48, Math.min(96, Math.round(height * 0.22))) : 126
  // Tablets keep the session list visible beside the conversation. Short
  // landscape phone windows stay single-pane; a wide tablet keeps the split
  // even while the IME reduces the window height.
  const tabletSplit = width >= 760 && (height >= 520 || width >= 1000)
  useEffect(() => {
    if (tabletSplit) setSessionsOpen(false)
  }, [tabletSplit])
  const readableColumn = { width: '100%' as const, maxWidth: contentMaxWidth, alignSelf: 'center' as const }

  const openSessionsDrawer = useCallback(() => {
    Keyboard.dismiss()
    setMentionType(null)
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined)
    // Reached from a conversation, so the sidebar may be swiped away again.
    setDrawerSwipeUnlocked(true)
    setSessionsOpen(true)
  }, [setMentionType])

  // A Codex live subscription is only kept while its conversation is actually on
  // screen. Opening the single-pane session list drops it so the Host can release the
  // thread writer lock once idle; closing the list resumes it for the same conversation.
  // Tablet split keeps the conversation visible, so it never suspends here.
  const sessionsOpenRef = useRef(sessionsOpen)
  useEffect(() => {
    const wasOpen = sessionsOpenRef.current
    sessionsOpenRef.current = sessionsOpen
    if (tabletSplit || sessionsOpen === wasOpen) return
    if (useAppStore.getState().selectedSession?.backend !== 'codex') return
    if (sessionsOpen) useAppStore.getState().releaseCodexLiveStream()
    else void useAppStore.getState().resumeCodexLiveStream()
  }, [sessionsOpen, tabletSplit])

  // Backgrounding the app also leaves the conversation. A short grace period keeps the
  // stream alive across camera/gallery activities that briefly background the app
  // while composing; a real background releases the Codex subscription, and returning
  // to the foreground resumes it. Unmounting the screen releases it immediately.
  useEffect(() => {
    let backgroundTimer: ReturnType<typeof setTimeout> | undefined
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'background' || state === 'inactive') {
        if (backgroundTimer !== undefined) return
        backgroundTimer = setTimeout(() => {
          backgroundTimer = undefined
          if (AppState.currentState === 'active') return
          useAppStore.getState().releaseCodexLiveStream()
        }, 1500)
        return
      }
      if (state !== 'active') return
      if (backgroundTimer !== undefined) {
        clearTimeout(backgroundTimer)
        backgroundTimer = undefined
        return
      }
      void useAppStore.getState().resumeCodexLiveStream()
    })
    return () => {
      subscription.remove()
      if (backgroundTimer !== undefined) clearTimeout(backgroundTimer)
      useAppStore.getState().releaseCodexLiveStream()
    }
  }, [])

  // Swipe right gesture to open sessions drawer with haptic feedback
  const edgeSwipeResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onStartShouldSetPanResponderCapture: () => false,
        onMoveShouldSetPanResponder: (_evt, g) => {
          if (tabletSplit || sessionsOpen) return false
          return shouldStartSwipeRightToOpen({ dx: g.dx, dy: g.dy, x0: g.x0 }, trajectory)
        },
        onMoveShouldSetPanResponderCapture: (_evt, g) => {
          if (tabletSplit || sessionsOpen) return false
          return shouldStartSwipeRightToOpen({ dx: g.dx, dy: g.dy, x0: g.x0 }, trajectory)
        },
        onPanResponderTerminationRequest: () => false,
        onPanResponderRelease: (_evt, g) => {
          if (tabletSplit || sessionsOpen) return
          if (shouldConfirmSwipeRightOpen({ dx: g.dx, dy: g.dy, x0: g.x0, vx: g.vx })) {
            openSessionsDrawer()
          }
        },
      }),
    [sessionsOpen, tabletSplit, trajectory, openSessionsDrawer]
  )
  const swipeStartRef = useRef<{ x0: number; y0: number; t0: number } | undefined>(undefined)
  const swipeRightTouchProps = useMemo(
    () => ({
      ...edgeSwipeResponder.panHandlers,
      onTouchStart: (e: { nativeEvent: { pageX: number; pageY: number } }) => {
        swipeStartRef.current = { x0: e.nativeEvent.pageX, y0: e.nativeEvent.pageY, t0: Date.now() }
      },
      onTouchEnd: (e: { nativeEvent: { pageX: number; pageY: number } }) => {
        const start = swipeStartRef.current
        swipeStartRef.current = undefined
        if (start === undefined || tabletSplit || sessionsOpen) return
        const dx = e.nativeEvent.pageX - start.x0
        const dy = e.nativeEvent.pageY - start.y0
        const dt = Math.max(16, Date.now() - start.t0)
        const vx = dx / dt
        if (
          shouldStartSwipeRightToOpen({ dx, dy, x0: start.x0 }, trajectory)
          && shouldConfirmSwipeRightOpen({ dx, dy, x0: start.x0, vx })
        ) {
          openSessionsDrawer()
        }
      },
    }),
    [edgeSwipeResponder, tabletSplit, sessionsOpen, trajectory, openSessionsDrawer],
  )

  // Artifact changes must invalidate FlatList cells even when their section is
  // reused (a later turn can patch a card owned by an earlier turn).
  const renderChatItem = useCallback(({ item }: { item: ChatSection }) => {
    if (item.kind === 'process') {
      return <ChatProcessGroup items={item.items} artifacts={uiBySection.get(item.key)?.cards ?? EMPTY_UI_ARTIFACTS} updatedArtifacts={uiBySection.get(item.key)?.pointers ?? EMPTY_UI_ARTIFACTS} availableUiIds={visibleUiIds} busyAction={busy} onApproval={respondApproval} onQuestion={respondQuestion} />
    }
    const resend = item.item.kind === 'message' && item.item.id === resendLatestId
    return <ChatItemView item={item.item} busyAction={busy} compact={false} onApproval={respondApproval} onQuestion={respondQuestion}
      resendIds={resend ? resendIds : undefined} resendStatus={resend ? resendStatus : undefined}
      resendMissingImages={resend ? resendMissingImages : undefined} />
  }, [busy, respondApproval, respondQuestion, uiBySection, visibleUiIds,
    resendLatestId, resendIds, resendStatus, resendMissingImages])

  // Keep chat's back action at the top of the Android responder stack. The
  // navigator also handles back globally, but a freshly mounted FlatList can
  // otherwise win the first dispatch while its cells are being measured.
  // Back inside a subagent child returns to its parent conversation (the
  // official subagent UI's navigation), instead of leaving the chat entirely.
  const backFromChat = () => {
    const parent = session !== undefined && isSubagentSession(session)
      ? sessions.find(item => item.sessionId === session.parentSessionId)
      : undefined
    if (parent !== undefined) {
      Keyboard.dismiss()
      void openSession(parent)
      return
    }
    if (!tabletSplit && !sessionsOpen) {
      openSessionsDrawer()
      return
    }
    Keyboard.dismiss()
    onBack()
  }
  const onBackRef = useRef(backFromChat)
  onBackRef.current = backFromChat
  useChatBackHandler(composerInputRef, () => onBackRef.current(), [
    { open: composerExpanded, close: () => setComposerExpanded(false) },
    { open: plusMenuOpen, close: () => { Keyboard.dismiss(); setPlusMenuOpen(false) } },
    { open: referenceChatOpen, close: () => setReferenceChatOpen(false) },
    { open: modelPickerOpen, close: () => setModelPickerOpen(false) },
    { open: modePickerOpen, close: () => setModePickerOpen(false) },
    { open: permissionPickerOpen, close: () => setPermissionPickerOpen(false) },
    { open: workspacePickerOpen, close: () => setWorkspacePickerOpen(false) },
    { open: toolPickerOpen, close: () => setToolPickerOpen(false) },
    { open: promptEditing !== null, close: () => { setPromptEditing(null); setPromptsManagerOpen(true) } },
    { open: promptsManagerOpen, close: () => { setPromptsManagerOpen(false); setPromptsPickerOpen(true) } },
    { open: promptsPickerOpen, close: () => setPromptsPickerOpen(false) },
    { open: toolsMode !== undefined, close: () => { setToolsMode(undefined); setFileLinkPath(undefined) } },
    { open: trajectory, close: () => setTrajectory(false) },
  ])

  const botTeamState = useBotTeamStore(state => state.state)

  const openLink = useCallback((href: string) => {
    // 1. Session reference navigation: dsh-session:<base64url>
    const targetSessionId = decodeSessionMentionUri(href)
    if (targetSessionId !== undefined) {
      const matchedBot = botTeamState?.bots.find(entry => entry.sessionId === targetSessionId)
      if (matchedBot !== undefined) {
        onBotModeChange?.(true)
        onSelectBot?.(matchedBot.id)
        return
      }
      const targetSession = sessions.find(candidate => candidate.sessionId === targetSessionId)
      if (targetSession !== undefined) {
        void openSession(targetSession)
      }
      return
    }

    // 2. Safe external web URLs (http, https, mailto, www.*)
    if (openSafeExternalUrl(href)) return

    // 3. Workspace file link
    const path = markdownFilePath(href)
    if (path === undefined) return
    setFileLinkPath(path)
    setToolsMode('files')
  }, [openSession, session?.backend, sessions, botTeamState?.bots, onBotModeChange, onSelectBot])

  const connected = connection.phase === 'connected' && !reconnectingSession
  const hasActiveChatItem = visibleMessages.some(isActiveChatItem)
  const replyActive = connected && (busy === 'send-message' || busy === 'stop-session' || (session?.running ?? false) || hasActiveChatItem)

  const lastAgentSessionByScopeRef = useRef<Record<string, typeof session>>({})
  useEffect(() => {
    if (!botMode && session !== undefined && !isKnownBotSessionId(session.sessionId, botTeamState, memoryScope)) {
      lastAgentSessionByScopeRef.current[memoryScope] = session
    }
  }, [botMode, session, botTeamState, memoryScope])

  const autoSelectingRef = useRef(false)
  useEffect(() => {
    if (botMode) return
    const sessionIsBot = session !== undefined && isKnownBotSessionId(session.sessionId, botTeamState, memoryScope)
    if (sessionIsBot) {
      useAppStore.setState({ selectedSession: undefined })
    }
    if ((session !== undefined && !sessionIsBot) || busy !== undefined || autoSelectingRef.current) return
    const candidates = sessions.filter(
      item => !archivedSessionIds.includes(item.sessionId) && !isKnownBotSessionId(item.sessionId, botTeamState, memoryScope),
    )
    const remembered = lastAgentSessionByScopeRef.current[memoryScope]
    const preferred = remembered
      ? candidates.find(item => item.sessionId === remembered.sessionId && (item.backend ?? 'harness') === (remembered.backend ?? 'harness'))
      : undefined
    const target = preferred ?? [...candidates].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]
    if (target) {
      const capturedScope = memoryScope
      autoSelectingRef.current = true
      void openSession(target).finally(() => {
        if (browseScope(useAppStore.getState()) === capturedScope) {
          autoSelectingRef.current = false
        } else {
          autoSelectingRef.current = false
        }
      })
    }
  }, [botMode, session, connected, busy, sessions, archivedSessionIds, openSession, botTeamState, memoryScope])

  useEffect(() => {
    if (!replyActive) setComposingDuringRun(false)
    else if (composingDuringRun) composerInputRef.current?.focus()
  }, [replyActive, composingDuringRun])

  const drawerElement = (inlineMode: boolean) => (
      <HostSessionsDrawer
        inline={inlineMode}
        botMode={botMode}
        onBotModeChange={onBotModeChange}
        dismissible={inlineMode || drawerSwipeUnlocked}
        onSelectBot={id => {
          markConversationChosen()
          onSelectBot?.(id)
        }}
      onOpenDeviceInfo={() => {
        Keyboard.dismiss()
        onOpenDeviceInfo?.()
      }}
      onOpenWorkspaces={() => {
        Keyboard.dismiss()
        if (onOpenWorkspaces) onOpenWorkspaces()
      }}
      onBack={inlineMode ? undefined : () => {
        Keyboard.dismiss()
        setSessionsOpen(false)
      }}
      backLabel={strings.chat.backToChat}
      onClose={() => {
        if (inlineMode) Keyboard.dismiss()
        else setSessionsOpen(false)
      }}
      onOpenAutomationTasks={() => {
        Keyboard.dismiss()
        setAutomationTasksOpen(true)
      }}
      onOpenPlugins={pluginsAvailable ? () => {
        Keyboard.dismiss()
        setPluginsOpen(true)
      } : undefined}
      onOpenHostSwitcher={onOpenHostSwitcher ? () => {
        Keyboard.dismiss()
        onOpenHostSwitcher()
      } : undefined}
      onOpenSettings={() => {
        Keyboard.dismiss()
        onOpenSettings?.()
      }}
      onNewSession={() => void startNewSession()}
      onSelect={async next => {
        markConversationChosen()
        onBotModeChange?.(false)
        const pending = openSession(next)
        const visible = useAppStore.getState().selectedSession?.sessionId === next.sessionId
        if (!inlineMode && visible) {
          setSessionsOpen(false)
        }
        if (await pending && !inlineMode && !visible) {
          setSessionsOpen(false)
        }
      }}
    />
  )

  if (botMode) {
    return (
      <KeyboardInset><>
        <View style={[styles.splitRoot, tabletSplit && styles.splitRootWide]}>
          {tabletSplit && <View style={styles.splitSidebar}>{drawerElement(true)}</View>}
          <View style={styles.splitMain} {...swipeRightTouchProps}>
            <BotModeScreen
              selectedId={botConversationId}
              onSelect={id => onSelectBot?.(id)}
              onAgentMode={() => onBotModeChange?.(false)}
              onOpenDrawer={openSessionsDrawer}
              onDeviceInfo={() => onOpenDeviceInfo?.()}
              onMore={() => onOpenSettings?.()}
              splitView={tabletSplit}
              drawerOpen={sessionsOpen || tabletSplit}
            />
          </View>
        </View>
        {sessionsOpen && !tabletSplit && drawerElement(false)}
        <PluginsModal visible={pluginsOpen} onClose={() => setPluginsOpen(false)} />
        <AutomationTasksModal
          visible={automationTasksOpen}
          onClose={() => setAutomationTasksOpen(false)}
          onOpenSession={async targetSession => {
            setAutomationTasksOpen(false)
            markConversationChosen()
            setSessionsOpen(false)
            onBotModeChange?.(false)
            await openSession(targetSession)
          }}
          onNewTask={async () => {
            setAutomationTasksOpen(false)
            markConversationChosen()
            setSessionsOpen(false)
            onBotModeChange?.(false)
            await createSession(workspaces[0]?.workspaceId)
          }}
        />
      </></KeyboardInset>
    )
  }

  if (session === undefined) {
    const emptyHeader = (
      <TopBar
        title={strings.chat.newChat}
        titleLines={1}
        onBack={tabletSplit ? undefined : openSessionsDrawer}
        backIcon={Menu}
        backLabel={strings.chat.openHostSessions}
        action={
          <>
            <IconButton
              label={strings.chat.newChat}
              icon={OfficialMenuIcons.newChat}
              dense
              onPress={() => void createSession(workspaces[0]?.workspaceId)}
              disabled={!connected || busy !== undefined}
            />
            {!connected && (
              <IconButton
                label={strings.chat.reconnect}
                icon={RefreshCw}
                dense
                onPress={() => {
                  if (onOpenHostSwitcher) onOpenHostSwitcher()
                  else void reconnect()
                }}
              />
            )}
          </>
        }
      />
    )
    return (
      <KeyboardInset><>
        <View style={[styles.splitRoot, tabletSplit && styles.splitRootWide]}>
          {tabletSplit && <View style={styles.splitSidebar}>{drawerElement(true)}</View>}
          <View style={styles.splitMain} {...swipeRightTouchProps}>
            <BlurHeaderFrame header={emptyHeader}>
              {headerHeight => (
                <View style={[styles.list, readableColumn, styles.emptyList, { paddingTop: headerHeight + spacing.xl }]}>
                  {busy !== undefined ? (
                    <View style={{ padding: spacing.xl, alignItems: 'center' }}>
                      <ActivityIndicator size="large" color={colors.primary} />
                    </View>
                  ) : (
                    <WelcomeMessage />
                  )}
                </View>
              )}
            </BlurHeaderFrame>
          </View>
        </View>
        {sessionsOpen && !tabletSplit && drawerElement(false)}
        <PluginsModal visible={pluginsOpen} onClose={() => setPluginsOpen(false)} />
        <AutomationTasksModal
          visible={automationTasksOpen}
          onClose={() => setAutomationTasksOpen(false)}
          onOpenSession={async targetSession => {
            setAutomationTasksOpen(false)
            markConversationChosen()
            setSessionsOpen(false)
            await openSession(targetSession)
          }}
          onNewTask={async () => {
            setAutomationTasksOpen(false)
            markConversationChosen()
            setSessionsOpen(false)
            await createSession(workspaces[0]?.workspaceId)
          }}
        />
      </></KeyboardInset>
    )
  }

  const submit = async () => {
    if (session === undefined) return
    // Read the live ref: the render-closure `draft` can lag the last keystrokes
    // typed right before the tap, silently dropping the tail of the message.
    const submittedDraft = draftRef.current
    const rawText = submittedDraft.trim()
    const submittedReferences = stagedReferences
    const refPrefix = submittedReferences.map(item => item.mentionText.trim()).join(' ')
    const text = [refPrefix, rawText].filter(Boolean).join(' ')
    const submittedQuotes = quotes
    const submittedImages = images
    const submittedFiles = stagedFiles
    // Everything below this gate clears the composer, so an offline tap has to
    // stop here: the draft stays, no optimistic row is created and the manual
    // send after reconnection is the only submission path.
    const intent = submitIntent({
      connected, sendReady, permissionSelecting, uploading: uploadingRef.current,
      hasContent: text.length > 0 || submittedQuotes.length > 0 || images.length > 0 || stagedFiles.length > 0,
    })
    if (intent !== 'submit') return
    let promptWithQuotes = text
    if (submittedQuotes.length > 0) {
      const formattedQuotes = submittedQuotes.map(formatQuoteText).join('\n\n')
      promptWithQuotes = text.length > 0 ? `${formattedQuotes}\n\n${text}` : formattedQuotes
    }
    let promptText = promptWithQuotes
    const targetSessionId = session.sessionId
    const sendSessionGen = sessionGenerationRef.current
    if (submittedFiles.length > 0) {
      const controller = new AbortController()
      uploadControllerRef.current?.abort()
      uploadControllerRef.current = controller
      uploadingRef.current = true
      setUploadingFiles(true)
      try {
        const rpc = requireConnectionRpc()
        const uploaded = await uploadStagedFilesToWorkspace(rpc, session.sessionId, submittedFiles, controller.signal)
        // A navigation, session switch, reconnection or unmount during a long
        // upload must never leak the prompt into another conversation.
        if (controller.signal.aborted) return
        if (sessionGenerationRef.current !== sendSessionGen
          || useAppStore.getState().selectedSession?.sessionId !== targetSessionId) return
        if (useAppStore.getState().connection.phase !== 'connected') {
          Alert.alert(strings.messageActions.failed, strings.messageActions.unavailable)
          return
        }
        promptText = formatUploadedFilesReferencePrompt(promptWithQuotes, uploaded)
      } catch (uploadError) {
        // Aborted uploads already restored (or discarded) their composer state;
        // do not surface a cancellation as a failure.
        if (controller.signal.aborted || (uploadError as Error | undefined)?.name === 'AbortError') return
        const isUnsupported = (uploadError as { code?: string })?.code === 'FEATURE_NOT_SUPPORTED'
        const errorMsg = isUnsupported
          ? strings.chat.uploadUnavailable
          : strings.chat.uploadFileFailed(submittedFiles[0]?.name ?? '', (uploadError as Error).message)
        Alert.alert(strings.messageActions.failed, errorMsg)
        return
      } finally {
        if (uploadControllerRef.current === controller) {
          uploadControllerRef.current = undefined
          uploadingRef.current = false
          setUploadingFiles(false)
        }
      }
    }
    if (promptText.length > LONG_DRAFT_MAX) {
      Alert.alert(strings.chat.draftTooLongTitle, strings.chat.draftTooLong(LONG_DRAFT_MAX))
      return
    }
    applyDraft('')
    setQuotes([])
    setImages([])
    setStagedFiles([])
    setStagedReferences([])
    setMentionType(null)
    resetSelection()
    const restoreScrollAfterRejectedSend = beginSendScroll()
    const outcome = await sendMessage(promptText, submittedImages)
    if (outcome === 'rejected') {
      restoreScrollAfterRejectedSend()
      // Nothing was persisted (command failure): restore the draft without
      // clobbering input typed while the send was in flight.
      if (sessionGenerationRef.current === sendSessionGen && useAppStore.getState().selectedSession?.sessionId === targetSessionId) {
        const inFlight = useBrowseMemory.getState().entries[memoryKey]?.draft ?? ''
        setDraft(inFlight.length === 0 ? submittedDraft : `${submittedDraft}\n${inFlight}`)
        setQuotes(previous => previous.length === 0 ? submittedQuotes : [...submittedQuotes, ...previous])
        setImages(previous => previous.length === 0 ? submittedImages : [...submittedImages, ...previous])
        setStagedReferences(previous => previous.length === 0 ? submittedReferences : [...submittedReferences, ...previous])
        setStagedFiles(current => {
          const combined = [...submittedFiles, ...current]
          let acc = 0
          return combined.filter(f => {
            if (acc + f.size <= MAX_TOTAL_FILES_BYTES) {
              acc += f.size
              return true
            }
            return false
          })
        })
      }
      Alert.alert(strings.messageActions.failed, useAppStore.getState().error ?? strings.messageActions.unavailable)
    } else if (outcome === 'sent') {
      const result = useAppStore.getState().commandResult
      if (result?.sessionId === session.sessionId && useAppStore.getState().selectedSession?.sessionId === session.sessionId) {
        Alert.alert(strings.mention.commandSection, result.text)
        useAppStore.setState({ commandResult: undefined })
      }
    }
    // 'kept': the row stays in the timeline with an inline failed/unconfirmed
    // state and a retry affordance — no Alert and no draft restore.
  }

  const openPlusMenu = () => {
    // The composer TextInput often still owns focus when the user taps +.
    // Dismissing the IME first gives the transparent Modal the full window and
    // keeps its sheet (including the close target) out of the keyboard's touch
    // region on Android.
    Keyboard.dismiss()
    setPlusMenuOpen(true)
  }

  const closePlusMenu = () => {
    Keyboard.dismiss()
    setPlusMenuOpen(false)
  }

  const openPromptsPicker = () => {
    Keyboard.dismiss()
    setMentionType(null)
    setPromptsPickerOpen(true)
  }

  const handleBack = () => {
    Keyboard.dismiss()
    if (trajectory) {
      setTrajectory(false)
      return
    }
    onBackRef.current()
  }

  const pickModel = async (group: ModelProviderGroup, model: ModelCatalogModel, reasoningEffort?: string) => {
    setModelPickerOpen(false)
    await selectModel({
      provider: group.id,
      model: model.id,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    })
  }

  const reconnectCurrentSession = async () => {
    if (reconnectingSession) return
    setReconnectingSession(true)
    try {
      await reconnect()
    } finally {
      setReconnectingSession(false)
    }
  }

  const supportsModeSelection = !['codex', 'cursor', 'antigravity', 'pi', 'opencode', 'claude', 'hermes'].includes(session.backend ?? 'harness')
  const currentAgentPresetId = session.agentPreset ?? agentPresetOptions?.find(option => option.isDefault)?.id
  const currentWorkspace = workspaces.find(workspace => workspace.sessionIds.includes(session.sessionId))
  const workspaceLabel = currentWorkspace?.title ?? strings.chat.workspaceNone
  const currentPresetRow = agentPresetOptions?.find(option => option.id === currentAgentPresetId)
  const modeLabel = currentAgentPresetId === undefined
    ? strings.chat.modeDefault
    : currentPresetRow === undefined
      ? builtinPresetName(currentAgentPresetId) ?? currentAgentPresetId
      : agentPresetName(currentPresetRow)

  const connectionRetrying = reconnectingSession || connection.phase === 'connecting' || connection.phase === 'reconnecting'
  const sendReady = connected && !busy?.startsWith('session:')
    && (session.backend !== 'codex' || codexReadySessionId === session.sessionId)
  const hasComposerContent = draft.trim().length > 0 || quotes.length > 0 || images.length > 0 || stagedFiles.length > 0 || stagedReferences.length > 0
  const compactRunning = replyActive && !hasComposerContent && !composingDuringRun
  const stopping = busy === 'stop-session'
  // Action entries (attachments, tools, prompts) still need the channel, but the
  // text field itself only blocks on composer-local states so an offline draft
  // can be typed, edited and kept for the manual send after reconnection.
  const inputEditable = composerEditable({ permissionSelecting, uploading: uploadingFiles })
  const composerDisabled = !connected || permissionSelecting || uploadingFiles
  const sendDisabled = !sendReady || permissionSelecting || !hasComposerContent || uploadingFiles
  const projectedPermissions = sessionPermissions(session)
  const permissions = projectedPermissions === undefined ? undefined : { ...projectedPermissions, options: permissionOptions ?? projectedPermissions.options }
  const currentPermission = permissions?.options.find(option => option.value === permissions.currentValue)
  const currentModel = sessionModels?.groups
    .find(group => group.id === sessionModels.current.provider)
    ?.models.find(model => model.id === sessionModels.current.model)
  const currentEffortId = sessionModels?.current.reasoningEffort ?? currentModel?.reasoning?.defaultEffort
  const currentEffortName = currentModel?.reasoning?.efforts.find(effort => effort.id === currentEffortId)?.name
    ?? currentEffortId
  const currentModelName = currentModel?.name ?? sessionModels?.current.model
  const currentModelLabel = currentEffortName === undefined
    ? currentModelName
    : `${currentModelName} · ${currentEffortName}`

  const pickMode = async (preset: string) => {
    setModePickerOpen(false)
    if (!connected || preset === session.agentPreset) return
    const applied = await selectAgentPreset(preset)
    if (!applied) {
      Alert.alert(
        strings.chat.modeLockedTitle,
        session.blank ? strings.chat.modeSelectFailedBody : strings.chat.modeLockedBody,
      )
    }
  }

  const pickToolMode = (mode: 'files' | 'terminal') => {
    setToolPickerOpen(false)
    setFileLinkPath(undefined)
    setToolsMode(mode)
  }

  const sessionBlank = visibleMessages.length === 0 && session.blank !== false

  const startNewSession = async () => {
    if (!connected) {
      Alert.alert(strings.chat.newChatFailedTitle, strings.chat.offlineNotice)
      return
    }
    const now = Date.now()
    if (now - lastNewSessionTimeRef.current < 800) return
    if (creatingSessionRef.current || newSessionPending || busy !== undefined) return

    if (sessionBlank) {
      Keyboard.dismiss()
      setMentionType(null)
      applyDraft('')
      setImages([])
      return
    }

    creatingSessionRef.current = true
    lastNewSessionTimeRef.current = now
    setNewSessionPending(true)
    try {
      const created = await createSession(currentWorkspace?.workspaceId)
      if (created) {
        onNewSession?.()
      } else {
        Alert.alert(strings.chat.newChatFailedTitle, strings.chat.newChatFailedBody)
      }
    } finally {
      creatingSessionRef.current = false
      setNewSessionPending(false)
    }
  }

  const sendPrompt = async (prompt: CustomPrompt) => {
    setPromptsPickerOpen(false)
    if (!connected) {
      Alert.alert(strings.chat.toolPromptSendFailed, strings.chat.offlineNotice)
      return
    }
    const outcome = await sendMessage(prompt.text)
    if (outcome === 'sent') AccessibilityInfo.announceForAccessibility(strings.chat.toolPromptSent(prompt.title))
    else if (outcome === 'rejected') Alert.alert(strings.chat.toolPromptSendFailed, strings.chat.toolPromptSendFailed)
  }

  const moveSessionToWorkspace = async (workspace: WorkspaceView) => {
    if (!connected) {
      Alert.alert(strings.chat.moveFailedTitle, strings.chat.offlineNotice)
      return
    }
    const previousId = session.sessionId
    const opened = await createSession(workspace.workspaceId)
    if (!opened) {
      Alert.alert(strings.chat.moveFailedTitle, strings.chat.moveFailedBody)
      return
    }
    // A blank conversation carries nothing to lose: recreate it inside the
    // chosen workspace and archive the old placeholder so it reads as a move.
    if (sessionBlank) await archiveSession(previousId)
  }

  const pickWorkspace = (workspace: WorkspaceView) => {
    setWorkspacePickerOpen(false)
    if (!connected) {
      Alert.alert(strings.chat.moveFailedTitle, strings.chat.offlineNotice)
      return
    }
    if (workspace.sessionIds.includes(session.sessionId)) return
    if (sessionBlank) {
      void moveSessionToWorkspace(workspace)
      return
    }
    Alert.alert(
      strings.chat.moveStartedTitle,
      strings.chat.moveStartedBody(workspace.title),
      [
        { text: strings.common.cancel, style: 'cancel' },
        { text: strings.chat.moveStartedConfirm, onPress: () => void moveSessionToWorkspace(workspace) },
      ],
    )
  }

  const pickPermission = (preset: string) => {
    setPermissionPickerOpen(false)
    const apply = () => void selectPermission(preset)
    if (preset === 'danger-full-access') {
      Alert.alert(
        session.backend === 'codex' ? strings.chat.codexFullAccessTitle : strings.chat.fullAccessTitle,
        session.backend === 'codex' ? strings.chat.codexFullAccessBody : strings.chat.fullAccessBody,
        [
          { text: strings.common.cancel, style: 'cancel' },
          { text: strings.chat.enable, style: 'destructive', onPress: apply },
        ],
      )
    } else apply()
  }

  // In a subagent conversation the way back to the owning agent is the primary
  // navigation: the header arrow returns to the root session instead of only
  // opening the drawer, and the drawer stays reachable with the existing
  // edge-swipe. Tablet split keeps its sidebar, so the root entry is a
  // breadcrumb subtitle there instead.
  const header = <>
      <TopBar
        plain
        title={sessionBlank ? '' : sessionTitle(session)}
        onTitlePress={sessionBlank ? undefined : () => { Keyboard.dismiss(); setMentionType(null); setSessionInfoOpen(true) }}
        titleLines={1}
        onBack={tabletSplit ? undefined : trajectory ? handleBack : rootAgentSession !== undefined ? () => { Keyboard.dismiss(); void openSession(rootAgentSession) } : openSessionsDrawer}
        backIcon={trajectory ? ArrowLeft : rootAgentSession !== undefined ? ArrowLeft : Menu}
        backLabel={trajectory ? strings.common.back : rootAgentSession !== undefined ? strings.chat.backToMainSession : strings.chat.openHostSessions}
        subtitle={tabletSplit && !trajectory && rootAgentSession !== undefined
          ? `${strings.chat.backToMainSession} · ${sessionTitle(rootAgentSession)}`
          : undefined}
        onSubtitlePress={tabletSplit && !trajectory && rootAgentSession !== undefined
          ? () => { Keyboard.dismiss(); void openSession(rootAgentSession) }
          : undefined}
        action={sessionBlank ? undefined : <>
          <IconButton label={trajectory ? strings.trajectory.close : strings.trajectory.open}
            icon={trajectory ? MessageSquare : ListTree} dense tint={trajectory ? colors.primary : undefined}
            onPress={() => { Keyboard.dismiss(); setMentionType(null); setTrajectory(value => !value) }} />
          <IconButton label={strings.chat.newChat} icon={OfficialMenuIcons.newChat} dense onPress={() => void startNewSession()} disabled={newSessionPending || busy !== undefined} />
        </>}
      />
      {!connected && (
        <Pressable style={styles.connectionBanner} accessibilityRole="button"
          accessibilityLabel={connectionRetrying ? strings.chat.reconnecting : strings.chat.offline}
          accessibilityState={{ disabled: connectionRetrying, busy: connectionRetrying }}
          accessibilityLiveRegion="polite" disabled={connectionRetrying}
          hitSlop={{ top: 7, bottom: 7 }}
          onPress={() => void reconnectCurrentSession()}>
          <View style={styles.connectionDot} />
          <Text style={styles.connectionBannerText}>
            {connectionRetrying ? <>{strings.chat.reconnecting.replace(/…$/, '')}<AnimatedEllipsis /></> : strings.chat.offline}
          </Text>
        </Pressable>
      )}
      {connected && busy === `session:${session.sessionId}` && (
        <View style={styles.connectionBanner} accessibilityRole="summary">
          <View style={[styles.connectionDot, { backgroundColor: colors.primary }]} />
          <Text style={styles.connectionBannerText}>
            {strings.chat.syncingHistory}
          </Text>
        </View>
      )}
    </>
  return (
    <ChatImageProvider value={imageLoader}><MarkdownLinkProvider onLinkPress={openLink}><KeyboardInset>
      {memoryError !== undefined && <Text accessibilityRole="alert" style={{color: colors.danger, padding: 8}}>{memoryError}</Text>}
      <View style={[styles.splitRoot, tabletSplit && styles.splitRootWide]}>
        {tabletSplit && (
          <View style={styles.splitSidebar}>
            {drawerElement(true)}
          </View>
        )}
        <View style={styles.splitMain} {...swipeRightTouchProps}>
      {/* Messages scroll beneath the frosted header; the trajectory view keeps its own fixed search bar below it. */}
      <BlurHeaderFrame header={header} inset={trajectory}>{headerHeight => <ChatErrorBoundary key={session.sessionId} resetKey={session.sessionId}>{trajectory ? <ChatTrajectory key={session.sessionId} items={messages} renderImages={images => <ChatImages images={images} />} hasMore={historyHasMore} loading={historyLoadingOlder} loadOlder={() => void loadOlderHistory()} renderItem={item => <ChatItemView item={item} compact={false} busyAction={busy} onApproval={respondApproval} onQuestion={respondQuestion} />} /> : <>
        <FlatList
          ref={listRef}
          key={session.sessionId}
          style={[styles.list, readableColumn]}
          contentContainerStyle={[styles.listContent, { paddingTop: headerHeight + spacing.xl }, visibleMessages.length === 0 ? styles.emptyList : styles.shortConversation]}
          data={visibleSections}
          keyExtractor={item => item.key}
          renderItem={renderChatItem}
          initialNumToRender={6}
          maxToRenderPerBatch={6}
          updateCellsBatchingPeriod={16}
          windowSize={7}
          removeClippedSubviews={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          onLayout={onListLayout}
          onContentSizeChange={onListContentSizeChange}
          onScroll={onListScroll}
          onViewableItemsChanged={viewability}
          onScrollToIndexFailed={info => {
            listRef.current?.scrollToOffset({offset: Math.max(0, info.averageItemLength * info.index), animated: false})
          }}
          maintainVisibleContentPosition={{minIndexForVisible: 0}}
          scrollEventThrottle={16}
          onScrollBeginDrag={onScrollBeginDrag}
          onScrollEndDrag={onListDragEnd}
          onMomentumScrollBegin={onMomentumScrollBegin}
          onMomentumScrollEnd={onListMomentumEnd}
          ListEmptyComponent={busy === `session:${session.sessionId}`
            ? <View style={{ padding: spacing.xl }}><ActivityIndicator size="large" color={colors.primary} /></View>
            : <WelcomeMessage />}
          ListHeaderComponent={historyHasMore ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={strings.chat.older}
              disabled={historyLoadingOlder}
              onPress={() => void loadOlderHistory()}
              style={styles.olderButton}
            >
              {historyLoadingOlder
                ? <ActivityIndicator size="small" color={colors.primary} />
                : <Text style={styles.olderText}>{strings.chat.older}</Text>}
            </Pressable>
          ) : undefined}
        />
      </>}</ChatErrorBoundary>}</BlurHeaderFrame>


      {mentionType !== null && (
        <Pressable
          style={styles.mentionBackdrop}
          onPress={() => { closeMention(); Keyboard.dismiss() }}
          accessibilityRole="button"
          accessibilityLabel={strings.common.close}
        />
      )}
      <View style={styles.composerWrap}>
        <View style={[styles.composerInner, readableColumn]}>
        {connected && (session.backend === undefined || session.backend === 'harness' || Boolean(session.projections?.values?.todos) || Boolean(session.projections?.values?.goal) || childSessions.length > 0 || (teamState !== undefined && teamState.members.length > 0)) && (
          <SessionActivityDock
            key={`${memoryKey}:${chatImageConnectionGeneration()}`}
            session={session}
            childSessions={childSessions}
            teamState={teamState}
            sessions={sessions}
            onOpenSession={targetSession => void openSession(targetSession)}
          />
        )}
        {queueItems.length > 0 && <QueueDock items={queueItems} />}

        {images.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={styles.imageTray}>
            {images.map((image, index) => (
              <View key={`${index}:${image.bytes}`} style={styles.imagePreviewWrap}>
                {/* Tapping the picture only previews it full-screen; the pencil badge edits. */}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={image.name ?? strings.chat.unnamedImage}
                  onPress={() => setPreviewImageUri(image.uri)}
                  style={styles.imagePreviewButton}
                >
                  <Image source={{ uri: image.uri }} style={styles.imagePreview} resizeMode="cover" />
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={strings.chat.editImage(image.name ?? `${index + 1}`)}
                  onPress={() => openStagedImageEditor(image, index)}
                  style={styles.imageEditBadge}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                  <Pencil size={11} color={colors.white} />
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={strings.chat.removeImage(image.name ?? `${index + 1}`)}
                  onPress={() => setImages(current => current.filter((_, imageIndex) => imageIndex !== index))}
                  style={styles.removeImageButton}
                >
                  <X size={13} color={colors.white} />
                </Pressable>
              </View>
            ))}
          </ScrollView>
        )}
        {stagedFiles.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={styles.fileTray}>
            {stagedFiles.map((file, index) => (
              <View key={`${file.id}:${index}`} style={styles.fileCard}>
                <FileText size={16} color={colors.primary} />
                <View style={styles.fileCardMeta}>
                  <Text style={styles.fileCardName} numberOfLines={1}>{file.name}</Text>
                  <Text style={styles.fileCardSize}>{formatFileBytes(file.size)}</Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={file.name ? `移除文件“${file.name}”` : '移除文件'}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                  onPress={() => setStagedFiles(current => current.filter((_, fileIndex) => fileIndex !== index))}
                  style={styles.removeFileButton}
                >
                  <X size={13} color={colors.muted} />
                </Pressable>
              </View>
            ))}
          </ScrollView>
        )}
        {uploadingFiles && (
          <Text style={[styles.fileCardSize, { paddingHorizontal: spacing.md, paddingBottom: spacing.xs }]}>
            {strings.chat.uploadingFile(stagedFiles[0]?.name ?? '')}
          </Text>
        )}
        <ReferencedChatPills
          items={stagedReferences}
          onRemove={sid => setStagedReferences(current => current.filter(item => item.sessionId !== sid))}
        />
        <ChatComposer
          backend={session.backend} draft={draft} input={mentionInput}
          quotes={quotes} onRemoveQuote={index => setQuotes(current => current.filter((_, i) => i !== index))}
          replyActive={replyActive} stopping={stopping} compactRunning={compactRunning}
          hasComposerContent={hasComposerContent} connected={connected} editable={inputEditable}
          composerDisabled={composerDisabled} sendDisabled={sendDisabled}
          compactComposer={compactComposer} composerInputMaxHeight={composerInputMaxHeight}
          model={{ available: sessionModels !== undefined, label: currentModelLabel, selecting: modelSelecting, onOpen: () => setModelPickerOpen(true) }}
          voice={{
            available: connected && harnessVoice && voice.available,
            phase: voice.phase,
            elapsedMs: voice.elapsedMs,
            onToggle: () => void voice.toggle(),
            onCancel: () => void voice.cancel(),
          }}
          promptsPickerOpen={promptsPickerOpen} onExpand={() => setComposingDuringRun(true)}
          onOpenExpand={() => setComposerExpanded(true)}
          onOpenActions={openPlusMenu} onOpenPrompts={openPromptsPicker}
          onSummarizeLink={supportsAppApis() ? summarizeLink : undefined}
          onSubmit={() => void submit()} onStop={() => void stopSession()}
        />
        </View>
      </View>
      <ExpandedComposer
        visible={composerExpanded}
        onClose={() => setComposerExpanded(false)}
        backend={session.backend}
        draft={draft}
        quotes={quotes}
        onRemoveQuote={index => setQuotes(current => current.filter((_, i) => i !== index))}
        input={mentionInput}
        replyActive={replyActive}
        stopping={stopping}
        sendDisabled={sendDisabled}
        onSubmit={() => void submit()}
        onStop={() => void stopSession()}
      />
        </View>
      </View>

      <ChatActionMenu
        visible={plusMenuOpen} onClose={closePlusMenu}
        canAttachImages={canAttachImages} attachmentPicking={attachmentPicking}
        takePhoto={takePhoto} pickImages={pickImages} pickFiles={pickFiles}
        workspaceLabel={workspaceLabel} modeLabel={modeLabel}
        supportsModeSelection={supportsModeSelection} agentPresetSelecting={agentPresetSelecting}
        toolsAvailable={connected}
        permissionsAvailable={permissions !== undefined} permissionSelecting={permissionSelecting}
        permissionDisabled={permissionSelecting || (replyActive && !hasComposerContent)}
        permissionLabel={permissions === undefined ? undefined : permissionDisplayName(permissions.currentValue, currentPermission?.name)}
        onReferenceChat={(session.backend ?? 'harness') === 'harness' ? () => setReferenceChatOpen(true) : undefined}
        onOpenWorkspace={() => setWorkspacePickerOpen(true)} onOpenMode={() => setModePickerOpen(true)}
        onOpenTools={() => setToolPickerOpen(true)} onOpenPermissions={() => setPermissionPickerOpen(true)}
      />

      <ReferenceChatModal
        visible={referenceChatOpen}
        currentSessionId={session.sessionId}
        botState={botTeamState}
        onClose={() => setReferenceChatOpen(false)}
        onPick={(_mentionText, candidate) => {
          setStagedReferences(current =>
            current.some(item => item.sessionId === candidate.sessionId)
              ? current
              : [...current, candidate],
          )
        }}
      />

      <ModelPicker
        visible={modelPickerOpen}
        models={sessionModels}
        onClose={() => setModelPickerOpen(false)}
        onPick={pickModel}
      />
      {toolsMode !== undefined && connected && (
        <SessionToolsPanel
          key={`${session.sessionId}:${toolsMode}:${fileLinkPath ?? ''}`}
          mode={toolsMode}
          sessionId={session.sessionId}
          initialFile={toolsMode === 'files' ? fileLinkPath : undefined}
          onClose={() => { setToolsMode(undefined); setFileLinkPath(undefined) }}
        />
      )}
      <PermissionPicker loading={permissionLoading} error={permissionError} onRetry={() => setPermissionRevision(v => v + 1)} visible={permissionPickerOpen} permissions={permissions} onClose={() => setPermissionPickerOpen(false)} onPick={pickPermission} />
      <ModePicker visible={modePickerOpen} options={agentPresetOptions} current={currentAgentPresetId} loading={agentPresetLoading} selecting={agentPresetSelecting} onClose={() => setModePickerOpen(false)} onPick={pickMode} />
      {sessionInfoOpen && <SessionInfo
        key={`${hostId}:${session.sessionId}`}
        session={session}
        workspace={currentWorkspace}
        onClose={() => setSessionInfoOpen(false)}
        onOpenWorkspace={() => {
          setSessionInfoOpen(false)
          if (onOpenWorkspaces !== undefined) onOpenWorkspaces(currentWorkspace === undefined ? undefined : workspaceStableKey(currentWorkspace, hostPlatform))
          else openSessionsDrawer()
        }}
      />}
      {sessionsOpen && !tabletSplit && drawerElement(false)}
      <WorkspacePicker visible={workspacePickerOpen} workspaces={workspaces} currentSessionId={session.sessionId} sessionBackend={session.backend} busy={busy} onClose={() => setWorkspacePickerOpen(false)} onPick={pickWorkspace} onManage={() => { setWorkspacePickerOpen(false); openSessionsDrawer() }} />
      <ToolAccessPicker visible={toolPickerOpen} onClose={() => setToolPickerOpen(false)} onPick={pickToolMode} />
      <PromptsPicker
        visible={promptsPickerOpen}
        prompts={customPrompts ?? BUILT_IN_PROMPTS}
        onClose={() => setPromptsPickerOpen(false)}
        onPick={prompt => void sendPrompt(prompt)}
        onManage={() => { setPromptsPickerOpen(false); setPromptsManagerOpen(true) }}
      />
      <PromptsManager
        visible={promptsManagerOpen}
        prompts={customPrompts ?? BUILT_IN_PROMPTS}
        promptsLoading={promptsLoading}
        onBack={() => { setPromptsManagerOpen(false); setPromptsPickerOpen(true) }}
        onClose={() => setPromptsManagerOpen(false)}
        onAdd={() => { setPromptsManagerOpen(false); setPromptEditing('new') }}
        onEdit={prompt => { setPromptsManagerOpen(false); setPromptEditing(prompt) }}
        onDelete={prompt => {
          Alert.alert(strings.chat.toolPromptDeleteTitle(prompt.title), strings.chat.toolPromptDeleteBody, [
            { text: strings.common.cancel, style: 'cancel' },
            { text: strings.common.delete, style: 'destructive', onPress: () => void deletePrompt(prompt) },
          ])
        }}
      />
      <PromptEditor
        visible={promptEditing !== null}
        prompt={promptEditing === 'new' || promptEditing === null ? undefined : promptEditing}
        promptsLoading={promptsLoading}
        onBack={() => { setPromptEditing(null); setPromptsManagerOpen(true) }}
        onClose={() => setPromptEditing(null)}
        onSave={(title, text) => void savePromptEdit(title, text)}
      />
      <Modal
        visible={previewImageUri !== undefined}
        transparent
        animationType="fade"
        onRequestClose={() => setPreviewImageUri(undefined)}
        statusBarTranslucent
      >
        {/* Tap anywhere on the picture to close; the picture itself must not swallow taps,
            so the press target is the container, not a sibling under the image. */}
        <Pressable
          style={styles.lightboxBackdrop}
          accessibilityRole="button"
          accessibilityLabel={strings.common.close}
          onPress={() => setPreviewImageUri(undefined)}
        >
          {previewImageUri !== undefined && (
            <Image
              source={{ uri: previewImageUri }}
              style={styles.lightboxImage}
              resizeMode="contain"
            />
          )}
          {imageOcrAvailable() && (
            <Pressable
              style={[styles.lightboxClose, { right: 72 }]}
              onPress={runImageOcr}
              accessibilityRole="button"
              accessibilityLabel={strings.chat.ocrExtract}
              accessibilityState={{ busy: ocrBusy, disabled: ocrBusy }}
              disabled={ocrBusy}
              hitSlop={12}
            >
              {ocrBusy
                ? <ActivityIndicator size="small" color="#ffffff" />
                : <ScanText size={22} color="#ffffff" />}
            </Pressable>
          )}
          <Pressable
            style={styles.lightboxClose}
            onPress={() => setPreviewImageUri(undefined)}
            accessibilityRole="button"
            accessibilityLabel={strings.common.close}
            hitSlop={12}
          >
            <X size={24} color="#ffffff" />
          </Pressable>
        </Pressable>
      </Modal>
      <PluginsModal visible={pluginsOpen} onClose={() => setPluginsOpen(false)} />
      <AutomationTasksModal
        visible={automationTasksOpen}
        onClose={() => setAutomationTasksOpen(false)}
        onOpenSession={async targetSession => {
          setAutomationTasksOpen(false)
          await openSession(targetSession)
        }}
        onNewTask={async () => {
          setAutomationTasksOpen(false)
          await createSession(currentWorkspace?.workspaceId)
        }}
      />
      {imageEditorTarget !== undefined && (
        <ImageEditor
          key={`${String(imageEditorTarget.index ?? 'capture')}:${imageEditorTarget.image.bytes}`}
          source={imageEditorTarget.image}
          maxEdge={imageEditorMaxEdge}
          onCancel={cancelImageEditor}
          onSave={saveEditedImage}
        />
      )}
    </KeyboardInset></MarkdownLinkProvider></ChatImageProvider>
  )
}

export { ModalSurface,usePickerListMaxHeight } from './chat/modal'
