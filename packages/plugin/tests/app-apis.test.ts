import { describe, expect, it } from 'vitest'
import { AppApiHost } from '../src/app-apis/index.js'
import { RpcError } from '../src/safe-error.js'

// The Windows-local TTS/OCR endpoints validate their wire input before touching
// the platform, so these boundaries behave identically on every test runner.
describe('app api wire validation', () => {
  const host = new AppApiHost()

  it('rejects malformed TTS input before running a script', async () => {
    await expect(host.tts({ text: '' })).rejects.toMatchObject({ name: 'ZodError' })
    await expect(host.tts({ text: 'hello', rate: 99 })).rejects.toMatchObject({ name: 'ZodError' })
    await expect(host.tts({ text: 'hello', extra: true })).rejects.toMatchObject({ name: 'ZodError' })
    await expect(host.tts({ text: 'hello', voice: 'bad"name' })).rejects.toMatchObject({
      code: 'INVALID_MESSAGE',
    })
  })

  it('rejects non-image, oversized images and malformed OCR input', async () => {
    await expect(host.ocr({ imageBase64: Buffer.from('not an image').toString('base64') })).rejects.toMatchObject({
      code: 'INVALID_MESSAGE',
    })
    await expect(host.ocr({})).rejects.toMatchObject({ name: 'ZodError' })
    const oversized = Buffer.alloc(8 * 1024 * 1024 + 3, 0x89).toString('base64')
    await expect(host.ocr({ imageBase64: oversized })).rejects.toMatchObject({
      code: 'APP_API_TOO_LARGE',
    })
  })

  it('reports a stable unavailable error on non-Windows hosts', async () => {
    if (process.platform === 'win32') return
    expect(host.available()).toBe(false)
    await expect(host.tts({ text: 'hello' })).rejects.toBeInstanceOf(RpcError)
    await expect(host.ocr({ imageBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64') })).rejects.toMatchObject({
      code: 'APP_API_UNAVAILABLE',
    })
  })

  it('blocks private destinations, non-http schemes and oversized input before fetching', async () => {
    const blocked = [
      'http://127.0.0.1/',
      'http://10.1.2.3/',
      'http://172.20.0.1/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/',
      'http://[fd00::1]/',
      'file:///C:/Windows/win.ini',
      'http://user:pass@example.com/',
    ]
    for (const url of blocked) {
      await expect(host.fetchLink({ url }), url).rejects.toMatchObject({ code: 'APP_API_BLOCKED' })
    }
    await expect(host.fetchLink({ url: 'not a url' })).rejects.toMatchObject({ code: 'INVALID_MESSAGE' })
    await expect(host.fetchLink({ url: `https://example.com/${'a'.repeat(2_100)}` })).rejects.toMatchObject({ name: 'ZodError' })
  })
})
