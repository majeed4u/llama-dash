import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'
import { createMigratedTestDb } from '../db/test-db'

function modelsResponse(ids: string[]) {
  return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

async function loadProviderModule(fetchImpl?: typeof fetch) {
  // Each test gets a fresh module registry so the `vi.doMock` database swap
  // takes effect instead of reusing the previous test's cached module.
  vi.resetModules()
  const sqlite = createMigratedTestDb()
  const db = drizzle(sqlite, { schema })
  vi.doMock('../db/index.ts', () => ({ db, sqliteDb: sqlite, schema }))
  vi.doMock('../config.ts', () => ({ config: { credentialEncryptionKey: 'x'.repeat(32) } }))
  if (fetchImpl) vi.stubGlobal('fetch', fetchImpl)
  const providers = await import('./providers')
  const credentials = await import('./upstream-credentials')
  const rules = await import('./routing-rules')
  return { sqlite, db, providers, credentials, rules }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

it('connecting a target wires one credential, one rule per surface, and discovers models', async () => {
  const fetchMock = vi.fn(async (url: string | URL | Request) => {
    const href = String(url)
    if (href.includes('/models')) return modelsResponse(['mimo-v2.6-pro', 'mimo-v2.6-flash'])
    return new Response('not found', { status: 404 })
  })
  const { providers, credentials, rules } = await loadProviderModule(fetchMock as unknown as typeof fetch)

  const connection = await providers.connectProvider({
    targetId: 'mimo-tokenplan-sgp',
    apiKey: 'tp-mimo-secret',
  })

  expect(connection.targetId).toBe('mimo-tokenplan-sgp')
  expect(connection.targetLabel).toBe('Xiaomi MiMo · Token Plan · SGP')

  // The provider key is stored encrypted, never in plaintext.
  const creds = credentials.listUpstreamCredentials()
  expect(creds).toHaveLength(1)
  expect(creds[0].type).toBe('api_key')
  const secret = credentials.getCredentialInjectionSecret(creds[0].id, 'x'.repeat(32))
  expect(secret?.value).toBe('tp-mimo-secret')

  // Models come from the provider's listing, not from a hardcoded table.
  expect(connection.models).toEqual(['mimo-v2.6-pro', 'mimo-v2.6-flash'])
  expect(connection.modelsBySurface).toEqual({
    '/v1': ['mimo-v2.6-pro', 'mimo-v2.6-flash'],
    '/anthropic': ['mimo-v2.6-pro', 'mimo-v2.6-flash'],
  })
  expect(connection.modelsDiscoveredAt).not.toBeNull()

  // One routing rule per surface (OpenAI + Anthropic), both with the credential.
  const allRules = rules.listRoutingRules()
  expect(allRules).toHaveLength(2)
  const bases = allRules.map((rule) => (rule.target.type === 'direct' ? rule.target.baseUrl : '')).sort()
  expect(bases).toEqual(['https://token-plan-sgp.xiaomimimo.com/anthropic', 'https://token-plan-sgp.xiaomimimo.com/v1'])
  const joins = allRules.map((rule) => (rule.target.type === 'direct' ? rule.target.pathJoin : '')).sort()
  expect(joins).toEqual(['keep-v1', 'strip-v1'])
  for (const rule of allRules) {
    expect(rule.target.type === 'direct' && rule.target.credentialId).toBe(creds[0].id)
    expect(rule.authMode).toBe('require_key')
    expect(rule.action.type).toBe('continue')
    // Provider rules only claim the provider's own models — never local ones.
    expect(rule.match.requestedModels).toEqual(['mimo-v2.6-pro', 'mimo-v2.6-flash'])
    expect(rule.enabled).toBe(true)
  }

  // The anthropic surface claims Messages endpoints only.
  const anthropicRule = allRules.find((rule) => rule.target.type === 'direct' && rule.target.pathJoin === 'keep-v1')!
  expect(anthropicRule.match.endpoints).toEqual(['/v1/messages', '/v1/messages/count_tokens'])
})

it('connecting without a reachable models listing still works with an empty model list', async () => {
  const fetchMock = vi.fn(async () => new Response('down', { status: 500 }))
  const { providers, rules } = await loadProviderModule(fetchMock as unknown as typeof fetch)

  const connection = await providers.connectProvider({ targetId: 'minimax', apiKey: 'sk-minimax' })

  expect(connection.models).toEqual([])
  expect(connection.modelsBySurface).toEqual({ '/v1': [], '/anthropic': [] })
  expect(connection.modelsDiscoveredAt).toBeNull()
  expect(connection.routingRuleIds).toHaveLength(2)
  // With no known models the rules stay disabled so they can't hijack traffic.
  for (const rule of rules.listRoutingRules()) {
    expect(rule.match.requestedModels).toEqual([])
    expect(rule.enabled).toBe(false)
  }
})

it('rejects a second connection for the same target and unknown targets', async () => {
  const { providers, credentials } = await loadProviderModule(
    vi.fn(async () => modelsResponse(['glm-5.3'])) as unknown as typeof fetch,
  )

  await providers.connectProvider({ targetId: 'zai', apiKey: 'sk-zai-1' })
  await expect(providers.connectProvider({ targetId: 'zai', apiKey: 'sk-zai-2' })).rejects.toThrow('already connected')
  await expect(providers.connectProvider({ targetId: 'nope', apiKey: 'sk-x' })).rejects.toThrow(
    'Unknown provider target',
  )
  expect(credentials.listUpstreamCredentials()).toHaveLength(1)
})

it('disconnecting removes every rule and the credential', async () => {
  const { providers, credentials, rules } = await loadProviderModule(
    vi.fn(async () => modelsResponse(['glm-5.3'])) as unknown as typeof fetch,
  )

  await providers.connectProvider({ targetId: 'zai-coding', apiKey: 'sk-zai-coding' })
  expect(rules.listRoutingRules()).toHaveLength(3) // zai-coding exposes 3 surfaces
  expect(credentials.listUpstreamCredentials()).toHaveLength(1)

  expect(providers.disconnectProvider('zai-coding')).toBe(true)
  expect(rules.listRoutingRules()).toHaveLength(0)
  expect(credentials.listUpstreamCredentials()).toHaveLength(0)
  expect(providers.listProviderConnections()).toHaveLength(0)
  expect(providers.disconnectProvider('zai-coding')).toBe(false)
})

it('refresh re-discovers models and re-scopes the routing rules', async () => {
  let response = ['old-model']
  const fetchMock = vi.fn(async () => modelsResponse(response))
  const { providers, rules } = await loadProviderModule(fetchMock as unknown as typeof fetch)

  await providers.connectProvider({ targetId: 'minimax', apiKey: 'sk-minimax' })
  response = ['new-model-a', 'new-model-b']
  const refreshed = await providers.refreshProviderModels('minimax')
  expect(refreshed.models).toEqual(['new-model-a', 'new-model-b'])
  for (const rule of rules.listRoutingRules()) {
    expect(rule.match.requestedModels).toEqual(['new-model-a', 'new-model-b'])
    expect(rule.enabled).toBe(true)
  }
})

it('discovers models per surface and scopes each routing rule to its own surface', async () => {
  const fetchMock = vi.fn(async (url: string | URL | Request) => {
    const href = String(url)
    if (href.includes('/api/paas/v4/models')) return modelsResponse(['glm-4.7', 'glm-4.5v'])
    if (href.includes('/api/anthropic/v1/models')) return modelsResponse(['glm-4.6', 'glm-4.7'])
    if (href.includes('/api/v1/models')) return modelsResponse(['glm-ruminate'])
    return new Response('not found', { status: 404 })
  })
  const { providers, rules } = await loadProviderModule(fetchMock as unknown as typeof fetch)

  const connection = await providers.connectProvider({ targetId: 'zai', apiKey: 'sk-zai' })

  // The flat list is the deduplicated union in surface order; the split keeps
  // each surface's own truth.
  expect(connection.models).toEqual(['glm-4.7', 'glm-4.5v', 'glm-4.6', 'glm-ruminate'])
  expect(connection.modelsBySurface).toEqual({
    '/api/paas/v4': ['glm-4.7', 'glm-4.5v'],
    '/api/anthropic': ['glm-4.6', 'glm-4.7'],
    '/api/v1': ['glm-ruminate'],
  })

  const rulesByBase = new Map(
    rules.listRoutingRules().map((rule) => [rule.target.type === 'direct' ? rule.target.baseUrl : '', rule] as const),
  )
  const chatRule = rulesByBase.get('https://api.z.ai/api/paas/v4')!
  expect(chatRule.match.endpoints).toEqual([
    '/v1/chat/completions',
    '/v1/completions',
    '/v1/audio/speech',
    '/v1/audio/transcriptions',
    '/v1/images/generations',
  ])
  expect(chatRule.match.requestedModels).toEqual(['glm-4.7', 'glm-4.5v'])

  const anthropicRule = rulesByBase.get('https://api.z.ai/api/anthropic')!
  expect(anthropicRule.match.endpoints).toEqual(['/v1/messages', '/v1/messages/count_tokens'])
  expect(anthropicRule.match.requestedModels).toEqual(['glm-4.6', 'glm-4.7'])

  const responsesRule = rulesByBase.get('https://api.z.ai/api/v1')!
  expect(responsesRule.match.endpoints).toEqual(['/v1/responses'])
  expect(responsesRule.match.requestedModels).toEqual(['glm-ruminate'])

  for (const rule of rules.listRoutingRules()) expect(rule.enabled).toBe(true)
})

it('refresh re-scopes each rule to its own surface and disables surfaces that stop listing', async () => {
  let respond: (href: string) => Response = () => modelsResponse(['glm-4.7'])
  const fetchMock = vi.fn(async (url: string | URL | Request) => respond(String(url)))
  const { providers, rules } = await loadProviderModule(fetchMock as unknown as typeof fetch)

  await providers.connectProvider({ targetId: 'zai', apiKey: 'sk-zai' })

  respond = (href) => {
    if (href.includes('/api/paas/v4/models')) return modelsResponse(['glm-4.7', 'glm-5'])
    if (href.includes('/api/anthropic/v1/models')) return new Response('down', { status: 500 })
    return modelsResponse(['glm-ruminate'])
  }
  const connection = await providers.refreshProviderModels('zai')

  expect(connection.models).toEqual(['glm-4.7', 'glm-5', 'glm-ruminate'])
  expect(connection.modelsBySurface).toEqual({
    '/api/paas/v4': ['glm-4.7', 'glm-5'],
    '/api/anthropic': [],
    '/api/v1': ['glm-ruminate'],
  })

  const rulesByBase = new Map(
    rules.listRoutingRules().map((rule) => [rule.target.type === 'direct' ? rule.target.baseUrl : '', rule] as const),
  )
  expect(rulesByBase.get('https://api.z.ai/api/paas/v4')!.match.requestedModels).toEqual(['glm-4.7', 'glm-5'])
  expect(rulesByBase.get('https://api.z.ai/api/paas/v4')!.enabled).toBe(true)
  // The Anthropic surface listed nothing this round — its rule stops claiming
  // models and disables instead of hijacking every /v1/messages request.
  expect(rulesByBase.get('https://api.z.ai/api/anthropic')!.match.requestedModels).toEqual([])
  expect(rulesByBase.get('https://api.z.ai/api/anthropic')!.enabled).toBe(false)
  expect(rulesByBase.get('https://api.z.ai/api/v1')!.match.requestedModels).toEqual(['glm-ruminate'])
  expect(rulesByBase.get('https://api.z.ai/api/v1')!.enabled).toBe(true)
})
