import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderConnection } from '../../lib/schemas/provider'
import type { ApiKey } from '../db/schema'
import type { BackendModel } from '../inference/backend'
import { createProxyContext } from './context'
import { buildModelsListing, serveModelsListing } from './models-listing'

vi.mock('../config.ts', () => ({
  config: {
    inferenceBackend: 'llama-swap',
    inferenceBaseUrl: 'http://llama-swap.test',
    inferenceInsecure: false,
    inferenceConfigFile: '',
    databasePath: ':memory:',
    credentialEncryptionKey: 'x'.repeat(32),
  },
}))

vi.mock('../admin/settings.ts', () => ({
  getAttributionSettings: () => ({ clientHeader: '', endUserHeader: '', sessionHeader: '' }),
  getPrivacySettings: () => ({
    captureRequestBodies: false,
    captureResponseBodies: false,
    maxStoredBodyBytes: 1024,
  }),
  getRequestLimits: () => ({ maxMessages: null, maxEstimatedTokens: null }),
}))

const providersMock = vi.hoisted(() => ({
  list: vi.fn<() => import('../../lib/schemas/provider').ProviderConnection[]>(() => []),
}))

vi.mock('../admin/providers.ts', () => ({ listProviderConnections: providersMock.list }))

type OpenAiEntry = { id: string; object: 'model'; created: number; owned_by: string; [extra: string]: unknown }

const backendMock = vi.hoisted(() => ({
  inferenceBackend: {
    defaultProxyUpstream: (pathname: string, search: string) => `http://llama-swap.test${pathname}${search}`,
    listModels: vi.fn(async (): Promise<BackendModel[]> => []),
    listOpenAiModels: vi.fn(async (): Promise<OpenAiEntry[]> => []),
  },
}))

vi.mock('../inference/backend.ts', () => backendMock)

const logsMock = vi.hoisted(() => ({ writeRequestLog: vi.fn() }))

vi.mock('./log.ts', () => ({ writeRequestLog: logsMock.writeRequestLog }))

function makeConnection(overrides: Partial<ProviderConnection> = {}): ProviderConnection {
  return {
    id: 'prv_test',
    targetId: 'zai',
    targetLabel: 'Z.AI GLM · Pay-as-you-go',
    credentialId: 'ucr_test',
    credentialName: 'Z.AI key',
    routingRuleIds: [],
    models: ['glm-4.7', 'glm-4.5v'],
    modelsBySurface: { '/api/paas/v4': ['glm-4.7', 'glm-4.5v'] },
    modelsDiscoveredAt: new Date(0).toISOString(),
    enabled: true,
    createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
    updatedAt: new Date('2026-01-01T00:00:00Z').toISOString(),
    ...overrides,
  }
}

function makeKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: 'key_test',
    name: 'Test key',
    keyHash: 'hash',
    keyPrefix: 'sk-test',
    createdAt: new Date(0),
    disabledAt: null,
    expiresAt: null,
    modelAccessMode: 'all',
    allowedModels: '[]',
    allowedMcpRelays: '[]',
    rateLimitRpm: null,
    rateLimitTpm: null,
    monthlyTokenQuota: null,
    defaultModel: null,
    systemPrompt: null,
    system: false,
    ...overrides,
  }
}

beforeEach(() => {
  providersMock.list.mockReset().mockReturnValue([])
  backendMock.inferenceBackend.listOpenAiModels.mockReset().mockResolvedValue([])
  backendMock.inferenceBackend.listModels.mockReset().mockResolvedValue([])
  logsMock.writeRequestLog.mockReset()
})

