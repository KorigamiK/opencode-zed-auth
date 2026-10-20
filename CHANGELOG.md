# Changelog

## 0.1.0

Breaking: requires OpenCode V2 (tested with 2.1.1), replacing the V1 plugin API.

- Register providers, models, authentication methods, and HTTP hooks through the V2 plugin context.
- Keep the existing `{userId, accessToken}` JSON credential format; resolve active credentials through OpenCode's integration API.
- Add explicit macOS Keychain and Linux secret-tool import, with **no automatic keyring fallback** during requests or discovery.
- Mark rejected credentials as needing authentication and stop repeatedly retrying them.
- Discover current Zed models and cache successful inventories by account and endpoint.
- Preserve multi-provider completion routing, token refresh, reasoning, tools, cancellation, and UTF-8 streaming.
- Update installation, migration, troubleshooting, package contents, bootstrap helper, tests, and release workflow for V2.

## 0.0.4

Previous npm release for OpenCode V1. Install `opencode-zed-auth@0.0.4` when retaining a V1 installation.
