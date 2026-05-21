export interface PlexusModelArchitecture {
  modality?: string
  input_modalities?: string[]
  output_modalities?: string[]
  tokenizer?: string
  instruct_type?: string | null
}

export interface PlexusModelPricing {
  prompt?: string
  completion?: string
  input_cache_read?: string
  input_cache_write?: string
}

export interface PlexusTopProvider {
  context_length?: number | null
  max_completion_tokens?: number | null
  is_moderated?: boolean
}

export interface PlexusApiModel {
  id: string
  object?: string
  created?: number
  owned_by?: string
  preferred_api?: string | string[]
  name?: string
  description?: string
  context_length?: number | null
  architecture?: PlexusModelArchitecture
  pricing?: PlexusModelPricing
  supported_parameters?: string[]
  top_provider?: PlexusTopProvider
  /** Hint for pi sister extension — ignored by opencode plugin */
  pi_provider?: string
  pi_model?: string
}

export interface PlexusApiResponse {
  object: string
  data: PlexusApiModel[]
}

export interface ResolvedConfig {
  baseURL?: string
  apiKey?: string
}