describe('buildModelsListing', () => {
  it('merges the inference backend listing with connected provider models', async () => {
    backendMock.inferenceBackend.listOpenAiModels.mockResolvedValue([
      { id: 'llama3-8b', object: 'model', created: 1, owned_by: 'llama-swap', context_length: 8192 },
    ])
    providersMock.list.mockReturnValue([makeConnection()])

    const listing = await buildModelsListing(null)

    expect(listing.object).toBe('list')
    expect(listing.data.map((entry) => entry.id)).toEqual(['llama3-8b', 'glm-4.7', 'glm-4.5v'])

    // Backend entries keep their capability metadata verbatim.
    expect(listing.data[0]).toMatchObject({ context_length: 8192, owned_by: 'llama-swap' })

    // Provider entries carry the subscription as owner for human-readable UIs.
    const providerEntry = listing.data.find((entry) => entry.id === 'glm-4.5v')!
    expect(providerEntry).toMatchObject({
      object: 'model',
      owned_by: 'zai',
      name: 'glm-4.5v',
      description: 'Z.AI GLM · Pay-as-you-go',
      created: Math.floor(Date.parse('2026-01-01T00:00:00Z') / 1000),
    })
  })

  it('keeps the first source to claim an id — the inference backend wins ties', async () => {
    backendMock.inferenceBackend.listOpenAiModels.mockResolvedValue([
      { id: 'glm-4.7', object: 'model', created: 1, owned_by: 'llama-swap' },
    ])
    providersMock.list.mockReturnValue([makeConnection()])

    const listing = await buildModelsListing(null)

    expect(listing.data.map((entry) => entry.id)).toEqual(['glm-4.7', 'glm-4.5v'])
    expect(listing.data.find((entry) => entry.id === 'glm-4.7')?.owned_by).toBe('llama-swap')
  })

  it('filters both halves by a restricted key model access', async () => {
    backendMock.inferenceBackend.listOpenAiModels.mockResolvedValue([
      { id: 'llama3-8b', object: 'model', created: 1, owned_by: 'llama-swap' },
      { id: 'qwen3.8-27b', object: 'model', created: 1, owned_by: 'llama-swap' },
    ])
    providersMock.list.mockReturnValue([makeConnection()])
    const key = makeKey({ modelAccessMode: 'restricted', allowedModels: JSON.stringify(['glm-4.5v', 'llama3-8b']) })

    const listing = await buildModelsListing(key)

    expect(listing.data.map((entry) => entry.id)).toEqual(['llama3-8b', 'glm-4.5v'])
  })

  it('skips disabled connections', async () => {
    providersMock.list.mockReturnValue([makeConnection({ enabled: false })])

    const listing = await buildModelsListing(null)

    expect(listing.data).toEqual([])
  })

  it('falls back to the normalized model list when the backend has no raw listing', async () => {
    const backend = backendMock.inferenceBackend as { listOpenAiModels?: unknown }
    const rawListing = backend.listOpenAiModels
    delete backend.listOpenAiModels
    try {
      backendMock.inferenceBackend.listModels.mockResolvedValue([
        {
          id: 'local-model',
          name: 'Local Model',
          kind: 'local' as const,
          peerId: null,
          selector: null,
          running: true,
          contextLength: 4096,
          capabilities: { inputModalities: [], outputModalities: [], flags: [], supportedParameters: [] },
        },
      ])

      const listing = await buildModelsListing(null)

      expect(listing.data.map((entry) => entry.id)).toEqual(['local-model'])
      expect(listing.data[0]).toMatchObject({ object: 'model', owned_by: 'system' })
    } finally {
      backend.listOpenAiModels = rawListing
    }
  })
})

describe('serveModelsListing', () => {
  it('answers locally with the merged catalog and logs the exchange', async () => {
    backendMock.inferenceBackend.listOpenAiModels.mockResolvedValue([
      { id: 'llama3-8b', object: 'model', created: 1, owned_by: 'llama-swap' },
    ])
    providersMock.list.mockReturnValue([makeConnection()])
    const ctx = createProxyContext(new Request('http://dash.test/v1/models'))

    const response = await serveModelsListing(ctx)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json')
    const body = await response.json()
    expect(body.object).toBe('list')
    expect(body.data.map((entry: { id: string }) => entry.id)).toEqual(['llama3-8b', 'glm-4.7', 'glm-4.5v'])

    // Still one logged proxy exchange — but the generated catalog itself is
    // not stored as a response body on every client poll.
    expect(logsMock.writeRequestLog).toHaveBeenCalledTimes(1)
    expect(logsMock.writeRequestLog.mock.calls[0][0]).toMatchObject({
      statusCode: 200,
      endpoint: '/v1/models',
      responseBody: null,
    })
  })

  it('degrades to the upstream_unreachable error when the backend listing fails', async () => {
    backendMock.inferenceBackend.listOpenAiModels.mockRejectedValue(new Error('connection refused'))
    const ctx = createProxyContext(new Request('http://dash.test/v1/models'))

    const response = await serveModelsListing(ctx)

    expect(response.status).toBe(502)
    const body = await response.json()
    expect(body.error.type).toBe('upstream_unreachable')
    expect(body.error.message).toContain('connection refused')
    expect(logsMock.writeRequestLog.mock.calls[0][0]).toMatchObject({ statusCode: 502, endpoint: '/v1/models' })
  })
})
