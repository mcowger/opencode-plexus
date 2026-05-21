# Implementation Plan: `@mcowger/opencode-plexus`

An OpenCode plugin that exposes a self-hosted [Plexus](https://github.com/mcowger/plexus) instance as a first-class `plexus` provider, with dynamic model discovery from `/v1/models`.

---

## 1. Goal & Scope

Build an OpenCode plugin that adds **`plexus`** as a fully-functional provider backed by a user's self-hosted Plexus instance. The plugin must:

- Authenticate via API key (entered through OpenCode's auth flow, env var, or `opencode.json`).
- Discover the user's Plexus base URL (entered through auth, env var, or `opencode.json`).
- **Dynamically register models** by fetching `/v1/models` from the user's Plexus instance and transforming the response into the OpenCode model schema.
- Persist user-supplied base URL and API key into OpenCode's global config so subsequent loads pick them up automatically.
- Survive offline startup via a local model-list cache stored under OpenCode's own state directory.
- Wire up `@ai-sdk/openai-compatible` as the SDK provider so OpenCode can actually call the proxied models.

---

## 2. Key Architectural Decisions

### 2.1 Dynamic model registration via the `config` hook

The OpenCode `Hooks.config` hook receives the resolved `Config` object and is allowed to **mutate `cfg.provider[<id>]`** in place. This is how `opencode-local-provider` registers models discovered at runtime, and it's the pattern we'll follow:

```ts
cfg.provider.plexus = {
  name: "Plexus",
  npm: "@ai-sdk/openai-compatible",
  options: { baseURL, apiKey, /* user overrides preserved */ },
  models: { /* fetched & transformed from /v1/models */ },
}
```

This means we do **not** need users to hand-author model entries in `opencode.json`.

### 2.2 Persisting base URL & key via the v2 SDK client

The `auth.authorize()` flow uses `@opencode-ai/sdk/v2/client`'s `client.global.config.update()` to persist `{ baseURL, apiKey }` into `cfg.provider.plexus.options`. On the next session start, the `config` hook reads them straight back out — no separate sidecar file from us.

`@ai-sdk/openai-compatible` picks up `apiKey` and `baseURL` directly from `cfg.provider.plexus.options`, so the `loader` function is largely redundant for runtime calls. We still ship a defensive `loader` as a safety net.

### 2.3 Cache storage via `client.path.get()`

OpenCode's plugin SDK exposes `client.path.get()` which returns:

```ts
{ state, config, worktree, directory /*, home (v2) */ }
```

`state` is OpenCode's canonical app-data dir (default `~/.local/share/opencode/` on macOS/Linux). We write our cache under `${state}/plugins/plexus/` — this:

- Inherits whatever overrides OpenCode honors (env vars, sandboxing, platform conventions) for free.
- Co-locates our data with OpenCode's own state, so `rm -rf ~/.local/share/opencode` (the documented "reset" step) also clears our cache.
- Mirrors the `opencode-memory` plugin's de-facto convention but is namespaced under `plugins/` to avoid crowding OpenCode's top-level files.

Fallback (if an older host lacks the endpoint): `~/.local/share/opencode/plugins/plexus/`.

### 2.4 Single OpenAI-compatible default + escape hatch

Default `npm` is `@ai-sdk/openai-compatible`. README documents how users who need anthropic-messages / gemini routes for specific Plexus-proxied models can register sibling providers (`plexus-anthropic`, etc.) by hand.

### 2.5 Ignore `pi_provider` / `pi_model` hints

These exist in the Plexus API for the sister `pi-plexus` extension but have no equivalent in OpenCode's model schema. Skipped.

---

## 3. File Layout

```
oc-plexus/
├── package.json              # name, deps, build script, exports
├── tsconfig.json             # strict, ESNext, bundler resolution, dist output
├── PLAN.md                   # this file
├── PROVIDER_SPEC.md          # existing reference spec
├── README.md                 # install + usage
├── LICENSE                   # MIT
├── src/
│   ├── index.ts              # PluginModule default export ({ id, server })
│   ├── plugin.ts             # The Plugin function returning Hooks (auth + config)
│   ├── constants.ts          # Provider id, npm name, env-var names, defaults
│   ├── config-store.ts       # Read/write user config (env + opencode.json options)
│   ├── plexus-client.ts      # fetch /v1/models with optional bearer auth, zod-validated
│   ├── models.ts             # Transform PlexusApiModel → OpenCode Model schema
│   ├── cache.ts              # Disk cache via client.path.get() (offline boot)
│   ├── url.ts                # URL normalization (strip trailing slashes, ensure /v1)
│   ├── log.ts                # Tiny logger via ctx.client.app.log()
│   └── types.ts              # PlexusApiModel, PlexusApiResponse, internal types
└── tests/
    ├── models.test.ts        # Unit tests for transform with real plexus models.json
    └── url.test.ts           # URL normalization edge cases
```

---

## 4. Module Design

### 4.1 `src/constants.ts`
```ts
export const PLEXUS_PROVIDER_ID   = "plexus"
export const PLEXUS_PROVIDER_NAME = "Plexus"
export const PLEXUS_PLUGIN_ID     = "@mcowger/opencode-plexus"
export const PLEXUS_LOG_SERVICE   = "opencode-plexus"
export const OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible"

export const ENV_BASE_URL = "PLEXUS_BASE_URL"
export const ENV_API_KEY  = "PLEXUS_API_KEY"

export const MODELS_FETCH_TIMEOUT_MS = 10_000
export const REFRESH_TTL_MS          = 60_000
export const DEFAULT_CONTEXT         = 8192
```

### 4.2 `src/types.ts`
Mirror `pi-plexus`'s `PlexusApiModel` / `PlexusApiResponse` shapes:

- `id`, `name`, `description`
- `context_length`
- `architecture { input_modalities, output_modalities, tokenizer }`
- `pricing { prompt, completion, input_cache_read, input_cache_write }` (per-million-tokens strings, per Plexus convention)
- `supported_parameters: string[]`
- `top_provider { context_length, max_completion_tokens }`
- `preferred_api: string | string[]` (kept for forward-compat; ignored on the default openai path)

Plus a `ResolvedConfig` interface holding the merged `{ baseURL?, apiKey? }`.

### 4.3 `src/url.ts`
Pure helpers:
- `trimURL(s)` — strip trailing slashes / whitespace; return `""` for invalid input.
- `apiBase(baseURL)` — return `${root}/v1`.
- `modelsUrl(baseURL)` — return `${root}/v1/models`.

### 4.4 `src/config-store.ts`
Pure resolution + persistence; no fetches.

```ts
// Resolution priority: env > opencode.json options
export function resolveConfig(provider?: Provider): { baseURL?: string; apiKey?: string }

// Persist base URL + API key into OpenCode global config
export async function persistToGlobalConfig(
  serverUrl: URL,
  client: PluginInput["client"],
  baseURL: string,
  apiKey: string,
): Promise<void>
```

`persistToGlobalConfig` builds a v2 client via `createOpencodeClient` from `@opencode-ai/sdk/v2/client` (re-using the v1 client's transport/headers, as in `opencode-local-provider`) and calls `client.global.config.update({ config: { provider: { plexus: { options: { baseURL, apiKey }}}}})`.

### 4.5 `src/plexus-client.ts`
```ts
export async function fetchPlexusModels(
  baseURL: string,
  apiKey?: string,
): Promise<{ models: PlexusApiModel[]; raw: PlexusApiResponse }>
```

- `fetch(modelsUrl(baseURL), { headers: { Accept: "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) }, signal: AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS) })`
- Validates the response body with Zod (port the schemas from `kilo`'s `models.ts`).
- Throws on HTTP error; caller decides fallback.
- API key is **optional** because Plexus's `/v1/models` does not require auth.

### 4.6 `src/models.ts`
Transformer from `PlexusApiModel[]` → `Record<string, ConfigModel>` (OpenCode model schema):

| Plexus field | OpenCode model field |
|---|---|
| `id` (also key) | `id` |
| `name` | `name` |
| `context_length` (or `top_provider.context_length`) | `limit.context` |
| `top_provider.max_completion_tokens` ?? `context * 0.2` | `limit.output` |
| `pricing.prompt` / `.completion` / `.input_cache_read` / `.input_cache_write` | `cost.input` / `.output` / `.cache_read` / `.cache_write` (raw `parseFloat` — Plexus emits per-million already) |
| `architecture.input_modalities` | `modalities.input` (`text` / `image` / `audio` / `video` / `pdf`; `file` → `pdf`) |
| `architecture.output_modalities` | `modalities.output` (skip the model entirely if it includes `image`) |
| `supported_parameters` includes `tools` | `tool_call: true` |
| `supported_parameters` includes `reasoning` / `include_reasoning` / `reasoning_effort` | `reasoning: true` |
| `supported_parameters` includes `temperature` | `temperature: true` |
| post-mapped input modalities other than `text` | `attachment: true` |

`pi_provider` / `pi_model` are ignored.

### 4.7 `src/cache.ts`
Cache helpers using `client.path.get()`:

```ts
const PLUGIN_SUBDIR = path.join("plugins", "plexus")
const CACHE_FILE = "models-cache.json"
const RAW_FILE   = "models-raw.json"

let resolvedDir: string | null = null

async function getDir(client: PluginInput["client"]): Promise<string> {
  if (resolvedDir) return resolvedDir
  try {
    const res = await client.path.get()
    const state = (res as any)?.data?.state ?? (res as any)?.state
    if (typeof state === "string" && state) {
      resolvedDir = path.join(state, PLUGIN_SUBDIR)
      return resolvedDir
    }
  } catch { /* fall through */ }
  resolvedDir = path.join(os.homedir(), ".local", "share", "opencode", PLUGIN_SUBDIR)
  return resolvedDir
}

export function readCachedModelsSync(): Record<string, ConfigModel>     // homedir fallback only
export async function readCachedModels(client): Promise<Record<string, ConfigModel>>
export async function writeCache(client, models, raw?): Promise<void>   // mkdir -p; non-fatal on error
```

Notes:
- `readCachedModelsSync()` uses only the homedir fallback. The next async refresh in the same `config` hook rewrites the cache at the SDK-resolved location, so transient mismatches self-heal.
- All write failures log and continue — never block plugin init.

### 4.8 `src/log.ts`
Wrapper around `ctx.client.app.log({ body: { service: PLEXUS_LOG_SERVICE, level, message } })`. Captures the client at plugin init. Provides `info` / `warn` / `error`.

### 4.9 `src/plugin.ts` — the core

```ts
const REFRESH_TTL_MS = 60_000
let lastRefresh: { at: number; models: Record<string, ConfigModel> } | null = null

async function refreshModels(client, baseURL, apiKey?) {
  if (lastRefresh && Date.now() - lastRefresh.at < REFRESH_TTL_MS) return lastRefresh.models
  const { models, raw } = await fetchPlexusModels(baseURL, apiKey)
  const built = buildModels(models)
  lastRefresh = { at: Date.now(), models: built }
  writeCache(client, built, raw).catch(() => {})  // fire & forget
  return built
}

export const PlexusProviderPlugin: Plugin = async (ctx) => {
  const { client } = ctx
  const log = createLogger(client)

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      const existing = (cfg.provider[PLEXUS_PROVIDER_ID] ?? {}) as Provider
      const { baseURL, apiKey } = resolveConfig(existing)

      const merged: Provider = {
        ...existing,
        name: existing.name ?? PLEXUS_PROVIDER_NAME,
        npm:  existing.npm  ?? OPENAI_COMPATIBLE_NPM,
        options: {
          ...existing.options,
          ...(baseURL ? { baseURL: apiBase(baseURL) } : {}),
          ...(apiKey  ? { apiKey } : {}),
        },
        models: existing.models ?? readCachedModelsSync(),
      }

      if (baseURL) {
        try {
          const built = await refreshModels(client, baseURL, apiKey)
          // user-defined model overrides in opencode.json win on a per-id basis
          merged.models = { ...built, ...(existing.models ?? {}) }
          log.info(`Loaded ${Object.keys(built).length} plexus models`)
        } catch (e) {
          log.warn(`Live model refresh failed, using cache: ${e}`)
          merged.models = (await readCachedModels(client)) ?? merged.models
        }
      } else {
        log.info("Plexus baseURL not configured; skipping live refresh")
      }

      cfg.provider[PLEXUS_PROVIDER_ID] = merged
    },

    auth: {
      provider: PLEXUS_PROVIDER_ID,
      // Defensive loader — most call paths resolve via cfg.provider.plexus.options
      async loader(getAuth, info) {
        const auth = await getAuth()
        const { baseURL, apiKey } = resolveConfig(info)
        const key = (auth?.type === "api" ? auth.key : undefined) ?? apiKey
        return {
          ...(baseURL ? { baseURL: apiBase(baseURL) } : {}),
          ...(key     ? { apiKey: key } : {}),
        }
      },
      methods: [
        {
          type: "api",
          label: "Plexus (API key)",
          prompts: [
            { type: "text", key: "baseURL",
              message: "Plexus base URL",
              placeholder: "https://plexus.example.com",
              validate: v => trimURL(v) ? undefined : "URL is required" },
            { type: "text", key: "apiKey",
              message: "Plexus API key",
              placeholder: "sk-...",
              validate: v => v?.trim() ? undefined : "API key is required" },
          ],
          async authorize(inputs = {}) {
            const baseURL = trimURL(inputs.baseURL ?? "")
            const apiKey  = (inputs.apiKey ?? "").trim()
            if (!baseURL || !apiKey) return { type: "failed" }

            // Probe URL reachability only — /v1/models doesn't require auth.
            try { await fetchPlexusModels(baseURL) }
            catch (e) { log.error(`Plexus URL probe failed at ${baseURL}: ${e}`); return { type: "failed" } }

            await persistToGlobalConfig(ctx.serverUrl, client, baseURL, apiKey)
            lastRefresh = null  // force the next config() call to refresh
            return { type: "success", provider: PLEXUS_PROVIDER_ID, key: apiKey }
          },
        },
      ],
    },
  }
}
```

### 4.10 `src/index.ts`
```ts
import type { PluginModule } from "@opencode-ai/plugin"
import { PLEXUS_PLUGIN_ID } from "./constants"
import { PlexusProviderPlugin } from "./plugin"

export * from "./constants"
export * from "./plugin"
export * from "./types"

const plugin: PluginModule = {
  id: PLEXUS_PLUGIN_ID,
  server: PlexusProviderPlugin,
}

export default plugin
```

---

## 5. Configuration Resolution Priority

1. `process.env.PLEXUS_BASE_URL` / `PLEXUS_API_KEY` if set.
2. `cfg.provider.plexus.options.{baseURL, apiKey}` (which the auth flow may have just written via `client.global.config.update`).
3. (Implicit) — none; the plugin returns gracefully with no models.

The auth flow itself writes directly into OpenCode's global config so values surface at #2 on the next load. No private sidecar files for credentials.

---

## 6. Multi-API Escape Hatch

**Default**: `provider.plexus.npm = "@ai-sdk/openai-compatible"` — works for the vast majority of Plexus models.

**README documents** sibling-provider setup for non-OpenAI APIs:
```jsonc
{
  "provider": {
    "plexus":           { /* default, openai-compatible — set up by plugin */ },
    "plexus-anthropic": {
      "npm": "@ai-sdk/anthropic",
      "options": { "baseURL": "https://plexus.example.com" /* no /v1 */ },
      "models": { "claude-sonnet-4-6": { /* manually curated */ } }
    }
  }
}
```

The plugin only manages the single `plexus` provider; users who need anthropic-messages or gemini routes set up siblings manually.

---

## 7. `package.json`

```json
{
  "name": "@mcowger/opencode-plexus",
  "version": "0.1.0",
  "description": "OpenCode plugin: Plexus provider with dynamic model discovery",
  "type": "module",
  "module": "./dist/index.js",
  "main": "./dist/index.js",
  "exports": { ".": "./dist/index.js", "./server": "./dist/index.js" },
  "files": ["dist", "README.md", "LICENSE"],
  "license": "MIT",
  "publishConfig": { "access": "public" },
  "scripts": {
    "build": "bun build src/index.ts --outdir=dist --target=bun --format=esm --packages=external",
    "typecheck": "tsc --noEmit",
    "test": "bun test ./tests"
  },
  "dependencies": {
    "@opencode-ai/plugin": "^1.14.46",
    "@opencode-ai/sdk":    "^1.14.46",
    "zod": "^4.0.0"
  },
  "peerDependencies": { "typescript": "^5" },
  "devDependencies": { "@types/bun": "latest", "typescript": "^5" }
}
```

`@ai-sdk/openai-compatible` is **not** a direct dep — OpenCode installs it on demand via the `npm` field on the provider config (same pattern as `opencode-local-provider`).

---

## 8. `tsconfig.json` Adjustments

Keep current strict / bundler settings; for build emit add:
```jsonc
"declaration": true,
"outDir": "./dist",
"rootDir": "./src"
```

`bun build` emits the JS bundle. If shipping `.d.ts` for IDE consumers, add a separate `tsc --emitDeclarationOnly` step.

---

## 9. README Outline

1. What it does (single-paragraph overview).
2. Install: `opencode plugin --global @mcowger/opencode-plexus`.
3. Setup paths:
   - **A (recommended)**: `opencode auth login --provider plexus` → enter base URL + key.
   - **B (env vars)**: export `PLEXUS_BASE_URL` and `PLEXUS_API_KEY`.
   - **C (manual)**: snippet showing direct `opencode.json` configuration.
4. How models are discovered (live `/v1/models` + on-disk cache via OpenCode's state dir).
5. Multi-API escape hatch for non-OpenAI Plexus models.
6. Troubleshooting:
   - Cache lives under OpenCode's own state dir (default `~/.local/share/opencode/plugins/plexus/`); clearing OpenCode's state per the troubleshooting docs also clears ours.
   - `PLEXUS_API_KEY` is required for chat completions but **not** for model discovery.

---

## 10. Testing Plan

**Unit tests** (`bun test`):
- `models.test.ts`: feed `/Users/matt.cowger/workspace/pi-plexus/models.json` (real Plexus response) into `buildModels` and assert:
  - Output keyed by model id.
  - Image-output models filtered out.
  - `tool_call` / `reasoning` / `temperature` / `attachment` flags inferred correctly.
  - `limit.context` / `limit.output` populated.
  - `cost.cache_read` / `cost.cache_write` only present when input prices are.
  - Per-million-tokens passthrough: `"3.0"` → `cost.input === 3.0`.
  - `architecture.input_modalities` containing `"file"` → `pdf` and `attachment: true`.
- `url.test.ts`: trailing slash, `/v1` suffix, `http`/`https`, IP+port edge cases.

**Manual smoke tests**:
- `bun run typecheck` clean.
- `bun run build` produces `dist/index.js`.
- Install into a local OpenCode (`opencode plugin $PWD`); launch; run `/auth login` → enter URL + key → models appear in the model picker.
- Send a chat message; verify the request hits `${baseURL}/v1/chat/completions` with `Authorization: Bearer …`.
- Restart OpenCode with the network down; cached models still appear.

---

## 11. Implementation Order

1. Boilerplate: rewrite `package.json`, update `tsconfig.json`, install deps.
2. `constants.ts`, `types.ts`, `url.ts` (+ `url.test.ts`).
3. `models.ts` (+ `models.test.ts` against `pi-plexus/models.json`).
4. `cache.ts`, `plexus-client.ts`.
5. `config-store.ts` (resolve + persist via v2 client).
6. `log.ts`, `plugin.ts`, `index.ts`.
7. `README.md`, `LICENSE`.
8. Verify: `bun run typecheck` → `bun test` → `bun run build`.
9. Local install into OpenCode for end-to-end smoke test.
10. Iterate on edge cases (concurrent refreshes, weird modality combos) based on real-world behavior.

---

## 12. Resolved Design Questions

| Question | Resolution |
|---|---|
| Base URL source | Env var > `opencode.json` options. Auth flow writes to options via `client.global.config.update`. |
| Auth methods | API key only (with prompts for `baseURL` and `apiKey`). |
| Model registration | Dynamic, via `Hooks.config` mutating `cfg.provider.plexus.{npm, options, models}`. |
| AI SDK provider | `@ai-sdk/openai-compatible` default; sibling-provider escape hatch documented. |
| Pricing units | Plexus emits per-million-tokens; raw `parseFloat` passthrough. |
| `architecture.input_modalities = "file"` | Map to `pdf`. |
| Concurrent `config()` calls | 60-second in-process throttle on the `/v1/models` fetch. |
| `/v1/models` auth | Not required; URL probe in `authorize()` skips the bearer header. |
| `pi_provider` / `pi_model` hints | Ignored (no equivalent in OpenCode). |
| Cache location | `${client.path.get().state}/plugins/plexus/` (fallback `~/.local/share/opencode/plugins/plexus/`). |
| Package name / provider id | `@mcowger/opencode-plexus` / `plexus`. |

---

## 13. References

- **Spec**: [`PROVIDER_SPEC.md`](./PROVIDER_SPEC.md)
- **OpenCode plugin SDK types**: `@opencode-ai/plugin` `dist/index.d.ts` (in `node_modules` of `opencode-kilo-auth`).
- **Reference plugin (auth + static models)**: `/Users/matt.cowger/workspace/opencode-kilo-auth`
- **Reference plugin (dynamic models via `config` hook)**: `/Users/matt.cowger/workspace/opencode-local-provider`
- **Plexus API shape & sister extension**: `/Users/matt.cowger/workspace/pi-plexus`
- **OpenCode docs**:
  - Plugins: https://opencode.ai/docs/plugins/
  - Troubleshooting / storage paths: https://opencode.ai/docs/troubleshooting/
  - Config: https://opencode.ai/docs/config/
- **Storage primitive**: `client.path.get()` returning `{ state, config, worktree, directory }` — see `@opencode-ai/sdk` `dist/gen/sdk.gen.d.ts` and `dist/gen/types.gen.d.ts`.
