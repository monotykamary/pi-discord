# Changelog

## 0.2.12

- Validate against Pi 0.99.0, including an offline real-host package-loading probe.
- Declare imported host packages as wildcard peers and pin development dependencies to Pi 0.99.0.
- Use the host TypeBox schema package for nested session tools.

## [Unreleased]

## [0.1.1] - 2026-03-13

Documentation and cleanup.

- Added "How it works" paragraph to README explaining the message flow
- Removed redundant "Why" section from README
- Removed unnecessary `mkdir` import and call in runtime.js
- Consolidated renderer tests to use flat `test()` style
- Made package public for npm publishing

## [0.1.0] - 2026-03-12

Initial release.

- Discord bot daemon with gateway connection
- Mention and DM ingress to headless pi sessions
- Slash commands (`/pi ask`, `/pi status`, `/pi stop`, `/pi reset`)
- Per-route queue with lease-based work distribution
- Route registry with dedicated/shared workspace modes
- Journal for ambient context and edit/delete tracking
- `discord_upload` tool for bot sessions
- Pi operator commands (`/discord start`, `stop`, `status`, `logs`, etc.)
