import { execFile } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { SafeLogger } from '../logging.js'
import { RpcError } from '../safe-error.js'

const run = promisify(execFile)

/**
 * Host-side "app API" domain: Windows-local speech synthesis and OCR for the
 * mobile client. Every capability runs on the computer; the phone only sends a
 * request and receives text or a WAV. No API key leaves, or is needed by, the
 * device, and nothing is written outside an ephemeral temp directory.
 */
const ttsParamsSchema = z.object({
  text: z.string().min(1).max(2_000),
  voice: z.string().max(80).optional(),
  rate: z.number().int().min(-10).max(10).optional(),
}).strict()

const ocrParamsSchema = z.object({
  imageBase64: z.string().min(1),
  language: z.string().max(20).optional(),
}).strict()

const fetchParamsSchema = z.object({
  url: z.string().min(1).max(2_048),
}).strict()

const MAX_TTS_BYTES = 4 * 1024 * 1024
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_BASE64_BYTES = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4
const MAX_FETCH_BYTES = 1024 * 1024
const MAX_FETCH_TEXT = 20_000
const MAX_REDIRECTS = 3
const FETCH_TIMEOUT_MS = 10_000
const SCRIPT_TIMEOUT_MS = 30_000

const TTS_SCRIPT = String.raw`param([string]$InPath, [string]$OutPath, [string]$Voice, [int]$Rate)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$text = [System.IO.File]::ReadAllText($InPath, [System.Text.Encoding]::UTF8)
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
if ($Voice -ne '') { try { $synth.SelectVoice($Voice) } catch { } }
$synth.Rate = $Rate
$synth.SetOutputToWaveFile($OutPath)
$synth.Speak($text)
$synth.Dispose()
Write-Output 'TTS_OK'
`

