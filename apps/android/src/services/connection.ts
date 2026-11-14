import { AgentAcpClient, CodexRemoteClient, HarnessAlphaClient, RemoteClientCore, RemoteTypertGateway, probeRemoteHostFeatures, remoteWorkspaceTypeAvailable, type RemoteHostFeatures } from '@dsh-remote/client-core'
import { classifyControlClose } from '@dsh-remote/protocol'
import { AdaptiveTransport, type AdaptiveConnectionDetails, type RtcIceServer } from '@dsh-remote/webrtc'
import { websocketUrl } from '../lib/server-url'
import { connectionFailure, connectionLog } from './connection-log'
import { strings } from '../locales/i18n'
import type { DeviceIdentity, MuxStreamFrame, RemoteDevice } from '../types'
import { AcpSessionTools, HarnessSessionTools, type SessionTools } from './session-tools'
import { SecureTransport } from './secure-transport'
import { BotRemoteClient } from './bot-catalog'

export type MuxFrameHandler = (frame: MuxStreamFrame) => void
export type CloseHandler = (options?: { retryable: boolean; lastTransport?: 'lan' | 'p2p' | 'turn' | 'relay' }) => void
type RemoteHarnessClient = HarnessAlphaClient

export interface AndroidConnectionOptions {
  onOpencodeArchived?: (sessionId: string) => void
  preferredTransports?: Array<'lan' | 'p2p' | 'turn' | 'relay'>
  forceRelay?: boolean
  refreshAccessToken?: () => Promise<string>
  fetchIceServers?: (connectionId: string) => Promise<RtcIceServer[]>
  onSecureHandshake?: () => void
  onWebRtcFallback?: () => void
  onClose?: CloseHandler
}

export class AndroidRemoteConnection {
  private compactHistorySupported = false
  private pluginRouteSupported = false
  private speechSupported = false
  /** Host-side Windows app APIs (TTS/OCR) announced as `app-api.v1`. */
  private appApiSupported = false
  /** Host-side web search announced as `app-api.search.v1` (needs a PC key). */
  private appApiSearchSupported = false
  private core?: RemoteClientCore
  private proxy?: RemoteHarnessClient
  private codex?: CodexRemoteClient
  private cursor?: AgentAcpClient
  private acpBackends = new Set<string>()
  private codexAvailable = false
  private sessionTools?: HarnessSessionTools
  private closeMux?: (notifyRemote?: boolean) => Promise<void>
  private unsubscribeClose?: () => void
  private unsubscribeArchived?: () => void
  private muxHandler?: MuxFrameHandler
  private transport?: AdaptiveTransport
  private connectionAttempt = 0
  private healthTimer?: ReturnType<typeof setTimeout>
  private healthFlight?: { core: RemoteClientCore; result: Promise<boolean> }
  /** Consecutive failed health probes for the active core; reset per carrier and on success. */
  private healthCheckFailures = 0

  async configureHistory(compact: boolean): Promise<void> {
    if (this.core !== undefined && this.compactHistorySupported) {
      await this.core.rpc('remote.history.configure', { compact })
    }
  }

