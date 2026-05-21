# OpenCode Provider Plugin Specification

A detailed reference for implementing an OpenCode provider plugin, derived from analysis of the `opencode-kilo-auth` plugin and the `@opencode-ai/plugin` SDK types.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Plugin Entry Point](#2-plugin-entry-point)
3. [The `Hooks` Interface](#3-the-hooks-interface)
4. [The `AuthHook` (Required)](#4-the-authhook-required)
5. [Auth Method: OAuth (Device Flow)](#51-auth-method-oauth-device-flow)
6. [Auth Method: API Key](#52-auth-method-api-key)
7. [The `loader` Function (Required)](#6-the-loader-function-required)
8. [Model Definition Format](#7-model-definition-format)
9. [Optional Hooks](#8-optional-hooks)
10. [Package Configuration](#9-package-configuration)
11. [File Structure Reference](#10-file-structure-reference)
12. [End-to-End Flow](#11-end-to-end-flow)
13. [Implementation Checklist](#12-implementation-checklist)

---

## 1. Architecture Overview

An OpenCode provider plugin is an **ESM module** that exports a single default function of type `Plugin`. When OpenCode discovers and loads the plugin, it calls this function with a `PluginInput` context and receives a `Hooks` object in return. The hooks object is the plugin's contract with OpenCode — it declares what the plugin provides (auth, tools, event handlers, chat interceptors, etc.).

```
┌──────────────┐      PluginInput       ┌─────────────────┐
│   OpenCode   │ ─────────────────────▶ │  Provider Plugin │
│   Runtime    │                        │  (your code)     │
│              │ ◄───────────────────── │                  │
└──────────────┘       Hooks            └─────────────────┘
```

**Key principle:** The plugin does **not** register models or configure providers directly. Instead, it returns an `auth` hook that tells OpenCode *how* to authenticate with a named provider. OpenCode handles provider registration, model loading, and LLM routing based on the provider ID you declare.

---

## 2. Plugin Entry Point

### Type Signature

```typescript
type Plugin = (input: PluginInput) => Promise<Hooks>;
```

### `PluginInput` Fields

| Field | Type | Description |
|-------|------|-------------|
| `client` | `ReturnType<typeof createOpencodeClient>` | OpenCode API client for server communication |
| `project` | `Project` | Current project metadata |
| `directory` | `string` | Current working directory |
| `worktree` | `string` | Git worktree root |
| `serverUrl` | `URL` | URL of the local OpenCode server |
| `$` | `BunShell` | Shell execution utility |

### Minimal Skeleton

```typescript
import type { Hooks, PluginInput, Plugin as PluginInstance } from "@opencode-ai/plugin"

const MyProviderPlugin: PluginInstance = async (input: PluginInput): Promise<Hooks> => {
  return {
    auth: {
      provider: "my-provider",   // ← Must match the provider ID in OpenCode config
      loader: async (getAuth, providerInfo) => { /* ... */ },
      methods: [ /* ... */ ],
    },
  }
}

export default MyProviderPlugin
```

**Critical:** The `provider` string in the `auth` hook **must match** the key used in the user's `opencode.json` under `provider.<key>` (e.g., `"kilo"`, `"my-provider"`). This is how OpenCode routes auth requests to your plugin.

---

## 3. The `Hooks` Interface

The `Hooks` object is what your plugin function returns. Only `auth` is required for a provider plugin; all other hooks are optional.

```typescript
interface Hooks {
  auth?: AuthHook;                                    // ✅ Required for providers
  event?: (input: { event: Event }) => Promise<void>; // Optional event handling
  config?: (input: Config) => Promise<void>;           // Optional config hook
  tool?: { [key: string]: ToolDefinition };            // Optional custom tools
  "chat.message"?: (...) => Promise<void>;             // Optional message interceptor
  "chat.params"?: (...) => Promise<void>;              // Optional param modifier
  "chat.headers"?: (...) => Promise<void>;             // Optional header modifier
  // ... more optional hooks (see §8)
}
```

For a **provider plugin**, the only hook you must implement is `auth`.

---

## 4. The `AuthHook` (Required)

### Type Definition

```typescript
type AuthHook = {
  provider: string;
  loader?: (auth: () => Promise<Auth>, provider: Provider) => Promise<Record<string, any>>;
  methods: AuthMethod[];
};
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `provider` | `string` | ✅ Yes | Unique provider identifier. Must match the key in the user's `provider` config. |
| `loader` | `function` | ✅ Yes* | Called by OpenCode to get provider configuration (base URL, API key, headers). Returns an object consumed by the AI SDK provider. |
| `methods` | `AuthMethod[]` | ✅ Yes | Array of authentication methods the user can choose from. At least one is required. |

*\*Technically optional in the type, but a provider without a `loader` cannot function.*

### How OpenCode Uses the `AuthHook`

1. **Discovery:** OpenCode loads the plugin, calls the `Plugin` function, and inspects `hooks.auth.provider` to register a new provider.
2. **Authentication:** When the user selects "Connect provider" → your provider name, OpenCode presents the `methods` as choices. The user picks one, and the `authorize` function runs.
3. **Loading:** Every time OpenCode needs to call an LLM, it calls `loader(getAuth, providerInfo)` to get the configuration (API key, base URL, custom headers). The returned object is passed to the underlying AI SDK provider.

---

## 5. Auth Methods

### Available Method Types

Each method can be either `"oauth"` or `"api"`. Both support optional `prompts` for interactive input.

---

### 5.1 Auth Method: OAuth (Device Flow)

```typescript
{
  type: "oauth";
  label: string;                                           // Display name in the UI
  prompts?: PromptDefinition[];                            // Optional interactive prompts
  authorize(inputs?: Record<string, string>): Promise<AuthOuathResult>;
}
```

#### `AuthOuathResult` — Return Type

The `authorize` function must return an `AuthOuathResult`, which tells OpenCode how to complete the auth flow:

```typescript
type AuthOuathResult = {
  url: string;           // The URL to show/navigate to
  instructions: string;  // Human-readable instructions displayed in the TUI
} & (
  | {
      method: "auto";    // Automatic polling — OpenCode calls callback() with no args
      callback(): Promise<AuthSuccess | AuthFailed>;
    }
  | {
      method: "code";    // Code exchange — OpenCode passes the OAuth code to callback()
      callback(code: string): Promise<AuthSuccess | AuthFailed>;
    }
);
```

#### `AuthSuccess` (OAuth variant)

When the callback resolves successfully, it must return:

```typescript
{
  type: "success";
  provider?: string;      // Provider ID (defaults to the auth hook's provider)
}
& (
  | {
      refresh: string;    // Refresh token for re-authentication
      access: string;     // Access token for API calls
      expires: number;    // Expiration timestamp in ms since epoch
      accountId?: string; // Optional account/org identifier
    }
  | {
      key: string;        // API key derived from the OAuth flow
    }
)
```

#### `AuthFailed`

```typescript
{
  type: "failed";
}
```

#### Device Flow Pattern (as used by Kilo)

The Kilo plugin implements a device authorization flow:

1. **`authorize()`** initiates the flow by:
   - Calling the provider's device code endpoint to get a `code` and `verificationUrl`
   - Opening the verification URL in the user's browser (`open(verificationUrl)`)
   - Returning an `AuthOuathResult` with `method: "auto"` and a `callback` function

2. **The `callback()`** polls the provider's token endpoint:
   - Returns `{ continue: true }` while the user hasn't approved yet
   - Returns `{ continue: false, data: ... }` when approved
   - Returns `{ continue: false, error: ... }` on denial/expiration
   - On success, returns `{ type: "success", access, refresh, expires, provider }`

#### Full OAuth Method Example

```typescript
{
  type: "oauth",
  label: "My Provider (Device Authorization)",
  async authorize() {
    // Step 1: Get device code from your API
    const authData = await initiateDeviceAuth()
    
    // Step 2: Open browser for user approval
    await open(authData.verificationUrl).catch(() => {})
    
    // Step 3: Return instructions + auto-polling callback
    return {
      url: authData.verificationUrl,
      instructions: `Open ${authData.verificationUrl} and enter code: ${authData.code}`,
      method: "auto",
      async callback() {
        // Poll until approved, denied, or expired
        const result = await pollForApproval(authData.code)
        
        if (!result.token) {
          return { type: "failed" }
        }
        
        return {
          type: "success",
          provider: "my-provider",
          refresh: result.token,
          access: result.token,
          expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
        }
      },
    }
  },
}
```

---

### 5.2 Auth Method: API Key

```typescript
{
  type: "api";
  label: string;                                           // Display name
  prompts?: PromptDefinition[];                            // Optional interactive prompts
  authorize?(inputs?: Record<string, string>): Promise<ApiAuthSuccess | AuthFailed>;
}
```

#### `ApiAuthSuccess`

```typescript
{
  type: "success";
  key: string;           // The API key
  provider?: string;      // Optional provider ID override
}
```

This method is simpler — the user provides a key (possibly via prompts) and the `authorize` function returns it directly.

#### API Key Method Example (from Kilo)

```typescript
{
  type: "api",
  label: "My Provider (API Key)",
  async authorize(inputs) {
    const key = inputs?.apiKey
    if (!key) {
      return { type: "failed" }
    }
    return {
      type: "success",
      provider: "my-provider",
      key,
    }
  },
}
```

---

### 5.3 Prompt Definitions (Optional)

Both method types support `prompts` — interactive UI elements shown to the user before `authorize` is called. The user's responses are passed as the `inputs` argument to `authorize`.

#### Text Prompt

```typescript
{
  type: "text";
  key: string;               // Key in the `inputs` record
  message: string;           // Label shown to the user
  placeholder?: string;      // Placeholder text
  validate?: (value: string) => string | undefined;  // Return error string if invalid
  condition?: (inputs: Record<string, string>) => boolean;  // Show only if condition met
}
```

#### Select Prompt

```typescript
{
  type: "select";
  key: string;               // Key in the `inputs` record
  message: string;           // Label shown to the user
  options: Array<{
    label: string;           // Display label
    value: string;           // Selected value
    hint?: string;           // Optional hint text
  }>;
  condition?: (inputs: Record<string, string>) => boolean;  // Show only if condition met
}
```

#### Prompt Example

```typescript
{
  type: "api",
  label: "My Provider (API Key)",
  prompts: [
    {
      type: "text",
      key: "apiKey",
      message: "Enter your API key",
      placeholder: "sk-...",
      validate: (value) => {
        if (!value.startsWith("sk-")) return "Key must start with sk-"
        return undefined
      },
    },
    {
      type: "select",
      key: "region",
      message: "Select region",
      options: [
        { label: "US East", value: "us-east", hint: "Default" },
        { label: "EU West", value: "eu-west" },
      ],
    },
  ],
  async authorize(inputs) {
    const key = inputs?.apiKey
    const region = inputs?.region
    if (!key) return { type: "failed" }
    return { type: "success", provider: "my-provider", key }
  },
}
```

---

## 6. The `loader` Function (Required)

### Signature

```typescript
loader: (getAuth: () => Promise<Auth>, providerInfo: Provider) => Promise<Record<string, any>>
```

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `getAuth` | `() => Promise<Auth>` | Async function that returns the stored authentication credentials. May return `undefined` if the user hasn't authenticated yet. |
| `providerInfo` | `Provider` | OpenCode's `Provider` object containing id, name, source, env vars, key, options, and models. |

### `Auth` Union Type (returned by `getAuth()`)

```typescript
type Auth = OAuth | ApiAuth | WellKnownAuth;

type OAuth = {
  type: "oauth";
  refresh: string;
  access: string;
  expires: number;
  enterpriseUrl?: string;
};

type ApiAuth = {
  type: "api";
  key: string;
};

type WellKnownAuth = {
  type: "wellknown";
  key: string;
  token: string;
};
```

### What the Loader Returns

The loader must return a plain object (`Record<string, any>`) that will be **spread into** the AI SDK provider constructor options. The specific fields depend on which AI SDK provider you use, but the common ones are:

| Field | Type | Description |
|-------|------|-------------|
| `apiKey` | `string` | API key or access token for authentication |
| `baseURL` | `string` | Base URL of the API endpoint |
| `headers` | `Record<string, string>` | Custom HTTP headers for every request |
| `fetch` | `typeof fetch` | Custom fetch implementation (for header injection, etc.) |

### Loader Behavior by Auth State

Your loader must handle three scenarios:

1. **No auth** (`getAuth()` returns `undefined`) — return base config that works anonymously or returns an error
2. **API key auth** (`auth.type === "api"`) — set `apiKey` from `auth.key`
3. **OAuth auth** (`auth.type === "oauth"`) — set `apiKey` from `auth.access`, potentially modify `baseURL` based on account info

### Loader Example (from Kilo)

```typescript
async loader(getAuth, providerInfo) {
  const auth = await getAuth()

  // Base options that apply regardless of auth state
  const baseOptions = {
    baseURL: "https://api.myprovider.com/v1",
    headers: {
      "HTTP-Referer": "https://myprovider.com",
      "X-Title": "My Provider",
    },
  }

  // No auth — return base options (may or may not work depending on API)
  if (!auth) {
    return baseOptions
  }

  // API key auth
  if (auth.type === "api") {
    return {
      ...baseOptions,
      apiKey: auth.key,
    }
  }

  // OAuth auth — use access token, optional org-scoped URL
  if (auth.type === "oauth") {
    const result: Record<string, any> = {
      ...baseOptions,
      apiKey: auth.access,
    }
    const maybeAccountId = (auth as any).accountId
    if (maybeAccountId) {
      result.baseURL = `https://api.myprovider.com/orgs/${maybeAccountId}`
    }
    return result
  }

  return baseOptions
}
```

### Important: How `baseURL` is Used

OpenCode uses **AI SDK providers** (e.g., `@openrouter/ai-sdk-provider`, `@ai-sdk/openai`, etc.) under the hood. When your `loader` returns `{ baseURL, apiKey, headers }`, OpenCode passes these to the provider constructor:

- OpenRouter-compatible: `createOpenRouter({ baseURL, apiKey, headers, fetch })`
- OpenAI-compatible: `createOpenAI({ baseURL, apiKey, headers, fetch })`

Choose the AI SDK provider that matches your backend API's compatibility.

---

## 7. Model Definition Format

Models are declared in the user's **`opencode.json`** config file under `provider.<id>.models`. A provider plugin does **not** directly register models — instead, it provides auth, and the user (or a default config) defines which models are available.

However, your plugin's documentation should clearly specify the expected model format so users can configure their `opencode.json` correctly.

### Model Schema (from `ProviderConfig`)

```typescript
{
  [modelId: string]: {
    id?: string;                         // Model identifier (defaults to key)
    name?: string;                       // Human-readable name
    release_date?: string;               // ISO date string
    attachment?: boolean;                // Supports image/file attachments
    reasoning?: boolean;                 // Supports reasoning/extended thinking
    temperature?: boolean;               // Supports temperature parameter
    tool_call?: boolean;                 // Supports tool/function calling
    cost?: {
      input: number;                     // Cost per million input tokens
      output: number;                    // Cost per million output tokens
      cache_read?: number;               // Cost per million cached read tokens
      cache_write?: number;              // Cost per million cached write tokens
      context_over_200k?: { ... };       // Pricing tier for >200k context
    };
    limit?: {
      context: number;                  // Max context window in tokens
      output: number;                   // Max output tokens
    };
    modalities?: {
      input: Array<"text" | "audio" | "image" | "video" | "pdf">;
      output: Array<"text" | "audio" | "image" | "video" | "pdf">;
    };
    experimental?: boolean;              // Mark as experimental
    status?: "alpha" | "beta" | "deprecated";  // Lifecycle status
    options?: Record<string, unknown>;    // Provider-specific options
    headers?: Record<string, string>;     // Per-model custom headers
    provider?: {
      npm: string;                       // NPM package providing this model
    };
  }
}
```

### Example Model Entry in `opencode.json`

```json
{
  "provider": {
    "my-provider": {
      "api": "openrouter",
      "models": {
        "anthropic/claude-sonnet-4": {
          "name": "Claude Sonnet 4",
          "attachment": true,
          "reasoning": true,
          "temperature": true,
          "tool_call": true,
          "cost": { "input": 3.0, "output": 15.0 },
          "limit": { "context": 200000, "output": 8192 },
          "modalities": {
            "input": ["text", "image", "pdf"],
            "output": ["text"]
          }
        }
      }
    }
  }
}
```

### Transforming API Model Data to OpenCode Format

If your provider has a `/models` API endpoint (like OpenRouter), you'll need to transform the API response into the format above. The Kilo plugin does this in `models.ts`:

| OpenRouter/API Field | OpenCode Model Field | Notes |
|---------------------|---------------------|-------|
| `id` | `id` | Direct mapping |
| `name` | `name` | Direct mapping |
| `context_length` | `limit.context` | Token count |
| `max_completion_tokens` | `limit.output` | Fallback: `ceil(context * 0.2)` |
| `pricing.prompt` | `cost.input` | Parse from string, per-million tokens |
| `pricing.completion` | `cost.output` | Parse from string |
| `architecture.input_modalities` | `modalities.input` | Map to `"text"\|"audio"\|"image"\|"video"\|"pdf"` |
| `architecture.output_modalities` | `modalities.output` | Skip models with image output |
| `supported_parameters` includes `"tools"` | `tool_call: true` | |
| `supported_parameters` includes `"reasoning"` | `reasoning: true` | |
| `supported_parameters` includes `"temperature"` | `temperature: true` | |
| `input_modalities` includes `"image"` | `attachment: true` | |

⚠️ **Image output models should be filtered out** — OpenCode doesn't support image-generating models as chat providers.

---

## 8. Optional Hooks

The `Hooks` interface supports many optional hooks beyond `auth`. Most provider plugins won't need these, but they're available for advanced customization.

### 8.1 Event Hook

```typescript
event?: (input: { event: Event }) => Promise<void>;
```

Receives all OpenCode events. Use for logging, analytics, or reacting to state changes.

### 8.2 Config Hook

```typescript
config?: (input: Config) => Promise<void>;
```

Called when the configuration is loaded. Use to validate or react to config changes.

### 8.3 Tool Hook

```typescript
tool?: { [key: string]: ToolDefinition };
```

Register custom tools that the LLM can invoke. See `@opencode-ai/plugin` `tool()` factory.

### 8.4 Chat Hooks

```typescript
// Intercept incoming messages
"chat.message"?: (input: { sessionID, agent?, model?, messageID?, variant? },
                   output: { message, parts }) => Promise<void>;

// Modify LLM parameters before sending
"chat.params"?: (input: { sessionID, agent, model, provider, message },
                  output: { temperature, topP, topK, options }) => Promise<void>;

// Add custom headers to LLM requests
"chat.headers"?: (input: { sessionID, agent, model, provider, message },
                   output: { headers }) => Promise<void>;
```

The `chat.headers` hook is especially useful for providers that need per-request headers (e.g., organization IDs, request tracing).

### 8.5 Permission Hook

```typescript
"permission.ask"?: (input: Permission, output: { status: "ask" | "deny" | "allow" }) => Promise<void>;
```

Customize permission prompts. You can auto-allow or auto-deny specific tool permissions.

### 8.6 Shell/Command Hooks

```typescript
"command.execute.before"?: (input: { command, sessionID, arguments },
                             output: { parts }) => Promise<void>;

"tool.execute.before"?: (input: { tool, sessionID, callID },
                          output: { args }) => Promise<void>;

"tool.execute.after"?: (input: { tool, sessionID, callID, args },
                         output: { title, output, metadata }) => Promise<void>;

"shell.env"?: (input: { cwd }, output: { env }) => Promise<void>;
```

### 8.7 Experimental Hooks

```typescript
"experimental.chat.messages.transform"?: (input: {},
  output: { messages: { info, parts }[] }) => Promise<void>;

"experimental.chat.system.transform"?: (input: { sessionID?, model },
  output: { system: string[] }) => Promise<void>;

"experimental.session.compacting"?: (input: { sessionID },
  output: { context: string[], prompt?: string }) => Promise<void>;

"experimental.text.complete"?: (input: { sessionID, messageID, partID },
  output: { text }) => Promise<void>;

"tool.definition"?: (input: { toolID },
  output: { description, parameters }) => Promise<void>;
```

---

## 9. Package Configuration

### `package.json` Requirements

```json
{
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  }
}
```

### Required Dependencies

| Package | Purpose |
|---------|---------|
| `@opencode-ai/plugin` | Plugin interface types (`Hooks`, `PluginInput`, `AuthHook`, etc.) |
| `ai` | Vercel AI SDK — base types for model providers |

### Recommended Dependencies (based on your API)

| Package | When to Use |
|---------|-------------|
| `@openrouter/ai-sdk-provider` | Your API is OpenRouter-compatible |
| `@ai-sdk/openai` | Your API is OpenAI-compatible |
| `open` | You need to open URLs in the browser (OAuth flows) |
| `zod` | Schema validation (e.g., validating API responses) |

### Build Setup

```json
{
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit"
  }
}
```

### `tsconfig.json` Key Settings

```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "declaration": true,
    "outDir": "./dist",
    "rootDir": "./src"
  }
}
```

---

## 10. File Structure Reference

### Minimal Provider (API Key Only)

```
src/
├── index.ts        # Plugin entry point with auth hook (loader + API key method)
├── constants.ts    # API URLs and configuration
└── types.ts        # TypeScript interfaces
```

### Full Provider (OAuth + API Key + Model Fetching)

```
src/
├── index.ts        # Plugin entry point — defines auth hook with all methods
├── auth.ts         # Device authorization / OAuth flow implementation
├── constants.ts    # API URLs, polling intervals, default values
├── models.ts       # Fetch and transform models from provider API
├── polling.ts      # Generic polling utility for async flows
├── provider.ts     # AI SDK provider factory (createProvider)
└── types.ts        # Shared TypeScript interfaces
```

### File Responsibilities

| File | Responsibility |
|------|---------------|
| `index.ts` | Plugin definition; the `Plugin` function returning `Hooks`; wires everything together |
| `auth.ts` | Device/OAuth flow: request code → open browser → poll for token → return `AuthOuathResult` |
| `constants.ts` | All configuration values (API URLs, intervals, default models, headers) |
| `models.ts` | HTTP fetch to provider's `/models` endpoint; transforms response to OpenCode model format |
| `polling.ts` | Generic `poll<T>()` utility with interval, maxAttempts, and continue/error semantics |
| `provider.ts` | Creates the AI SDK provider instance (e.g., `createOpenRouter()`) with custom fetch/headers |
| `types.ts` | Shared interfaces: `DeviceAuthInitiateResponse`, `PollOptions`, `ProviderOptions`, etc. |

---

## 11. End-to-End Flow

### Authentication Flow (OAuth Device)

```
User                        OpenCode TUI              Plugin                          Provider API
  │                              │                       │                                │
  │  "Connect provider"          │                       │                                │
  │─────────────────────────────▶│                       │                                │
  │                              │  Show methods list    │                                │
  │  Select "Device Auth"        │                       │                                │
  │─────────────────────────────▶│  call authorize()     │                                │
  │                              │──────────────────────▶│  POST /device-auth/codes       │
  │                              │                       │───────────────────────────────▶│
  │                              │                       │◀───────────────────────────────│
  │                              │                       │  { code, verificationUrl }     │
  │                              │                       │  open(verificationUrl)          │
  │                              │  Display instructions │                                │
  │◀─────────────────────────────│◀──────────────────────│                                │
  │  "Open URL and enter code"   │                       │                                │
  │                              │                       │                                │
  │  (User authorizes in         │                       │  callback() polls              │
  │   browser)                   │                       │───────────────────────────────▶│
  │                              │                       │  GET /device-auth/codes/{code} │
  │                              │                       │◀───────────────────────────────│
  │                              │                       │  { status: "pending" }         │
  │                              │                       │  ...repeats polling...          │
  │                              │                       │───────────────────────────────▶│
  │                              │                       │  GET /device-auth/codes/{code} │
  │                              │                       │◀───────────────────────────────│
  │                              │                       │  { status: "approved",         │
  │                              │                       │    token: "..." }              │
  │                              │  Auth stored          │                                │
  │                              │◀──────────────────────│  return { type:"success",      │
  │                              │                       │    access, refresh, expires }  │
  │  "Connected!"                │                       │                                │
  │◀─────────────────────────────│                       │                                │
```

### Request Flow (Chat Completion)

```
User                   OpenCode Runtime                         Plugin                        Provider API
  │                          │                                      │                              │
  │  Send message            │                                      │                              │
  │────────────────────────▶│  call loader(getAuth, providerInfo)  │                              │
  │                          │─────────────────────────────────────▶│                              │
  │                          │                                      │  resolve auth credentials     │
  │                          │◀─────────────────────────────────────│                              │
  │                          │  { baseURL, apiKey, headers }        │                              │
  │                          │                                      │                              │
  │                          │  Create AI SDK provider with config  │                              │
  │                          │  Call LLM with provider.instance()   │                              │
  │                          │────────────────────────────────────────────────────────────────────▶│
  │                          │◀────────────────────────────────────────────────────────────────────│
  │                          │  Stream response                    │                              │
  │◀─────────────────────────│                                      │                              │
```

---

## 12. Implementation Checklist

Use this checklist when building a new provider plugin:

### Setup
- [ ] Create project with `package.json` (ESM, `"type": "module"`)
- [ ] Add `@opencode-ai/plugin` as a dependency
- [ ] Add the appropriate AI SDK provider package (e.g., `@openrouter/ai-sdk-provider` or `@ai-sdk/openai`)
- [ ] Configure `tsconfig.json` with strict mode and ESNext target
- [ ] Create `src/` directory structure

### Core Implementation
- [ ] **`src/types.ts`** — Define provider-specific interfaces (auth responses, provider options, etc.)
- [ ] **`src/constants.ts`** — Define API base URLs, polling intervals, default headers, env variable names
- [ ] **`src/index.ts`** — Implement the `Plugin` function returning `Hooks`
  - [ ] Set `auth.provider` to your unique provider ID
  - [ ] Implement `auth.loader` that handles all three auth states (none, api, oauth)
  - [ ] Add at least one auth method to `auth.methods`

### Auth Implementation
- [ ] **API Key method** — Simple key input → `{ type: "success", key }`
- [ ] **OAuth method** (if needed):
  - [ ] Implement device code initiation (HTTP POST to your API)
  - [ ] Implement token polling (HTTP GET with status checks)
  - [ ] Handle `pending`, `approved`, `denied`, `expired` states
  - [ ] Return `AuthOuathResult` with `method: "auto"` and polling `callback`
  - [ ] Optionally open browser with the `open` package

### Loader Implementation
- [ ] Handle `auth === undefined` (no auth / anonymous)
- [ ] Handle `auth.type === "api"` → set `apiKey: auth.key`
- [ ] Handle `auth.type === "oauth"` → set `apiKey: auth.access`, consider `accountId` for org-scoped URLs
- [ ] Set `baseURL` to your API endpoint
- [ ] Set required `headers` (User-Agent, Content-Type, Referer, etc.)

### Model Support
- [ ] Document the model format for your provider in README
- [ ] Optionally implement a `models.ts` to fetch and transform model data from your API
- [ ] Optionally include a `scripts/fetch-models.ts` for generating a static `models.json`
- [ ] Filter out image-generation models (set `output_modalities` includes `"image"`)

### Build & Test
- [ ] `bun install` succeeds
- [ ] `bun run typecheck` passes
- [ ] `bun run build` produces `dist/index.js`
- [ ] Test in OpenCode TUI: select provider → authenticate → send a message

### Documentation
- [ ] `README.md` with installation instructions and `opencode.json` config examples
- [ ] Document all supported auth methods
- [ ] Document required env variables (if any)
- [ ] Document available models or how to discover them

---

## Appendix A: Quick-Reference Type Summary

```
Plugin          = (input: PluginInput) => Promise<Hooks>
PluginInput     = { client, project, directory, worktree, serverUrl, $ }
Hooks           = { auth?: AuthHook, event?, config?, tool?, "chat.message"?, ... }

AuthHook        = { provider: string, loader?: LoaderFn, methods: AuthMethod[] }
LoaderFn        = (getAuth: () => Promise<Auth>, providerInfo: Provider) => Promise<Record<string,any>>
Auth            = OAuth | ApiAuth | WellKnownAuth
OAuth           = { type: "oauth", refresh, access, expires, enterpriseUrl? }
ApiAuth         = { type: "api", key }
WellKnownAuth   = { type: "wellknown", key, token }

AuthMethod      = OAuthMethod | ApiMethod
OAuthMethod     = { type: "oauth", label, prompts?, authorize(inputs?) => AuthOuathResult }
ApiMethod       = { type: "api", label, prompts?, authorize?(inputs?) => ApiAuthResult }

AuthOuathResult = { url, instructions } & ({ method: "auto", callback() } | { method: "code", callback(code) })
AuthSuccess     = { type: "success", provider? } & ({ refresh, access, expires, accountId? } | { key })
AuthFailed      = { type: "failed" }

Provider        = { id, name, source, env, key?, options, models }
Model           = { id, providerID, api, name, capabilities, cost, limit, status, options, headers }
```

## Appendix B: Kilo Plugin as a Worked Example

| Component | File | Key Implementation |
|-----------|------|-------------------|
| Plugin entry | `src/index.ts` | `KiloGatewayPlugin` async function returning `{ auth: { provider: "kilo", loader, methods } }` |
| OAuth flow | `src/auth.ts` | `authenticateWithDeviceAuthTUI()` — initiates device code, opens browser, returns auto-polling callback |
| API key | `src/index.ts` | Inline `authorize(inputs)` — reads `inputs.apiKey`, returns `{ type: "success", key }` |
| Loader | `src/index.ts` | Handles `undefined` / `api` / `oauth` auth states; sets `baseURL`, `apiKey`, custom headers |
| Provider factory | `src/provider.ts` | `createKilo()` — wraps `createOpenRouter()` with custom fetch for header injection |
| Model fetching | `src/models.ts` | `fetchKiloModels()` — fetches from OpenRouter `/models`, validates with Zod, transforms format |
| Polling utility | `src/polling.ts` | `poll<T>()` — generic async poller with interval/maxAttempts |
| Constants | `src/constants.ts` | All URLs, intervals, header names, env var keys |
| Types | `src/types.ts` | DeviceAuth responses, poll options, provider options, metadata |