const VOICES_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$rows = @()
foreach ($voice in $synth.GetInstalledVoices()) {
  if ($voice.Enabled) { $rows += @{ name = $voice.VoiceInfo.Name; culture = $voice.VoiceInfo.Culture.Name } }
}
$synth.Dispose()
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
ConvertTo-Json -Compress -InputObject @($rows)
`

const OCR_SCRIPT = [
  'param([string]$Path, [string]$Language)',
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
  '$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]',
  '$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]',
  '$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]',
  "$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1",
  'function Await($op, $type) { $asTask.MakeGenericMethod($type).Invoke($null, @($op)).GetAwaiter().GetResult() }',
  '$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])',
  '$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])',
  '$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])',
  '$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])',
  'if ($Language -ne \'\') {',
  '  $tag = New-Object Windows.Globalization.Language($Language)',
  '  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($tag)',
  '} else {',
  '  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()',
  '}',
  'if ($engine -eq $null) { Write-Output \'{"error":"no-engine"}\'; exit 0 }',
  '$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])',
  '$lines = @()',
  'foreach ($line in $result.Lines) { $lines += $line.Text }',
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'ConvertTo-Json -Compress -InputObject @{ text = $result.Text; lines = $lines }',
].join('\n')

function powerShellPath(): string {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function isBlockedIPv4(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const [a, b] = parts
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return a === 192 && b === 168
}

function isBlockedIPv6(address: string): boolean {
  const value = address.toLowerCase()
  if (value === '::' || value === '::1') return true
  if (/^fe[89ab]/.test(value)) return true
  if (/^f[cd]/.test(value)) return true
  if (value.startsWith('::ffff:')) return isBlockedIPv4(value.slice(7))
  return false
}

/** Reject loopback, private, link-local and reserved destinations (SSRF). */
function isBlockedAddress(address: string): boolean {
  const kind = isIP(address)
  if (kind === 4) return isBlockedIPv4(address)
  if (kind === 6) return isBlockedIPv6(address)
  return true
}

/**
 * Only public http(s) URLs are fetched. Each redirect hop is re-validated so a
 * public host cannot bounce the Host into its own network.
 */
async function publicHttpUrl(raw: string): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new RpcError('INVALID_MESSAGE', 'The link is not a valid URL.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RpcError('APP_API_BLOCKED', 'Only http and https links can be summarized.')
  }
  if (url.username !== '' || url.password !== '') {
    throw new RpcError('APP_API_BLOCKED', 'Links with embedded credentials are not fetched.')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const literal = isIP(host)
  const addresses = literal !== 0
    ? [host]
    : await lookup(host, { all: true, verbatim: true }).then(rows => rows.map(row => row.address)).catch(() => [] as string[])
  if (addresses.length === 0) throw new RpcError('APP_API_FAILED', 'The link host could not be resolved.')
  for (const address of addresses) {
    if (isBlockedAddress(address)) throw new RpcError('APP_API_BLOCKED', 'The link points inside a private network.')
  }
  return url
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
}

function extractTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  return match === null ? '' : decodeEntities(match[1]).replace(/\s+/g, ' ').trim().slice(0, 200)
}

/** Cheap readable-text extraction; no scripts, styles, tags or entity noise. */
function htmlToText(html: string): string {
  const withoutBlocks = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
  const text = decodeEntities(withoutBlocks.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
  return text.slice(0, MAX_FETCH_TEXT)
}

function imageKind(bytes: Buffer): 'png' | 'jpg' | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg'
  return undefined
}

function wavDurationMs(bytes: Buffer): number {
  if (bytes.length < 44) return 0
  const byteRate = bytes.readUInt32LE(28)
  if (!Number.isFinite(byteRate) || byteRate <= 0) return 0
  return Math.round(((bytes.length - 44) / byteRate) * 1000)
}

export class AppApiHost {
  constructor(private readonly logger?: SafeLogger) {}

  /** Both capabilities depend on Windows PowerShell; other Hosts report unavailable. */
  available(): boolean {
    return process.platform === 'win32'
  }

  async voices(): Promise<{ voices: Array<{ name: string; culture: string }> }> {
    this.requirePlatform()
    const dir = await this.workspace()
    try {
      const script = join(dir, 'voices.ps1')
      await writeFile(script, VOICES_SCRIPT, 'utf8')
      const stdout = await this.exec(['-File', script])
      const parsed: unknown = stdout.trim() === '' ? [] : JSON.parse(stdout)
      const rows = Array.isArray(parsed) ? parsed : [parsed]
      const voices = rows
        .filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
        .map(row => ({ name: String(row.name ?? ''), culture: String(row.culture ?? '') }))
        .filter(row => row.name !== '')
      return { voices }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  async tts(params: unknown): Promise<{ audioBase64: string; format: 'wav'; durationMs: number; bytes: number }> {
    const { text, voice, rate } = ttsParamsSchema.parse(params)
    if (voice !== undefined && !/^[A-Za-z0-9 ._()\-]{1,80}$/.test(voice)) {
      throw new RpcError('INVALID_MESSAGE', 'The requested voice name is not supported.')
    }
    this.requirePlatform()
    const dir = await this.workspace()
    try {
      const input = join(dir, 'input.txt')
      const output = join(dir, 'output.wav')
      const script = join(dir, 'tts.ps1')
      await writeFile(input, text, 'utf8')
      await writeFile(script, TTS_SCRIPT, 'utf8')
      await this.exec(['-File', script, input, output, voice ?? '', String(rate ?? 0)])
      const wav = await readFile(output).catch(() => undefined)
      if (wav === undefined) throw new RpcError('APP_API_FAILED', 'Speech synthesis produced no audio.')
      if (wav.length > MAX_TTS_BYTES) throw new RpcError('APP_API_TOO_LARGE', 'The synthesized audio exceeds the 4 MiB limit.')
      return {
        audioBase64: wav.toString('base64'),
        format: 'wav',
        durationMs: wavDurationMs(wav),
        bytes: wav.length,
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  async ocr(params: unknown): Promise<{ text: string; lines: string[] }> {
    const { imageBase64, language } = ocrParamsSchema.parse(params)
    if (imageBase64.length > MAX_BASE64_BYTES) throw new RpcError('APP_API_TOO_LARGE', 'The image exceeds the 8 MiB limit.')
    const bytes = Buffer.from(imageBase64, 'base64')
    const kind = imageKind(bytes)
    if (kind === undefined) throw new RpcError('INVALID_MESSAGE', 'Only PNG and JPEG images can be recognized.')
    if (bytes.length > MAX_IMAGE_BYTES) throw new RpcError('APP_API_TOO_LARGE', 'The image exceeds the 8 MiB limit.')
    this.requirePlatform()
    const dir = await this.workspace()
    try {
      const image = join(dir, `input.${kind}`)
      const script = join(dir, 'ocr.ps1')
      await writeFile(image, bytes)
      await writeFile(script, OCR_SCRIPT, 'utf8')
      const stdout = await this.exec(['-File', script, image, language ?? ''])
      const parsed = JSON.parse(stdout.trim()) as { text?: unknown; lines?: unknown; error?: unknown }
      if (parsed.error === 'no-engine') throw new RpcError('APP_API_UNAVAILABLE', 'Windows OCR has no recognizer for this language.')
      const text = typeof parsed.text === 'string' ? parsed.text : ''
      const lines = Array.isArray(parsed.lines)
        ? parsed.lines.filter((line): line is string => typeof line === 'string')
        : []
      return { text, lines }
    } catch (error) {
      if (error instanceof RpcError) throw error
      this.logger?.warn('app api ocr failed', { reason: error instanceof Error ? error.name : 'unknown' })
      throw new RpcError('APP_API_FAILED', 'Text recognition failed on this computer.')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  /**
   * Fetch one public web page and return its readable text, so the phone can
   * prepare a "summarize this link" request. Every redirect hop is re-validated
   * against the private-network block list and the body size is capped.
   */
  async fetchLink(params: unknown): Promise<{ url: string; title: string; text: string; bytes: number }> {
    const { url } = fetchParamsSchema.parse(params)
    let target = await publicHttpUrl(url)
    let response: Response | undefined
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      response = await fetch(target, {
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'user-agent': 'ds-harness-remote-appapi/1.0', accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' },
      }).catch(() => {
        throw new RpcError('APP_API_FAILED', 'The link could not be fetched.')
      })
      if (response.status < 300 || response.status >= 400) break
      const location = response.headers.get('location')
      if (location === null) break
      if (hop === MAX_REDIRECTS) throw new RpcError('APP_API_FAILED', 'The link redirected too many times.')
      target = await publicHttpUrl(new URL(location, target).toString())
    }
    if (response === undefined) throw new RpcError('APP_API_FAILED', 'The link could not be fetched.')
    if (!response.ok) throw new RpcError('APP_API_FAILED', `The link returned HTTP ${response.status}.`)
    const contentType = response.headers.get('content-type') ?? ''
    if (!/text\/html|application\/xhtml|text\/plain/i.test(contentType)) {
      throw new RpcError('APP_API_FAILED', 'Only HTML and plain-text links can be summarized.')
    }
    const bytes = await this.readBody(response)
    const body = new TextDecoder('utf-8').decode(bytes)
    const title = extractTitle(body)
    const text = htmlToText(body)
    if (text === '') throw new RpcError('APP_API_FAILED', 'The page has no readable text.')
    return { url: target.toString(), title, text, bytes: bytes.byteLength }
  }

  private async readBody(response: Response): Promise<Uint8Array> {
    const body = response.body
    if (body === null) return new Uint8Array(await response.arrayBuffer())
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_FETCH_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new RpcError('APP_API_TOO_LARGE', 'The page exceeds the 1 MiB fetch limit.')
      }
      chunks.push(value)
    }
    const merged = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    return merged
  }

  private requirePlatform(): void {
    if (!this.available()) throw new RpcError('APP_API_UNAVAILABLE', 'This capability needs a Windows Host.')
  }  private workspace(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'dsh-appapi-'))
  }

  private async exec(args: string[]): Promise<string> {
    try {
      const { stdout } = await run(powerShellPath(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], {
        timeout: SCRIPT_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
      })
      return stdout
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown failure'
      // Only the classified failure reason is logged; script args may carry user text.
      this.logger?.warn('app api script failed', { reason: message.slice(0, 120) })
      throw new RpcError('APP_API_FAILED', 'The Host capability failed to run.')
    }
  }
}
