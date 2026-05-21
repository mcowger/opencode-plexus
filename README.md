# @mcowger/opencode-plexus

An [OpenCode](https://opencode.ai) plugin that exposes a self-hosted [Plexus](https://github.com/mcowger/plexus) instance as a first-class `plexus` provider with **dynamic model discovery**.

Models are fetched live from your Plexus instance's `/v1/models` endpoint on every startup, and cached on-disk so OpenCode starts cleanly even when the network is unavailable.

---

## Installation

```bash
opencode plugin --global @mcowger/opencode-plexus
```

---

## Setup

### Option A — Interactive auth (recommended)

```bash
opencode auth login --provider plexus
```

You will be prompted for:
- **Plexus base URL** — e.g. `https://plexus.example.com`
- **API key** — the key used to authenticate chat-completion requests

OpenCode will probe the URL, then persist both values in its global config so you only need to do this once.

### Option B — Environment variables

```bash
export PLEXUS_BASE_URL=https://plexus.example.com
export PLEXUS_API_KEY=sk-...
```

Environment variables take precedence over the stored config.

### Option C — Manual `opencode.json`

```jsonc
{
  "provider": {
    "plexus": {
      "options": {
        "baseURL": "https://plexus.example.com",
        "apiKey": "sk-..."
      }
    }
  }
}
```

---

## How it works

1. On startup the plugin's `config` hook fires.
2. It reads `PLEXUS_BASE_URL` / `PLEXUS_API_KEY` (or the stored options) and calls `/v1/models` on your Plexus instance.
3. The response is transformed into OpenCode's model schema and registered under the `plexus` provider.
4. The transformed list is cached in OpenCode's state directory (`~/.local/share/opencode/plugins/plexus/`).
5. On the next startup the cache is loaded synchronously before the live refresh completes, so the model picker is always populated.

> **Note:** `/v1/models` does not require an API key. The API key is only required for chat-completion requests. You can run the plugin without an API key if you only want to browse models.

---

## Model discovery details

| Plexus field | OpenCode model field |
|---|---|
| `id` | `id` (also dict key) |
| `name` | `name` |
| `context_length` / `top_provider.context_length` | `limit.context` |
| `top_provider.max_completion_tokens` | `limit.output` (fallback: `ceil(context × 0.2)`) |
| `pricing.prompt` / `.completion` | `cost.input` / `.output` (per-million tokens) |
| `pricing.input_cache_read` / `.input_cache_write` | `cost.cache_read` / `.cache_write` |
| `architecture.input_modalities` | `modalities.input` (`file` → `pdf`) |
| `architecture.output_modalities` | `modalities.output` |
| `output_modalities` present but does not include `text` | **model skipped** (filters image-generation, embedding, TTS, and other non-chat output types) |
| no `architecture` field and id matches `embedding`, `tts`, `whisper`, `image-*`, `dream`, etc. | **model skipped** (bare-stub non-chat models with no metadata) |
| `supported_parameters` includes `tools` | `tool_call: true` |
| `supported_parameters` includes `reasoning` / `include_reasoning` / `reasoning_effort` | `reasoning: true` |
| `supported_parameters` includes `temperature` | `temperature: true` |
| any non-text input modality | `attachment: true` |

---

## Multi-API escape hatch

By default this plugin uses `@ai-sdk/openai-compatible` (the OpenAI-compatible route) for all models. For Plexus-proxied models that use a different API wire format (e.g. Anthropic messages), add a **sibling provider** manually in your `opencode.json`:

```jsonc
{
  "provider": {
    "plexus": {
      // managed by this plugin — do not edit models here
    },
    "plexus-anthropic": {
      "npm": "@ai-sdk/anthropic",
      "options": {
        "baseURL": "https://plexus.example.com"
      },
      "models": {
        "claude-sonnet-4-6": {
          "name": "Claude Sonnet 4.6 (via Plexus, Anthropic wire)",
          "attachment": true,
          "reasoning": true,
          "tool_call": true,
          "cost": { "input": 3.0, "output": 15.0 },
          "limit": { "context": 1000000, "output": 128000 }
        }
      }
    }
  }
}
```

The `plexus` provider itself only manages the OpenAI-compatible route.

---

## Troubleshooting

**Models don't appear after setup**
- Check that `PLEXUS_BASE_URL` is set or that you completed `opencode auth login --provider plexus`.
- Verify reachability: `curl https://plexus.example.com/v1/models`.

**Cache location**
The model cache lives under OpenCode's own state directory:

```
~/.local/share/opencode/plugins/plexus/models-cache.json
~/.local/share/opencode/plugins/plexus/models-raw.json
```

Deleting OpenCode's state directory (the documented reset path) also clears this cache.

**API key vs base URL**
- `PLEXUS_API_KEY` (and the stored key) is used **only** for chat-completion requests.
- `/v1/models` is fetched without authentication, so the model picker works even if you haven't set an API key yet.
