import { DEFAULT_CONTEXT } from "./constants"
import type { PlexusApiModel } from "./types"

type Modality = "text" | "audio" | "image" | "video" | "pdf"

/** Subset of ProviderConfig.models value that we build */
export interface ConfigModel {
  id: string
  name: string
  attachment?: boolean
  reasoning?: boolean
  temperature?: boolean
  tool_call?: boolean
  cost?: {
    input: number
    output: number
    cache_read?: number
    cache_write?: number
  }
  limit: {
    context: number
    output: number
  }
  modalities: {
    input: Modality[]
    output: Modality[]
  }
}

const REASONING_PARAMS = new Set(["reasoning", "include_reasoning", "reasoning_effort"])

function parsePrice(value: string | undefined): number {
  if (!value) return 0
  const n = parseFloat(value)
  return Number.isNaN(n) ? 0 : n
}

/**
 * Map a single Plexus modality string to an OpenCode Modality string.
 * "file" → "pdf"; unknown strings are dropped.
 */
function mapModality(m: string): Modality | null {
  switch (m) {
    case "text":
      return "text"
    case "image":
      return "image"
    case "audio":
      return "audio"
    case "video":
      return "video"
    case "file":
    case "pdf":
      return "pdf"
    default:
      return null
  }
}

function buildInputModalities(model: PlexusApiModel): Modality[] {
  const raw = model.architecture?.input_modalities ?? []
  const mapped = raw.map(mapModality).filter((m): m is Modality => m !== null)
  return mapped.length > 0 ? [...new Set(mapped)] : ["text"]
}

// Patterns that identify non-chat models when no architecture metadata is present.
// Matches: embedding, embeddings, tts, whisper, image-gen names, etc.
const NON_CHAT_ID_PATTERN = /embedding|embed|tts|whisper|image-[0-9]|image\b.*gen|diffusion|dall-e|stable-diff|sdxl|dream/i

function buildOutputModalities(model: PlexusApiModel): Modality[] | null {
  const raw = model.architecture?.output_modalities

  if (raw !== undefined) {
    // Architecture is present — require text output. Filters embedding ([]),
    // image-only (['image']), and any other non-chat output types.
    if (!raw.includes("text")) return null
    const mapped = raw.map(mapModality).filter((m): m is Modality => m !== null)
    return mapped.length > 0 ? [...new Set(mapped)] : ["text"]
  }

  // No architecture at all — use id heuristics to catch bare stubs like
  // text-embedding-3-small, seedream-5-lite, gpt-4o-mini-tts, whisper-large-v3.
  if (NON_CHAT_ID_PATTERN.test(model.id)) return null

  // No architecture but name looks like a chat model — assume text output.
  return ["text"]
}

/**
 * Transform a list of PlexusApiModel objects into the dict of ConfigModel
 * objects expected by OpenCode's `cfg.provider.plexus.models`.
 *
 * Image-output models are filtered out — OpenCode does not support
 * image-generating models as chat providers.
 */
export function buildModels(models: PlexusApiModel[]): Record<string, ConfigModel> {
  const result: Record<string, ConfigModel> = {}

  for (const m of models) {
    if (!m.id) continue

    const outputModalities = buildOutputModalities(m)
    if (outputModalities === null) continue // image-output: skip

    const inputModalities = buildInputModalities(m)
    const params = m.supported_parameters ?? []

    const contextLength =
      (typeof m.context_length === "number" && m.context_length > 0 ? m.context_length : undefined) ??
      (typeof m.top_provider?.context_length === "number" && m.top_provider.context_length > 0
        ? m.top_provider.context_length
        : undefined) ??
      DEFAULT_CONTEXT

    const maxOutput =
      (typeof m.top_provider?.max_completion_tokens === "number" && m.top_provider.max_completion_tokens > 0
        ? m.top_provider.max_completion_tokens
        : undefined) ?? Math.ceil(contextLength * 0.2)

    const promptPrice = parsePrice(m.pricing?.prompt)
    const completionPrice = parsePrice(m.pricing?.completion)
    const cacheReadPrice = parsePrice(m.pricing?.input_cache_read)
    const cacheWritePrice = parsePrice(m.pricing?.input_cache_write)

    const hasCachePricing = cacheReadPrice > 0 || cacheWritePrice > 0

    // attachment = true if any non-text input modality is present
    const hasNonTextInput = inputModalities.some((mod) => mod !== "text")

    const entry: ConfigModel = {
      id: m.id,
      name: m.name ?? m.id,
      limit: {
        context: contextLength,
        output: maxOutput,
      },
      modalities: {
        input: inputModalities,
        output: outputModalities,
      },
      ...(promptPrice > 0 || completionPrice > 0
        ? {
            cost: {
              input: promptPrice,
              output: completionPrice,
              ...(hasCachePricing
                ? { cache_read: cacheReadPrice, cache_write: cacheWritePrice }
                : {}),
            },
          }
        : {}),
      ...(params.includes("tools") ? { tool_call: true } : {}),
      ...(params.some((p) => REASONING_PARAMS.has(p)) ? { reasoning: true } : {}),
      ...(params.includes("temperature") ? { temperature: true } : {}),
      ...(hasNonTextInput ? { attachment: true } : {}),
    }

    result[m.id] = entry
  }

  return result
}
