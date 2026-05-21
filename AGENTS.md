# AGENTS.md

## Commands

- `bun run build` — bundle `src/index.ts` → `dist/index.js` (ESM, target bun, external packages)
- `bun run watch` — same, with incremental rebuild on file change
- `bun run typecheck` — `tsc --noEmit` (no emit; tsconfig has `noEmit: true`)
- `bun test ./tests` — run all tests
- `bun run typecheck && bun test ./tests` — full verification before committing

## Architecture

OpenCode plugin that exposes a self-hosted Plexus instance as a `plexus` provider with dynamic model discovery.

**Entry point:** `src/index.ts` → exports OpenCode plugin hooks.

**Key files:**
- `src/plugin.ts` — plugin registration / hook definitions
- `src/models.ts` — fetches `/v1/models` from Plexus, transforms to OpenCode model schema, caches on disk
- `src/plexus-client.ts` — HTTP client for Plexus API
- `src/cache.ts` — on-disk cache (`~/.local/share/opencode/plugins/plexus/`)
- `src/config-store.ts` — reads `PLEXUS_BASE_URL` / `PLEXUS_API_KEY` or stored options
- `src/url.ts` — URL normalization helpers
- `src/types.ts` — Plexus API types

## Release flow

Bumping `version` in `package.json` and pushing to `main` triggers the `Release and Publish` workflow:
1. Checks if `v<version>` tag already exists — if not, tags and publishes to npm via OIDC (no tokens)
2. If tag already exists, no-op

**To release:** bump `version` in `package.json`, commit, push to `main`.

The trusted publisher on npmjs.com is configured for workflow filename `publish.yaml`.

## Tests

- Test fixtures live in `tests/fixtures/` (e.g., `models.json` vendored from the pi-plexus repo)
- Tests import from `../src/` (TypeScript source, not `dist/`) because Bun runs TS natively

## Toolchain notes

- Runtime/build: **Bun** (not Node). Use `bun` commands, not `npm` or `node` for local dev.
- Package manager: `bun install` (lockfile is `bun.lock`, not `package-lock.json`)
- tsconfig uses JSONC comments — LSP may flag them; this is expected
- `dist/` is gitignored; the `prepublishOnly` script rebuilds before `npm publish`