  async connect(
    baseUrl: string,
    identity: DeviceIdentity,
    host: RemoteDevice,
    accessToken: string,
    onFrame: MuxFrameHandler,
    options: AndroidConnectionOptions = {},
  ): Promise<void> {
    // Replacing a connection must not wait for a graceful stream-close RPC:
    // the old data path may be exactly what is being recovered from.
    const attempt = ++this.connectionAttempt
    connectionLog('connect', { attempt, phase: 'starting', forceRelay: options.forceRelay === true })
    await this.clearConnection()
    if (attempt !== this.connectionAttempt) throw new Error('The connection attempt was superseded.')
    this.muxHandler = onFrame
    let webRtcFallback = false
    let retryableClose = true
    let lastTransport: 'lan' | 'p2p' | 'turn' | 'relay' | undefined
    const createTransport = (relayOnly: boolean) => new AdaptiveTransport(websocketUrl(baseUrl), {
      role: 'client',
      deviceId: identity.deviceId,
      accessToken,
      refreshAccessToken: options.refreshAccessToken,
      targetDeviceId: host.deviceId,
      forceRelay: options.forceRelay || relayOnly,
      preferredTransports: options.forceRelay || relayOnly
        ? ['relay']
        : options.preferredTransports ?? ['lan', 'p2p', 'turn', 'relay'],
      // TURN-only attempts may need extra time for relay allocation and TCP
      // fallback. Keep automatic hole punching on its shorter mobile budget.
      negotiateTimeoutMs: !options.forceRelay && !relayOnly
        && options.preferredTransports?.includes('turn')
        && !options.preferredTransports.some(transport => transport === 'lan' || transport === 'p2p')
        ? 12_000
        : 6_000,
      iceServersTimeoutMs: 5_000,
      fetchIceServers: options.fetchIceServers,
      onDisconnect: event => {
        // Refused/replaced credentials, protocol errors and malformed frames
        // need manual recovery; do not automatically compete for ownership.
        const retryableControlClose = event.closeCode !== undefined
          && classifyControlClose(event.closeCode, event.closeReason).retryable
        retryableClose = event.reason !== 'invalid-control-frame'
          && !(event.closeCode !== undefined && !retryableControlClose && (event.closeCode >= 4000
            || [1002, 1003, 1007, 1008, 1009].includes(event.closeCode)))
        if (event.transport !== undefined) lastTransport = event.transport
        connectionLog('disconnect', { reason: event.reason, closeCode: event.closeCode, transport: event.transport })
      },
      onWebRtcFallback: (error, diagnostics) => {
        webRtcFallback = true
        options.onWebRtcFallback?.()
        // Do not include credentials, SDP, prompts, or tunnel payloads.
        connectionLog('fallback', { reason: connectionFailure(error),
          connectionState: diagnostics?.connectionState,
          iceConnectionState: diagnostics?.iceConnectionState,
          localCandidates: diagnostics?.localCandidates.byType,
          remoteCandidates: diagnostics?.remoteCandidates.byType,
        })
      },
      onWebRtcDiagnostic: event => {
        if (event.type !== 'selected-path') return
        // Selected-path telemetry contains candidate types and address scopes,
        // never the candidate IPs, SDP, credentials, or tunnel payloads.
        connectionLog('selected-path', { transport: event.selectedPath.mode, protocol: event.selectedPath.protocol, localCandidateType: event.selectedPath.localCandidateType, remoteCandidateType: event.selectedPath.remoteCandidateType, localCandidates: event.diagnostics.localCandidates.byType,
          remoteCandidates: event.diagnostics.remoteCandidates.byType })
      },
    })
    const connectCore = async (relayOnly: boolean) => {
      const transport = createTransport(relayOnly)
      this.transport = transport
      // Host-side Typert calls are capped at 30s. Leave a small delivery
      // margin, then treat silence as an unhealthy business channel.
      const core = new RemoteClientCore(
        new SecureTransport(transport, identity, host, options.onSecureHandshake),
        35_000,
      )
      this.core = core
      // A fresh carrier has no health history: a failure counted on the
      // previous connection must not retire this one after a single probe.
      this.healthCheckFailures = 0
      this.unsubscribeClose = core.onClose(() => {
        // A late close from a replaced connection must not tear down the new
        // connection that may already be stored on this instance.
        if (this.core !== core) return
        this.clearHealthTimer()
        void this.closeMux?.(false)
        this.closeMux = undefined
        this.core = undefined
        this.proxy = undefined
        this.codex = undefined
        this.codexAvailable = false
        this.cursor = undefined
        this.acpBackends.clear()
        this.sessionTools = undefined
        this.speechSupported = false
        this.appApiSupported = false
        this.appApiSearchSupported = false
        options.onClose?.({ retryable: retryableClose, ...(lastTransport !== undefined ? { lastTransport } : {}) })
      })
      await core.connect()
      if (attempt !== this.connectionAttempt || this.core !== core) throw new Error('The connection attempt was superseded.')
      return core
    }
    try {
      // A WebRTC fallback continues on the same connection id: the Host keeps
      // the tunnel alive and switches its data plane to Relay. Rebuilding a
      // second relay-only connection doubled every fallback into two full
      // handshakes and added 10s+ to mobile connections.
      const core = await connectCore(false)
      const features = await probeRemoteHostFeatures(core, host.clientVersion)
      if (attempt !== this.connectionAttempt || this.core !== core) throw new Error('The connection attempt was superseded.')
      const emitFrame = (frame: MuxStreamFrame) => {
        if (this.core !== core) return
        if (frame.payload.type === 'stream/closed' && frame.payload.reason === 'failed') {
          connectionLog('stream-failed')
          // A live carrier failure is an offline channel, even if its socket
          // still answers. Reconnect will create a fresh follow subscription.
          void this.close()
          options.onClose?.()
          return
        }
        this.muxHandler?.(frame)
      }
      this.compactHistorySupported = features.capabilities.includes('remote.history.compact.v1')
      this.applyBackendFeatures(core, features)
      this.unsubscribeArchived = this.cursor?.onSessionArchived(data => {
        if (this.core === core) options.onOpencodeArchived?.(data.sessionId)
      })
      if (features.remoteGateway) {
        this.sessionTools = new HarnessSessionTools(new RemoteTypertGateway(core))
        const alpha = new HarnessAlphaClient(
          core,
          {
            clientVersion: host.clientVersion,
            harnessVersion: host.harnessVersion,
            ...(features.sessionFormat === undefined ? {} : { sessionFormat: features.sessionFormat }),
          },
          frame => emitFrame(frame as unknown as MuxStreamFrame),
        )
        alpha.start()
        this.proxy = alpha
        this.closeMux = async (notifyRemote = true) => { await alpha.close(notifyRemote) }
      } else {
        throw new Error('The remote Host exposes no supported Harness transport.')
      }
      this.scheduleHealthCheck(core)
      connectionLog('connect', { attempt, phase: 'ready' })
    } catch (error) {
      connectionLog('connect', { attempt, phase: 'failed', reason: connectionFailure(error) })
      if (attempt === this.connectionAttempt) await this.clearConnection()
      throw error
    }
  }

