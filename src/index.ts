import type { PluginModule } from "@opencode-ai/plugin"
import { PLEXUS_PLUGIN_ID } from "./constants"
import { PlexusProviderPlugin } from "./plugin"

export * from "./constants"
export * from "./models"
export * from "./plugin"
export * from "./types"

const plugin: PluginModule = {
  id: PLEXUS_PLUGIN_ID,
  server: PlexusProviderPlugin,
}

export default plugin
