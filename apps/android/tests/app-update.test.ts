import { describe, expect, it } from 'vitest'
import {
  downloadUrls,
  fetchLatestRelease,
  isNewerVersion,
  releaseApiUrls,
  updatePageUrl,
  type LatestRelease,
} from '../src/services/app-update'

type FetchLike = Parameters<typeof fetchLatestRelease>[0]

const okResponse = (payload: unknown) => ({
  ok: true,
  status: 200,
  json: async () => payload,
})

describe('fork update channel', () => {
  it('offers only strictly newer fork builds', () => {
    const cases: Array<[latest: string, current: string, expected: boolean]> = [
      ['0.6.4-own.10', '0.6.4-own.9', true],
      ['v0.6.4-own.9', '0.6.4-own.9', false],
      // Upstream's plain 0.6.4 release must never look newer than our suffixed build.
      ['0.6.4', '0.6.4-own.9', false],
      ['0.6.5-own.0', '0.6.4-own.9', true],
      ['0.6.5', '0.6.4-own.9', true],
      ['0.6.4-own.9', '0.6.3', true],
      ['0.6.4', '0.6.4', false],
      ['0.6.4-own.2', '0.6.4-own.10', false],
      // Patch builds (`-own.N.M`) order inside the same own counter.
      ['0.6.4-own.13.1', '0.6.4-own.13', true],
      ['0.6.4-own.13.1', '0.6.4-own.13.0', true],
      ['0.6.4-own.13.2', '0.6.4-own.13.1', true],
      ['0.6.4-own.13.1', '0.6.4-own.14', false],
      ['0.6.4-own.14', '0.6.4-own.13.1', true],
      ['v0.6.4-own.13.1', '0.6.4-own.13.1', false],
      ['not-a-version', '0.6.4-own.9', false],
      // An unparseable installed version should still offer the update.
      ['0.6.4-own.9', '', true],
    ]
    for (const [latest, current, expected] of cases) {
      expect(isNewerVersion(latest, current), `${latest} vs ${current}`).toBe(expected)
    }
  })

  it('keeps GitHub primary and mirrors as fallbacks for metadata and downloads', () => {
    expect(updatePageUrl('owner/repo')).toBe('https://github.com/owner/repo/releases/latest')
    const api = releaseApiUrls('owner/repo')
    expect(api[0]).toBe('https://api.github.com/repos/owner/repo/releases/latest')
    expect(api[1]).toContain('gh-proxy.com/')
    const downloads = downloadUrls('https://github.com/owner/repo/releases/download/v1/app.apk')
    // Mirrors go first: GitHub's asset host is the unreliable hop on mobile data.
    expect(downloads[0]).toContain('gh-proxy.com/')
    expect(downloads[1]).toContain('ghfast.top/')
    expect(downloads[2]).toBe('https://github.com/owner/repo/releases/download/v1/app.apk')
  })

  it('resolves the release and its apk asset across blocked mirrors', async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: string) => {
      calls.push(url)
      if (calls.length === 1) throw new Error('github blocked')
      return okResponse({
        tag_name: 'v0.6.4-own.10',
        assets: [
          { name: 'notes.txt', browser_download_url: 'https://example.com/notes.txt' },
          { name: 'dsh-remote-own-0.6.4-own10-arm64.apk', browser_download_url: 'https://github.com/owner/repo/releases/download/v0.6.4-own.10/app.apk' },
        ],
      })
    }) as unknown as FetchLike
    const release = await fetchLatestRelease(fetchImpl, 50, 'owner/repo')
    expect(release).toEqual<LatestRelease>({
      version: '0.6.4-own.10',
      downloadUrl: 'https://github.com/owner/repo/releases/download/v0.6.4-own.10/app.apk',
    })
    expect(calls).toHaveLength(2)
    expect(calls[1]).toContain('gh-proxy.com/')
  })

  it('reports unknown instead of up to date when every endpoint fails or ships no asset', async () => {
    const offline = (async () => { throw new Error('offline') }) as unknown as FetchLike
    expect(await fetchLatestRelease(offline, 50, 'owner/repo')).toBeUndefined()
    const noAsset = (async () => okResponse({ tag_name: 'v0.6.4-own.10', assets: [] })) as unknown as FetchLike
    expect(await fetchLatestRelease(noAsset, 50, 'owner/repo')).toEqual({ version: '0.6.4-own.10' })
  })
})
