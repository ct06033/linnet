# Linnet configuration (`config.json`)

Linnet reads a single JSON config file at startup — Element-grade deploy flexibility:
a self-hosted instance can ship presets, and users can override locally.

## Lookup order (implemented in `apps/desktop/src/main.ts`)

1. `$LINNET_CONFIG_DIR/config.json` — if the environment variable is set.
2. Packaged install: `<resourcesPath>/config.json` (electron-builder `extraResources` drops it there).
3. Development: `<appPath>/config.json` (see `apps/desktop/config.example.json`).

Missing file is fine — built-in defaults apply. Invalid values fall back per-field.

## Schema (wave 1)

```jsonc
{
  "homeserverUrl": "https://matrix.example.org", // optional seed; .well-known discovery wins
  "theme": "system",                              // "system" | "light" | "dark"
  "experimental": { "exampleFlag": false },       // feature flags gate lazy module chunks (PRD 6.9)
  "modules": {                                    // user-level enable/disable + per-module options
    "disabled": ["some.module.id"],
    "options": { "some.module.id": { "option": "value" } }
  },
  "presets": {},                                  // deployment presets (later waves)
  "lockdown": {}                                  // deployment lockdown flags (later waves)
}
```

Parsing/validation lives in `@linnet/core/config` (`parseConfig`), shared by the Electron
main process and the renderer.

## Well-known discovery

`GET <homeserver>/.well-known/matrix/client` may override the homeserver URL via
`m.homeserver.base_url`. Helper: `discoverWellKnown(homeserverUrl)` in `@linnet/core/config`.
