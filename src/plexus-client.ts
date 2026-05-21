import { z } from "zod"
import { MODELS_FETCH_TIMEOUT_MS } from "./constants"
import type { PlexusApiModel, PlexusApiResponse } from "./types"
import { modelsUrl } from "./url"

// ---------------------------------------------------------------------------
// Zod schemas for runtime validation
// ---------------------------------------------------------------------------

const PlexusModelArchitectureSchema = z
  .object({
    modality: z.string().optional(),
    input_modalities: z.array(z.string()).optional(),
    output_modalities: z.array(z.string()).optional(),
    tokenizer: z.string().optional(),
    instruct_type: z.string().nullable().optional(),
  })
  .passthrough()

const PlexusModelPricingSchema = z
  .object({
    prompt: z.string().optional(),
    completion: z.string().optional(),
    input_cache_read: z.string().optional(),
    input_cache_write: z.string().optional(),
  })
  .passthrough()

const PlexusTopProviderSchema = z
  .object({
    context_length: z.number().nullable().optional(),
    max_completion_tokens: z.number().nullable().optional(),
    is_moderated: z.boolean().optional(),
  })
  .passthrough()

const PlexusApiModelSchema = z
  .object({
    id: z.string(),
    object: z.string().optional(),
    created: z.number().optional(),
    owned_by: z.string().optional(),
    preferred_api: z.union([z.string(), z.array(z.string())]).optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    context_length: z.number().nullable().optional(),
    architecture: PlexusModelArchitectureSchema.optional(),
    pricing: PlexusModelPricingSchema.optional(),
    supported_parameters: z.array(z.string()).optional(),
    top_provider: PlexusTopProviderSchema.optional(),
    pi_provider: z.string().optional(),
    pi_model: z.string().optional(),
  })
  .passthrough()

const PlexusApiResponseSchema = z.object({
  object: z.string(),
  data: z.array(PlexusApiModelSchema),
})

// ---------------------------------------------------------------------------
// Fetch function
// ---------------------------------------------------------------------------

/**
 * Fetch the list of models from a Plexus `/v1/models` endpoint.
 *
 * `apiKey` is optional — Plexus's model list does not require auth.
 * Throws on HTTP errors or validation failures so the caller can decide
 * how to fall back.
 */
export async function fetchPlexusModels(
  baseURL: string,
  apiKey?: string,
): Promise<{ models: PlexusApiModel[]; raw: PlexusApiResponse }> {
  const url = modelsUrl(baseURL)
  if (!url) throw new Error("Plexus: cannot build models URL from an empty baseURL")

  const headers: Record<string, string> = {
    Accept: "application/json",
  }
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`
  }

  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS),
  })

  if (!response.ok) {
    throw new Error(`Plexus models fetch failed: HTTP ${response.status} ${response.statusText} (${url})`)
  }

  const json: unknown = await response.json()
  const parsed = PlexusApiResponseSchema.safeParse(json)
  if (!parsed.success) {
    throw new Error(`Plexus models response did not match expected schema: ${parsed.error.message}`)
  }

  // Cast via unknown — zod .passthrough() gives us compatible shapes
  const raw = parsed.data as unknown as PlexusApiResponse
  return { models: raw.data ?? [], raw }
}
