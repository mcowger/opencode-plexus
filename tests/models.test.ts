import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { buildModels } from "../src/models"
import type { PlexusApiResponse } from "../src/types"

// Load the real Plexus models fixture from the pi-plexus repo
const MODELS_FIXTURE_PATH = join(
  import.meta.dir,
  "../../pi-plexus/models.json",
)
const fixtureRaw = readFileSync(MODELS_FIXTURE_PATH, "utf8")
const fixture = JSON.parse(fixtureRaw) as PlexusApiResponse

describe("buildModels", () => {
  const result = buildModels(fixture.data)

  test("returns an object keyed by model id", () => {
    expect(typeof result).toBe("object")
    expect(Object.keys(result).length).toBeGreaterThan(0)
  })

  test("all keys match their entry's id field", () => {
    for (const [key, model] of Object.entries(result)) {
      expect(model.id).toBe(key)
    }
  })

  test("filters out image-output models", () => {
    // The fixture has 0 image-output models, but ensure the filter path is exercised
    const fakeImageModel = {
      id: "fake-image-gen",
      architecture: { output_modalities: ["image"] },
    }
    const filtered = buildModels([...fixture.data, fakeImageModel])
    expect(filtered["fake-image-gen"]).toBeUndefined()
  })

  test("all models have required fields", () => {
    for (const model of Object.values(result)) {
      expect(typeof model.id).toBe("string")
      expect(model.id.length).toBeGreaterThan(0)
      expect(typeof model.name).toBe("string")
      expect(typeof model.limit.context).toBe("number")
      expect(model.limit.context).toBeGreaterThan(0)
      expect(typeof model.limit.output).toBe("number")
      expect(model.limit.output).toBeGreaterThan(0)
      expect(Array.isArray(model.modalities.input)).toBe(true)
      expect(Array.isArray(model.modalities.output)).toBe(true)
    }
  })

  test("sets tool_call: true for models with 'tools' in supported_parameters", () => {
    // claude-sonnet-4-6 has 'tools'
    const claude = result["claude-sonnet-4-6"]
    expect(claude).toBeDefined()
    expect(claude?.tool_call).toBe(true)
  })

  test("sets reasoning: true for models with reasoning parameters", () => {
    // minimax-m2.7 has 'reasoning' in supported_parameters
    const minimax = result["minimax-m2.7"]
    expect(minimax).toBeDefined()
    expect(minimax?.reasoning).toBe(true)

    // claude-sonnet-4-6 has 'include_reasoning'
    const claude = result["claude-sonnet-4-6"]
    expect(claude?.reasoning).toBe(true)
  })

  test("sets temperature: true for models with 'temperature' in supported_parameters", () => {
    const minimax = result["minimax-m2.7"]
    expect(minimax?.temperature).toBe(true)
  })

  test("sets attachment: true for models with non-text input modalities", () => {
    // claude-sonnet-4-6 has 'image' and 'file' in input_modalities
    const claude = result["claude-sonnet-4-6"]
    expect(claude?.attachment).toBe(true)
  })

  test("does NOT set attachment for text-only models", () => {
    // minimax-m2.7 has only 'text' input modalities
    const minimax = result["minimax-m2.7"]
    expect(minimax?.attachment).toBeUndefined()
  })

  test("maps 'file' input modality to 'pdf'", () => {
    // claude-sonnet-4-6 has 'file' in input_modalities → should become 'pdf'
    const claude = result["claude-sonnet-4-6"]
    expect(claude?.modalities.input).toContain("pdf")
  })

  test("limit.context from context_length field", () => {
    const minimax = result["minimax-m2.7"]
    expect(minimax?.limit.context).toBe(196608)
  })

  test("limit.output from top_provider.max_completion_tokens", () => {
    const minimax = result["minimax-m2.7"]
    expect(minimax?.limit.output).toBe(131072)
  })

  test("per-million price passthrough: '3.0' string → cost.input === 3.0", () => {
    const priceModel = buildModels([
      {
        id: "test-model",
        context_length: 8192,
        supported_parameters: [],
        pricing: {
          prompt: "3.0",
          completion: "15.0",
          input_cache_read: "0.3",
          input_cache_write: "0.75",
        },
        top_provider: { context_length: 8192, max_completion_tokens: 1024 },
      },
    ])
    const m = priceModel["test-model"]
    expect(m?.cost?.input).toBe(3.0)
    expect(m?.cost?.output).toBe(15.0)
    expect(m?.cost?.cache_read).toBe(0.3)
    expect(m?.cost?.cache_write).toBe(0.75)
  })

  test("cache_read / cache_write only present when non-zero", () => {
    // claude-sonnet-4-6 has input_cache_read and input_cache_write pricing
    const claude = result["claude-sonnet-4-6"]
    expect(claude?.cost?.cache_read).toBeDefined()
    expect(claude?.cost?.cache_write).toBeDefined()

    // minimax-m2.7 has no cache pricing
    const minimax = result["minimax-m2.7"]
    expect(minimax?.cost?.cache_read).toBeUndefined()
    expect(minimax?.cost?.cache_write).toBeUndefined()
  })

  test("falls back to DEFAULT_CONTEXT for a model with no context_length", () => {
    const noContext = buildModels([
      { id: "no-ctx", supported_parameters: [] },
    ])
    const m = noContext["no-ctx"]
    expect(m?.limit.context).toBe(8192) // DEFAULT_CONTEXT
  })

  test("output defaults to ceil(context * 0.2) when max_completion_tokens is absent", () => {
    const model = buildModels([
      {
        id: "no-max-out",
        context_length: 10000,
        supported_parameters: [],
        top_provider: { context_length: 10000 },
      },
    ])
    const m = model["no-max-out"]
    expect(m?.limit.output).toBe(Math.ceil(10000 * 0.2))
  })

  test("skips models with empty id", () => {
    const withEmpty = buildModels([{ id: "" }])
    expect(Object.keys(withEmpty).length).toBe(0)
  })
})