  /** Reprobe readiness on workspace refresh so Host backend switches need no reconnect. */
  async refreshBackends(): Promise<void> {
    if (this.core === undefined) throw new Error(strings.runtime.connectHostFirst)
    const core = this.core
    const features = await probeRemoteHostFeatures(core)
    if (this.core !== core) return
    this.applyBackendFeatures(core, features)
  }

  private applyBackendFeatures(core: RemoteClientCore, features: RemoteHostFeatures): void {
    this.pluginRouteSupported = features.pluginRoute
    // Official experimental speech Remote namespace; the Host advertises it only
    // when its composition provides the speechController service.
    this.speechSupported = features.capabilities.includes('speech.remote.v1')
    this.appApiSupported = features.capabilities.includes('app-api.v1')
    this.appApiSearchSupported = features.capabilities.includes('app-api.search.v1')
    this.codexAvailable = features.capabilities.includes('codex.appserver.transfer.v1')
      && remoteWorkspaceTypeAvailable(features.capabilities, features.workspaceTypes, 'codex', 'codex.appserver.v1')
    if (this.codexAvailable) this.codex ??= new CodexRemoteClient(core, true)
    this.acpBackends.clear()
    for (const backend of ['cursor', 'antigravity', 'pi', 'opencode', 'claude', 'hermes'] as const) {
      if (remoteWorkspaceTypeAvailable(features.capabilities, features.workspaceTypes, backend, `agent.acp.${backend}.v1`)) {
        this.acpBackends.add(backend)
      }
    }
    if (this.acpBackends.size > 0) this.cursor ??= new AgentAcpClient(core, features.capabilities)
  }

  /** Harness business client; only available while connected. */
  requireProxy(): RemoteHarnessClient {
    if (this.proxy === undefined) throw new Error(strings.runtime.connectHostFirst)
    return this.proxy
  }

  /**
   * Read an existing session attachment through its native carrier; never accept
   * a filesystem path. 0.2.2 Hosts require the full image reference (id, media
   * type, byte length and dimensions are verified), while older Hosts only know
   * the durable id. Always carry that id: a 0.2.2 Host can recover the verified
   * reference from session events even when only partial fields are available.
   */
  async readSessionImageAttachment(
    sessionId: string,
    attachment: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const core = this.core
    const proxy = this.requireProxy()
    if (core === undefined) throw new Error(strings.runtime.connectHostFirst)
    const attachmentId = typeof attachment.attachmentId === 'string' ? attachment.attachmentId : undefined
    if (attachmentId === undefined) throw new Error(strings.common.unavailable)
    const fullReference = typeof attachment.mediaType === 'string' && typeof attachment.bytes === 'number'
      && typeof attachment.width === 'number' && typeof attachment.height === 'number'
    const request: Record<string, unknown> = { sessionId, attachmentId }
    if (fullReference) request.attachment = attachment
    const value = await new RemoteTypertGateway(core).call<unknown>('session/attachment', {
      args: { request },
    }, signal, { maxResponseBytes: 12 * 1024 * 1024 })
    if (this.core !== core || this.proxy !== proxy || signal.aborted) throw new Error(strings.runtime.connectHostFirst)
    // Typert versions may preserve the official business Result inside the carrier result.
    if (typeof value === 'object' && value !== null && 'ok' in value) {
      if (value.ok === true && 'value' in value) return value.value
      throw new Error(strings.common.unavailable)
    }
    return value
  }

