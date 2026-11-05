import { listProviderConnections } from '../admin/providers.ts'
import { type BackendOpenAiModelEntry, inferenceBackend } from '../inference/backend.ts'
import type { ApiKey } from '../db/schema.ts'
import { loggedRequestHeaders, type ProxyContext } from './context.ts'
import { toErrorBody } from './errors.ts'
import { formatUpstreamError, nullUsage, writeProxyLog } from './forward.ts'

/**
 * `GET /v1/models` is answered here instead of being forwarded to the
 * inference backend. The backend's own listing (llama-swap: local models, GGUF
 * selectors, peers) is merged with the models of every connected provider
 * subscription (MiniMax, Xiaomi MiMo, Z.AI GLM), so one OpenAI-style client
 * sees one catalog for the whole gateway.
 *
 * The listing is flat: per-surface availability lives in the routing rules,
 * which claim only the models their API surface serves. Here a model is
 * advertised once — the first source to claim the id wins, the inference
 * backend first — and the key's model access (`all`/`restricted`) filters both
 * halves.
 */

export type ModelsListingEntry = {
  id: string
  object: 'model'
  created: number
  owned_by: string
  [extra: string]: unknown
}

export type ModelsListing = {
  object: 'list'
  data: ModelsListingEntry[]
}

function keyAllowsModel(keyRow: ApiKey | null, modelId: string): boolean {
  if (keyRow?.modelAccessMode !== 'restricted') return true
  let allowed: unknown
  try {
    allowed = JSON.parse(keyRow.allowedModels)
  } catch {
    allowed = []
  }
  return Array.isArray(allowed) && allowed.includes(modelId)
}

async function backendModelEntries(): Promise<Array<BackendOpenAiModelEntry>> {
  if (inferenceBackend.listOpenAiModels) return inferenceBackend.listOpenAiModels()
  // Capability fallback for backends without a raw listing: synthesize minimal
  // OpenAI-shaped entries from the normalized model list.
  const models = await inferenceBackend.listModels()
  return models.map((model) => ({
    id: model.id,
    object: 'model' as const,
    created: 0,
    owned_by: 'system',
    name: model.name,
  }))
}

/** Build the merged catalog, filtered by the calling key's model access. */
export async function buildModelsListing(keyRow: ApiKey | null): Promise<ModelsListing> {
  const data: ModelsListingEntry[] = []
  const seen = new Set<string>()

  for (const entry of await backendModelEntries()) {
    if (!entry.id || seen.has(entry.id) || !keyAllowsModel(keyRow, entry.id)) continue
    seen.add(entry.id)
    data.push(entry)
  }

  for (const connection of listProviderConnections()) {
    if (!connection.enabled) continue
    for (const model of connection.models) {
      if (!model || seen.has(model) || !keyAllowsModel(keyRow, model)) continue
      seen.add(model)
      data.push({
        id: model,
        object: 'model',
        created: Math.floor(Date.parse(connection.createdAt) / 1000) || 0,
        owned_by: connection.targetId,
        name: model,
        description: connection.targetLabel,
      })
    }
  }

  return { object: 'list', data }
}

/**
 * Answer `GET /v1/models` locally. The exchange is still logged like any other
 * proxy request; an unreachable inference backend degrades to the same
 * `upstream_unreachable` error the forwarding path returns.
 */
export async function serveModelsListing(ctx: ProxyContext): Promise<Response> {
  let listing: ModelsListing
  try {
    listing = await buildModelsListing(ctx.keyRow)
  } catch (err) {
    const detail = formatUpstreamError(err)
    writeProxyLog({
      startedAt: ctx.startedAt,
      status: 502,
      method: ctx.method,
      endpoint: ctx.endpoint,
      usage: nullUsage(),
      streamed: false,
      error: detail,
      reqHeaders: loggedRequestHeaders(ctx),
      reqBody: null,
      resHeaders: null,
      resBody: null,
      keyId: ctx.keyId,
      reqModel: null,
      attribution: ctx.attribution,
      routing: ctx.routingOutcome,
    })
    return Response.json(
      toErrorBody(ctx.endpoint, {
        error: { message: `Upstream unreachable: ${detail}`, type: 'upstream_unreachable' },
      }),
      { status: 502 },
    )
  }

  const body = JSON.stringify(listing)
  writeProxyLog({
    startedAt: ctx.startedAt,
    status: 200,
    method: ctx.method,
    endpoint: ctx.endpoint,
    usage: nullUsage(),
    streamed: false,
    error: null,
    reqHeaders: loggedRequestHeaders(ctx),
    reqBody: null,
    resHeaders: null,
    // The catalog is generated here, not fetched — don't store a full copy per
    // client poll in the request log.
    resBody: null,
    keyId: ctx.keyId,
    reqModel: null,
    attribution: ctx.attribution,
    routing: ctx.routingOutcome,
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
}
