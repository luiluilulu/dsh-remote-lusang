/**
 * In-app update channel for the self-hosted fork.
 *
 * The stock client checks `liguobao/ds-harness-remote` releases, which never
 * contains our `0.6.4-own.N` trial APKs and whose plain `0.6.4` tag must not
 * count as "newer" than a suffixed build. This module owns the fork's own
 * release channel so the settings/startup update check can offer the real
 * next build and hand the downloaded APK to the system installer.
 *
 * GitHub API/download hosts are intermittently blocked on Chinese mobile
 * networks, so every request has a public mirror fallback chain.
 */

/** GitHub repository that publishes this fork's `0.6.4-own.N` releases. */
export const UPDATE_REPO = process.env.EXPO_PUBLIC_DSH_REMOTE_UPDATE_REPO ?? 'luiluilulu/dsh-remote-lusang'

/** Release page shown when no APK asset can be resolved. */
export function updatePageUrl(repo: string = UPDATE_REPO): string {
  return `https://github.com/${repo}/releases/latest`
}

/** GitHub release-metadata endpoints, primary first. */
export function releaseApiUrls(repo: string = UPDATE_REPO): string[] {
  const official = `https://api.github.com/repos/${repo}/releases/latest`
  return [official, `https://gh-proxy.com/${official}`]
}

/** Download endpoints for one asset URL, mirrors first. */
export function downloadUrls(url: string): string[] {
  // GitHub's asset host is frequently unreachable on Chinese mobile networks
  // while release *metadata* over api.github.com still works. A large APK would
  // otherwise hang on the dead direct attempt, so try the public mirrors first
  // and keep the canonical GitHub URL as the last resort.
  return [`https://gh-proxy.com/${url}`, `https://ghfast.top/${url}`, url]
}

export type LatestRelease = {
  /** Release tag without the leading `v` (`0.6.4-own.10`). */
  version: string
  /** APK asset URL when the release ships one. */
  downloadUrl?: string
}

type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

/**
 * Fetch the newest release for the fork. Each endpoint is tried with its own
 * timeout; the first parseable answer wins and undefined means "unknown"
 * (offline host, blocked network, no release yet) rather than "up to date".
 */
export async function fetchLatestRelease(
  fetchImpl: FetchLike = fetch,
  timeoutMs = 8_000,
  repo: string = UPDATE_REPO,
): Promise<LatestRelease | undefined> {
  for (const url of releaseApiUrls(repo)) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, { signal: controller.signal })
      if (!response.ok) continue
      const data = await response.json() as {
        tag_name?: unknown
        assets?: Array<{ name?: unknown; browser_download_url?: unknown }>
      }
      const version = String(data.tag_name ?? '').replace(/^v/i, '').trim()
      if (version === '') continue
      const apk = Array.isArray(data.assets)
        ? data.assets.find(asset => typeof asset.name === 'string' && asset.name.toLowerCase().endsWith('.apk'))
        : undefined
      return {
        version,
        ...(typeof apk?.browser_download_url === 'string' ? { downloadUrl: apk.browser_download_url } : {}),
      }
    } catch {
      // Try the next mirror; a blocked GitHub is the common case on mobile data.
    } finally {
      clearTimeout(timer)
    }
  }
  return undefined
}

type ParsedVersion = { base: number[]; own: number }

/**
 * Parse `0.6.4`, `v0.6.4`, `0.6.4-own.9`, `0.6.4-own.9+build`. A missing
 * `-own.N` suffix counts as own build 0 so upstream's plain `0.6.4` is never
 * newer than our suffixed builds, while `own.10 > own.9` still works.
 */
function parseVersion(value: string): ParsedVersion | null {
  const match = /^\s*v?(\d+(?:\.\d+)*)(?:-own\.(\d+))?/i.exec(value)
  const raw = match?.[1]
  if (raw === undefined) return null
  const base = raw.split('.').map(Number)
  if (base.length === 0 || !base.every(part => Number.isFinite(part))) return null
  const own = match?.[2] === undefined ? 0 : Number(match[2])
  if (!Number.isFinite(own)) return null
  return { base, own }
}

/**
 * True only when `latest` is a strictly newer release for this fork: compare
 * the numeric core first, then the `-own.N` counter when the core is equal.
 * An unparseable installed version is treated as "unknown, offer the update".
 */
export function isNewerVersion(latest: string, current: string): boolean {
  const next = parseVersion(latest)
  if (next === null) return false
  const installed = parseVersion(current)
  if (installed === null) return true
  const length = Math.max(next.base.length, installed.base.length)
  for (let index = 0; index < length; index++) {
    const a = next.base[index] ?? 0
    const b = installed.base[index] ?? 0
    if (a > b) return true
    if (a < b) return false
  }
  return next.own > installed.own
}