  requireBotClient(): BotRemoteClient {
    const core = this.core
    const proxy = this.proxy
    if (core === undefined || proxy === undefined) throw new Error(strings.runtime.connectHostFirst)
    if (!this.pluginRouteSupported) throw new Error(strings.bots.unsupported)
    const current = () => {
      if (this.core !== core || this.proxy !== proxy) throw new Error(strings.runtime.connectHostFirst)
      if (!this.pluginRouteSupported) throw new Error(strings.bots.unsupported)
    }
    return new BotRemoteClient(
      (body, signal) => { current(); return core.rpc('plugin.route.call', { route: 'api/bot', body }, signal) },
      () => { current(); return proxy.sessionList() },
      current,
    )
  }

  async rpc<T = unknown>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    if (this.core === undefined) throw new Error(strings.runtime.connectHostFirst)
    return this.core.rpc<T>(method, params, signal)
  }

  /** The connected Host advertises the official experimental speech namespace. */
  supportsVoiceInput(): boolean {
    return this.core !== undefined && this.speechSupported
  }

  /**
   * Transcribe one canonical base64 WAV through the Host's official speech
   * Remote namespace. Large recordings automatically use the gateway transfer
   * path, so the phone never needs an API key and audio stays on the computer.
   */
  async transcribeVoice(audioBase64: string, language: string | undefined, signal?: AbortSignal): Promise<string> {
    if (this.core === undefined) throw new Error(strings.runtime.connectHostFirst)
    if (!this.speechSupported) throw new Error(strings.chat.voiceUnavailable)
    const args: Record<string, unknown> = { audioBase64 }
    if (language !== undefined && language !== '') args.language = language
    const value = await new RemoteTypertGateway(this.core).call<unknown>(
      'speech/transcribe',
      // Typert maps `args` entries to the method parameters by name; the
      // controller signature is `transcribe(request, signal)`.
      { args: { request: args } },
      signal,
      { maxResponseBytes: 4 * 1024 * 1024 },
    )
    const text = typeof value === 'object' && value !== null && 'text' in value
      ? (value as { text?: unknown }).text
      : undefined
    if (typeof text !== 'string' || text.trim() === '') throw new Error(strings.chat.voiceEmpty)
    return text.trim()
  }

  /** The connected Host announces the Windows-local TTS/OCR app APIs. */
  supportsAppApis(): boolean {
    return this.core !== undefined && this.appApiSupported
  }

  /**
   * Synthesize one assistant message on the computer (Windows SAPI) and return
   * a WAV for local playback. The phone never needs a cloud key for this.
   */
  async synthesizeSpeech(
    text: string,
    options: { voice?: string; rate?: number } = {},
    signal?: AbortSignal,
  ): Promise<{ audioBase64: string; durationMs: number; bytes: number }> {
    if (this.core === undefined) throw new Error(strings.runtime.connectHostFirst)
    if (!this.appApiSupported) throw new Error(strings.messageActions.unavailable)
    const params: Record<string, unknown> = { text }
    if (options.voice !== undefined && options.voice !== '') params.voice = options.voice
    if (options.rate !== undefined) params.rate = options.rate
    const value = await this.core.rpc<unknown>('appApi.tts', params, signal)
    const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
    const audioBase64 = record.audioBase64
    if (typeof audioBase64 !== 'string' || audioBase64 === '') throw new Error(strings.messageActions.unavailable)
    return {
      audioBase64,
      durationMs: typeof record.durationMs === 'number' ? record.durationMs : 0,
      bytes: typeof record.bytes === 'number' ? record.bytes : 0,
    }
  }

  /** Recognize text on the computer (Windows.Media.Ocr) and return the lines. */
  async recognizeImage(
    imageBase64: string,
    language?: string,
    signal?: AbortSignal,
  ): Promise<{ text: string; lines: string[] }> {
    if (this.core === undefined) throw new Error(strings.runtime.connectHostFirst)
    if (!this.appApiSupported) throw new Error(strings.messageActions.unavailable)
    const params: Record<string, unknown> = { imageBase64 }
    if (language !== undefined && language !== '') params.language = language
    const value = await this.core.rpc<unknown>('appApi.ocr', params, signal)
    const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
    return {
      text: typeof record.text === 'string' ? record.text : '',
      lines: Array.isArray(record.lines) ? record.lines.filter((line): line is string => typeof line === 'string') : [],
    }
  }

  /**
   * Fetch a public page on the computer and return its readable text. The Host
   * blocks private/loopback destinations and caps the body size.
   */
  async fetchLink(url: string, signal?: AbortSignal): Promise<{ url: string; title: string; text: string; bytes: number }> {
    if (this.core === undefined) throw new Error(strings.runtime.connectHostFirst)
    if (!this.appApiSupported) throw new Error(strings.messageActions.unavailable)
    const value = await this.core.rpc<unknown>('appApi.fetch', { url }, signal)
    const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
    const text = typeof record.text === 'string' ? record.text : ''
    if (text === '') throw new Error(strings.messageActions.unavailable)
    return {
      url: typeof record.url === 'string' ? record.url : url,
      title: typeof record.title === 'string' ? record.title : '',
      text,
      bytes: typeof record.bytes === 'number' ? record.bytes : 0,
    }
  }

  /** Host-side web search; the provider key never leaves the computer. */
  supportsWebSearch(): boolean {
    return this.core !== undefined && this.appApiSearchSupported
  }

  async searchWeb(
    query: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<Array<{ title: string; url: string; snippet: string }>> {
    if (this.core === undefined) throw new Error(strings.runtime.connectHostFirst)
    if (!this.appApiSearchSupported) throw new Error(strings.messageActions.unavailable)
    const params: Record<string, unknown> = { query }
    if (limit !== undefined) params.limit = limit
    const value = await this.core.rpc<unknown>('appApi.search', params, signal)
    const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
    const rows = Array.isArray(record.results) ? record.results : []
    return rows
      .filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
      .map(row => ({
        title: typeof row.title === 'string' ? row.title : '',
        url: typeof row.url === 'string' ? row.url : '',
        snippet: typeof row.snippet === 'string' ? row.snippet : '',
      }))
      .filter(row => row.url !== '')
  }

  /** Optional CodeX business client; available only when the Host advertises both domain capabilities. */
  requireCodex(): CodexRemoteClient {
    if (this.codex === undefined || !this.codexAvailable) throw new Error(strings.runtime.codexUnavailable)
    return this.codex
  }

  requireSessionTools(sessionId?: string): SessionTools {
    if (sessionId?.startsWith('cursor:') && this.cursor !== undefined) return new AcpSessionTools(this.cursor, 'cursor')
    if (sessionId?.startsWith('pi:')) return new AcpSessionTools(this.requirePi(), 'pi')
    if (sessionId?.startsWith('antigravity:') && this.cursor !== undefined) return new AcpSessionTools(this.cursor, 'antigravity')
    if (sessionId?.startsWith('claude:')) return new AcpSessionTools(this.requireClaude(), 'claude')
    if (sessionId?.startsWith('hermes:')) return new AcpSessionTools(this.requireHermes(), 'hermes')
    if (sessionId?.startsWith('opencode:') && this.cursor !== undefined) return new AcpSessionTools(this.cursor, 'opencode')
    if (this.sessionTools === undefined) throw Object.assign(new Error('Native session tools require a compatible Host.'), { code: 'FEATURE_NOT_SUPPORTED' })
    return this.sessionTools
  }

  hasCodex(): boolean {
    return this.codex !== undefined && this.codexAvailable
  }

  /** Optional Agent ACP client (Cursor UI backend); available when the Host advertises agent.acp.cursor.v1. */
  requireCursor(): AgentAcpClient {
    if (this.cursor === undefined || !this.acpBackends.has('cursor')) throw new Error(strings.runtime.cursorUnavailable)
    return this.cursor
  }

  hasCursor(): boolean {
    return this.cursor !== undefined && this.acpBackends.has('cursor')
  }

  /** Optional Agent ACP client (Antigravity UI backend); available when the Host advertises agent.acp.antigravity.v1. */
  requireAntigravity(): AgentAcpClient {
    if (this.cursor === undefined || !this.acpBackends.has('antigravity')) throw new Error(strings.runtime.antigravityUnavailable)
    return this.cursor
  }

  hasAntigravity(): boolean {
    return this.cursor !== undefined && this.acpBackends.has('antigravity')
  }

  requirePi(): AgentAcpClient {
    if (this.cursor === undefined || !this.acpBackends.has('pi')) throw new Error(strings.runtime.piUnavailable)
    return this.cursor
  }

  hasPi(): boolean {
    return this.cursor !== undefined && this.acpBackends.has('pi')
  }

  /** Optional Agent ACP client (OpenCode UI backend); available when the Host advertises agent.acp.opencode.v1. */
  requireOpencode(): AgentAcpClient {
    if (this.cursor === undefined || !this.acpBackends.has('opencode')) throw new Error(strings.runtime.opencodeUnavailable)
    return this.cursor
  }

  hasOpencode(): boolean {
    return this.cursor !== undefined && this.acpBackends.has('opencode')
  }

  requireClaude(): AgentAcpClient {
    if (this.cursor === undefined || !this.acpBackends.has('claude')) throw new Error(strings.runtime.claudeUnavailable)
    return this.cursor
  }

  hasClaude(): boolean {
    return this.cursor !== undefined && this.acpBackends.has('claude')
  }

  /** Optional Agent ACP client (Hermes Agent UI backend); available when the Host advertises agent.acp.hermes.v1. */
  requireHermes(): AgentAcpClient {
    if (this.cursor === undefined || !this.acpBackends.has('hermes')) throw new Error(strings.runtime.hermesUnavailable)
    return this.cursor
  }

  hasHermes(): boolean {
    return this.cursor !== undefined && this.acpBackends.has('hermes')
  }

  getStats() {
    return this.core?.getStats()
  }

  /** A locally open socket can be half-open after Android suspends networking. */
  checkHealth(): Promise<boolean> {
    const core = this.core
    if (core === undefined || !core.getStats().connected) return Promise.resolve(false)
    if (this.healthFlight?.core === core) return this.healthFlight.result
    const result = this.probeHealth(core)
    this.healthFlight = { core, result }
    void result.finally(() => {
      if (this.healthFlight?.result === result) this.healthFlight = undefined
    })
    return result
  }

  private async probeHealth(core: RemoteClientCore): Promise<boolean> {
    try {
      // Existing authenticated, encrypted capability RPC; no new wire heartbeat.
      await core.rpc('harness.transport.describe', {}, undefined, { timeoutMs: 5_000 })
      return this.core === core
    } catch {
      return false
    }
  }

  private scheduleHealthCheck(core: RemoteClientCore, delayMs = 25_000): void {
    this.clearHealthTimer()
    this.healthTimer = setTimeout(() => {
      this.healthTimer = undefined
      if (this.core !== core) return
      void this.checkHealth().then(healthy => {
        if (this.core !== core) return
        if (healthy) {
          this.healthCheckFailures = 0
          this.scheduleHealthCheck(core)
          return
        }
        // A single slow probe (congested relay, brief radio gap) must not kill
        // a carrier that still delivers: every forced close sends the user
        // through a full reconnect + session history catch-up before live
        // streaming resumes. Confirm with one fast retry first.
        this.healthCheckFailures += 1
        if (this.healthCheckFailures >= 2) {
          connectionLog('health-failed', { phase: 'closed' })
          // close() on the core publishes the same offline/recovery transition
          // as a socket close, including when the OS never delivered onclose.
          void core.close().catch(() => undefined)
        } else {
          connectionLog('health-failed', { phase: 'checking' })
          this.scheduleHealthCheck(core, 5_000)
        }
      })
    }, delayMs)
  }

  private clearHealthTimer(): void {
    if (this.healthTimer !== undefined) clearTimeout(this.healthTimer)
    this.healthTimer = undefined
  }

  async getNetworkDetails(): Promise<AdaptiveConnectionDetails | undefined> {
    return await this.transport?.connectionDetails()
  }

  async close(): Promise<void> {
    ++this.connectionAttempt
    await this.clearConnection()
  }

  private async clearConnection(): Promise<void> {
    this.clearHealthTimer()
    this.muxHandler = undefined
    const mux = this.closeMux
    this.closeMux = undefined
    const core = this.core
    this.core = undefined
    // Closing the whole transport makes a remote stream-close redundant.
    // Only remove the local subscription here so a half-open RTC path cannot
    // add another RPC timeout before recovery begins.
    this.unsubscribeClose?.()
    this.unsubscribeClose = undefined
    this.unsubscribeArchived?.()
    this.unsubscribeArchived = undefined
    this.transport = undefined
    this.proxy = undefined
    this.codex = undefined
    this.codexAvailable = false
    this.cursor = undefined
    this.acpBackends.clear()
    this.sessionTools = undefined
    if (mux !== undefined) await mux(false).catch(() => undefined)
    if (core !== undefined) await core.close()
  }
}
