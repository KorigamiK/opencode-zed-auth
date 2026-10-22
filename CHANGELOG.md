# Changelog

## 0.1.1

- Stop model discovery from repeating in response to its own connection status updates or unrelated credential notifications.
- Preserve catalog refreshes for account changes, credential replacement during discovery, and the five-minute timer.
- Keep routine model-loading logs silent unless `OPENCODE_ZED_DEBUG=1` is set.
- Correct local development installation instructions to use the package directory.

## 0.1.0

Breaking: requires OpenCode V2 (tested with 2.1.1), replacing the V1 plugin API.

- Register providers, models, authentication methods, and HTTP hooks through the V2 plugin context.
- Keep the existing `{userId, accessToken}` JSON credential format; resolve active credentials through OpenCode's integration API.
- Add explicit macOS Keychain and Linux secret-tool import, with **no automatic keyring fallback** during requests or discovery.
- Mark rejected credentials as needing authentication and stop repeatedly retrying them.
- Discover current Zed models and cache successful inventories by account and endpoint.
- Preserve multi-provider completion routing, token refresh, reasoning, tools, cancellation, and UTF-8 streaming.
- Update installation, migration, troubleshooting, package contents, bootstrap helper, tests, and release workflow for V2.
- Publish from GitHub Actions using npm's token-free trusted publishing (OIDC), with automatic provenance.

## 0.0.4

Previous npm release for OpenCode V1. Install `opencode-zed-auth@0.0.4` when retaining a V1 installation.
