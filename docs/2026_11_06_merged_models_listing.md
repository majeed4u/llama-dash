# Merged `/v1/models` listing and per-surface provider discovery

Date: 2026-11-06

## Problem

`GET /v1/models` was a raw pass-through to llama-swap, so OpenAI-style clients
that enumerate models saw only local GGUF/peer models — even with Z.AI GLM,
MiniMax, or Xiaomi MiMo subscriptions connected. Provider models existed only
in the admin catalog (`GET /api/providers`, the Models page, playground
pickers), which the proxy never consulted for listings. Requests for provider
models worked (routing rules match on the body's `model` field), so the
listing was simply incomplete.

A second, related gap: provider discovery probed only the first surface that
answered, and every routing rule of a connection claimed that flat model list.
The OpenAI, Anthropic, and Responses surfaces of one subscription do not serve
identical model sets (e.g. MiniMax's Anthropic surface serves only
MiniMax-M3.1-Flash / MiniMax-M3), so a rule could claim models its surface
doesn't actually serve.

## What shipped (two commits)

### 1. Per-surface discovery + rule scoping

- `probeSurfaceModels` now probes **every** surface of a target and returns a
  per-surface split keyed by surface mount path (`/v1`, `/api/paas/v4`,
  `/api/anthropic`, …) alongside the flat union.
- The split persists in `provider_connections.models_by_surface_json`
  (migration `0047`); the API shape carries `modelsBySurface` next to `models`.
- Each routing rule created at connect time (and re-scoped on refresh) claims
  only its own surface's discovered models, and disables itself when that
  surface lists none — a rule with an empty model list would otherwise hijack
  every request, including local llama-swap traffic.
- Rule names now include the surface path so two `openai` surfaces of one
  target (Z.AI's `/api/paas/v4` and `/api/v1`) are distinguishable.

### 2. Merged `/v1/models` (`src/server/proxy/models-listing.ts`)

`GET /v1/models` is answered locally unless a routing rule explicitly targets
a direct upstream for it:

- **Backend half** — the inference backend's raw OpenAI-shaped listing via the
  new `listOpenAiModels()` facade capability (llama-swap's v229 capability
  metadata passes through verbatim). Backends without the capability fall back
  to synthesizing entries from the normalized `listModels()`.
- **Provider half** — one entry per model of every *enabled* provider
  connection, `owned_by` the target id and `description` the target label.
- **Deduped** — first source to claim an id wins; the inference backend comes
  first, so a local model shadows a same-named provider model.
- **ACL-filtered** — a `restricted` key sees only its `allowedModels`; `all`
  keys and open proxies see everything.
- **Logged like any proxy exchange**, but metadata-only: the generated catalog
  is not stored as a response body on every client poll.

If the backend listing fails, the response is the same `upstream_unreachable`
502 the forwarding path returns.

## Deliberate trade-off: the listing is flat

A model that only some surfaces serve is advertised once in the merged
listing. Per-surface truth lives in the routing rules: a request for a model
that only the Anthropic surface serves won't match the OpenAI rule (which
claims only its own models) and falls through to llama-swap with a clear
"model not found" instead of being misrouted. The alternative — hiding
surface-restricted models from `/v1/models` — would make them invisible to
Anthropic-style clients that could serve them.

## Known follow-ups

- The Models page and playground pickers still show the flat union
  (`connection.models`); they could group by surface using `modelsBySurface`.
- Alias names are not listed in the merged catalog (a key restricted to an
  alias name would not see the underlying model id).
