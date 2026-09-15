# AGENTS.md: pi-devin-oauth

Pi package that registers the `devin` provider. Login is browser sign-in (Windsurf RegisterUser) or a pasted API key. No Devin CLI.

## Layout

```
extensions/index.ts       # registerProvider("devin")
src/windsurf-login.ts     # /login devin (browser or paste key)
src/cli-model-catalog.ts  # GetCliModelConfigs (fallback GetCascadeModelConfigs)
src/devin-catalog-cache.ts
src/devin-models.ts       # catalog → one Pi model per family
src/stream-devin.ts       # GetChatMessage (Connect/protobuf)
src/mint-user-jwt.ts      # GetUserJwt cache
src/client-metadata.ts    # ide=devin-desktop
src/connect-wire.ts       # protobuf + Connect framing
src/chat-context-map.ts   # Pi Context → Cognition history
src/thinking-signature.ts
```

## Contract

- Do not spawn `devin`, do not read `credentials.toml`, do not scrape Devin Desktop.
- Store the API key in Pi `auth.json` via `oauth.login`.
- Model IDs come from the live catalog RPC at factory load (and after login), cached under ~/.pi/agent/cache/. Do not add a /devin-refresh command.
- `contextWindow` and `maxTokens` come from `model_info` fields 4 and 13. Never widen them with a local floor: an overstated window overflows before Pi can compact.
- `cost` comes from the catalog's price rows (`Input` / `Cached input` / `Output`, USD per 1M tokens, float32). Models with no rows are included in the plan. The catalog publishes no cache-write rate, so `cacheWrite` stays 0 rather than inventing a multiplier.
- `reasoning` follows the catalog's `features.supports_thinking` flag, not the number of thinking variants.
- Chat Metadata stays `devin-desktop`. Catalog RPCs must use `windsurf` or the list comes back empty.
- One Pi model per family; thinking levels via Pi. Unsupported levels are `null`.
- Do not install alongside other packages that register `devin`.
