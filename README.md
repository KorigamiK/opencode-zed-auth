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
ln -sfn index.mjs ~/.opencode/plugins/zed-auth.js
```

## One-Time Provider Bootstrap

There is one important local-dev caveat: OpenCode does not always apply a freshly loaded plugin's `config()` hook early enough for a brand-new custom provider to appear on the first `opencode models zed` call.

If `opencode models zed` says `Provider not found: zed`, seed the provider entry once:

```zsh
bun run bootstrap-config
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
