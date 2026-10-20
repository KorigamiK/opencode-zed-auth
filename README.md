# opencode-zed-auth

Route **OpenCode V2** model discovery and completions through your Zed hosted AI account.

Requires OpenCode **2.1.1 or newer (V2)**, Node.js 22+, and a Zed account with hosted AI access. Version `0.0.4` remains available for OpenCode V1; `0.1.x` uses the V2 plugin API.

## Install

Add the plugin to `~/.config/opencode/opencode.json` (or `.jsonc`), preserving your other settings:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-zed-auth@0.1.0"]
}
```

Restart/reload the OpenCode **server you actually use**, then open `/connect` → **Zed**. The plugin registers the provider and discovers the account's current models; you do not need to maintain a static model list.

For a development checkout, run `bun install` and use the absolute entrypoint instead of the npm package:

```jsonc
{ "plugins": ["/absolute/path/to/opencode-zed-auth/index.mjs"] }
```

Do not also leave an older `zed-auth.js` in the auto-loaded `~/.config/opencode/plugins/` directory. Load **one copy** of this plugin. If you need an explicit provider entry, the optional `bun run bootstrap-config` helper adds a native V2 configuration without replacing unrelated settings or comments.

## Connect

### Import desktop credentials (macOS / Linux)

1. Sign in to the Zed desktop app.
2. Open `/connect` → **Zed** → add an account → **Use local Zed desktop credentials**.
3. Approve the macOS Keychain or Linux keyring prompt if shown.
4. Open `/models` and choose a `zed/…` model.

The equivalent CLI flow is:

```sh
opencode auth login zed --method desktop
opencode models
```

macOS uses the `security` CLI; Linux needs `secret-tool` (`libsecret`). Windows users can paste credentials instead.

**Keychain/keyring access happens only during this explicit import.** Background model discovery, token refreshes, and completions use the credential saved in OpenCode. They never read or unlock your desktop keyring. If Zed rejects it, reconnect explicitly rather than allowing a retry loop to prompt you.

### Paste credentials

Choose **Paste Zed credentials JSON (userId + accessToken)** and paste the whole object as the secret:

```json
{
  "userId": "YOUR_ZED_USER_ID",
  "accessToken": "{\"version\":2,\"id\":\"TOKEN_ID\",\"token\":\"TOKEN_SECRET\"}"
}
```

`accessToken` must contain the **full desktop credential secret**, not only its inner `token`. An object-valued `accessToken` is also accepted. Do not paste credentials into chat, issue reports, or your OpenCode config.

OpenCode V2 stores new credentials in its database. Legacy `auth.json` is migration input, not the source to edit when switching accounts.

## Behavior

- Uses V2 provider transforms, integration auth methods, and provider-scoped native HTTP hooks.
- Exchanges the saved Zed credential at `/client/llm_tokens`, then fetches the live `/models` catalog.
- Refreshes the catalog on startup, account changes, and every five minutes. Successful inventories are cached in plugin storage by connection and endpoint, so a temporary outage does not hide newly discovered models after reload.
- Uses native OpenAI Responses, Anthropic, Gemini, and xAI protocol packages per model.
- Wraps requests in Zed's `/completions` envelope and adapts newline-delimited JSON responses to SSE, preserving UTF-8, cancellation, tools, and reasoning items.
- Refreshes expired LLM tokens once. A rejected desktop credential is marked **needs authentication** instead of opening Keychain or repeatedly retrying it.
- Does not rewrite your config during discovery or persist short-lived LLM tokens there.

Model cost metadata is a placeholder (`0`) for local OpenCode accounting, **not a promise of free usage**. Zed's subscription, quota, and billing rules still apply. This is an unofficial integration; Zed's APIs can change.

## Settings

Optional native V2 provider settings:

```jsonc
{
  "providers": {
    "zed": {
      "name": "Zed",
      "package": "@opencode/ai/providers/openai/responses",
      "settings": {
        "serverUrl": "https://zed.dev",
        "cloudUrl": "https://cloud.zed.dev",
        "llmUrl": "https://cloud.zed.dev",
        "transport": "http",
        "encoding": "none"
      }
    }
  }
}
```

`organizationId`, `systemId`, and `appVersion` are optional overrides. Environment equivalents are `ZED_SERVER_URL`, `ZED_CLOUD_URL`, `ZED_LLM_URL`, `ZED_ORGANIZATION_ID`, `ZED_SYSTEM_ID`, and `ZED_APP_VERSION`. Endpoint environment variables also apply to the desktop importer; provider settings apply to model requests and discovery.

## Migrate from V1

1. Back up your config; remove the old local plugin or old npm plugin reference.
2. Use the V2 `plugins` entry above. Rename `provider` to `providers` when converting the optional provider config; use `package` and `settings`, not `npm` and `options`.
3. Remove obsolete plugin-generated model entries if you want discovery to own the inventory. Preserve any intentional model overrides.
4. Reload the correct server and reconnect Zed once if the imported credential is rejected.

Do not point an OpenCode V1 installation at native V2 config. See the [OpenCode V2 migration guide](https://opencode.ai/v2/docs/migrate-v1).

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Keychain prompts during ordinary requests | Remove older plugin copies. This version has no background Keychain code path. Cancel stale prompts; no “Always Allow” permission is required. |
| `401` / needs authentication | Reconnect Zed using explicit desktop import or fresh JSON. Editing legacy `auth.json` will not update the V2 active account. |
| Only old models appear | Check `/connect` for an auth warning; then reload the server used by your TUI. A separately started `opencode serve` and the CLI background service can have different in-memory catalogs. |
| Plugin load error | Check OpenCode is V2, load only one plugin copy, and remove the V1 function-export implementation. |
| No desktop credential found | Sign in to Zed first; check `ZED_SERVER_URL`. On Linux, install `secret-tool`. |

Useful checks:

```sh
opencode auth list
opencode models
opencode api get /api/plugin
opencode api get /api/integration/zed
```

Use `opencode api --server YOUR_SERVER_URL …` when your UI connects to a separate server. Never share raw credential/config dumps in issue reports.

## Development and release

```sh
bun install --frozen-lockfile
npm test
npm pack --dry-run
```

Tests use fake credentials and mocked endpoints; they do not access Keychain or make billable model requests. For a live smoke test, connect explicitly and run a small prompt with one model from each supported family.

After reviewing/merging a release, run **Publish to npm** in GitHub Actions on the intended ref. The workflow runs tests, checks the packed file list, and publishes the version already in `package.json`; it does not silently bump versions. Use the `next` tag to test a release without replacing `latest`.
