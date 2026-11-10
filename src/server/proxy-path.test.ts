import { describe, expect, it } from 'vitest'
import { isInferenceProxyPath } from './proxy-path'

describe('isInferenceProxyPath', () => {
  it('routes native inference endpoints to the proxy instead of the dashboard', () => {
    expect(isInferenceProxyPath('/infill')).toBe(true)
    expect(isInferenceProxyPath('/tts')).toBe(false)
    expect(isInferenceProxyPath('/tts/other')).toBe(false)
    expect(isInferenceProxyPath('/tts-extra')).toBe(false)
    expect(isInferenceProxyPath('/v1/systemone')).toBe(true)
    expect(isInferenceProxyPath('/audiocpp')).toBe(true)
    expect(isInferenceProxyPath('/audiocpp/v1/audio/speech')).toBe(true)
    expect(isInferenceProxyPath('/login')).toBe(false)
    expect(isInferenceProxyPath('/')).toBe(false)
  })

  it('accepts clients that spell the version segment with uppercase', () => {
    // /V1/responses must reach the proxy, not fall through to the SPA HTML shell.
    expect(isInferenceProxyPath('/V1/responses')).toBe(true)
    expect(isInferenceProxyPath('/V1/models')).toBe(true)
    expect(isInferenceProxyPath('/V1/Chat/Completions')).toBe(true)
    expect(isInferenceProxyPath('/Infill')).toBe(true)
    expect(isInferenceProxyPath('/V1')).toBe(true)
  })
})
