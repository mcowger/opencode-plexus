# Development

## Local testing in OpenCode

1. **Build the plugin** (OpenCode loads from `dist/`):
   ```bash
   bun run build
   ```

2. **Register the local path as a plugin** (one-time setup):
   ```bash
   opencode plugin /Users/matt.cowger/workspace/oc-plexus
   ```
   This adds the absolute path to the `plugin` array in your global `opencode.json`:
   ```json
   {
     "plugin": ["/Users/matt.cowger/workspace/oc-plexus"]
   }
   ```

3. **After each code change**, rebuild and restart OpenCode:
   ```bash
   bun run build
   # then restart opencode
   ```

   Or keep a **watch** process running in a second terminal that rebuilds automatically on every save:
   ```bash
   bun run watch
   ```
   `bun build --watch` is Bun's native incremental rebuild mode — it re-bundles whenever any imported source file changes. You still need to restart OpenCode after each rebuild to pick up the new `dist/index.js`.

## Other commands

```bash
bun run typecheck   # type-check without emitting
bun test ./tests    # run unit tests
bun run build       # bundle to dist/index.js (one-shot)
bun run watch       # bundle and rebuild on every file change
```
