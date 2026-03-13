# opencode-zed-auth

OpenCode plugin that routes model discovery and completions through Zed's hosted AI APIs.

## What It Does

- registers a `zed` provider for OpenCode
- reuses Zed desktop credentials on Linux through `secret-tool`, or accepts pasted credentials
- exchanges the base Zed credential for a short-lived LLM token
- loads the Zed model catalog from `/models`
- forwards completions to Zed `/completions`
- converts Zed's newline-delimited JSON stream into SSE for OpenCode

## Local Install

OpenCode local plugin autoload works most reliably from a plain `.js` file under `~/.opencode/plugins`.

```zsh
mkdir -p ~/.opencode/plugins
ln -sfn /home/origami/Dev/projects/javascript/opencode-zed-auth/index.mjs ~/.opencode/plugins/zed-auth.js
```

## One-Time Provider Bootstrap

There is one important local-dev caveat: OpenCode does not always apply a freshly loaded plugin's `config()` hook early enough for a brand-new custom provider to appear on the first `opencode models zed` call.

If `opencode models zed` says `Provider not found: zed`, seed the provider entry once:

```zsh
cd /home/origami/Dev/projects/javascript/opencode-zed-auth
npm run bootstrap-config
```

That writes `provider.zed` into `~/.opencode/opencode.json` using the plugin's own `config()` hook.

## Auth

Preferred path on Linux:

```zsh
opencode auth login
```

Then choose:

- `Other`
- provider id: `zed`
- `Use local Zed desktop credentials (Linux)`

Manual fallback:

- choose `Paste Zed credentials`
- `userId`: `attribute.username` from `secret-tool`
- `accessToken`: the full value after `secret =`, not just the inner `token`

To inspect the local Zed credential:

```zsh
secret-tool search --all --unlock url https://zed.dev
```

## Full Model Catalog

The plugin seeds a bootstrap `zed/gpt-5-nano` model so the provider can exist before auth succeeds.

Once auth works, the loader now performs a one-time authenticated `/models` refresh when it only sees the bootstrap catalog. That means:

- the first authenticated `opencode models zed` may take a little longer
- that first call may still print only the bootstrap snapshot, because OpenCode appears to list models from an earlier config snapshot
- during that same call, the plugin persists the full Zed catalog into `~/.opencode/opencode.json`
- the next `opencode models zed` should show the full Zed catalog immediately

## Debugging

Enable plugin logs with:

```zsh
OPENCODE_ZED_DEBUG=1 opencode models zed
OPENCODE_ZED_DEBUG=1 opencode run -m zed/gpt-5-nano "say hello"
```

Useful checks:

```zsh
opencode auth list
opencode models zed
opencode run -m zed/gpt-5-nano "say hello in one short sentence"
```

## Known Caveats

- Zed `/completions` is a live newline-delimited JSON stream, not SSE. The plugin converts it into SSE for OpenCode.
- `opencode run --format json` can look more buffered than the interactive UI even when the bridge is streaming correctly.
- Invalid model `status` values in `~/.opencode/opencode.json` can break provider loading. This plugin no longer writes `status: "active"` to persisted config.
- If the user signs out of Zed desktop or their local credential rotates, the plugin can still refresh the short-lived LLM token, but it cannot magically refresh the base desktop credential. Re-auth in Zed and log in again through OpenCode if that happens.

## Updating

```zsh
./script/publish.ts
```
