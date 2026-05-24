# Changelog

All notable changes to lnchat are documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).  
Versions follow [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

---

## [1.0.0] — 2026-05-24

First public release.

### Added

#### Core messaging
- Zero-config peer discovery over UDP broadcast (ports 41234–41238)
- TLS-encrypted TCP messaging with self-signed RSA-2048 certificates per profile
- Ed25519-signed HELLO packets — forged or replayed discovery packets are rejected
- Trust On First Use (TOFU) — first public key per device ID is persisted; key changes trigger a security warning
- TLS certificate fingerprint pinning — HELLO announces fingerprint; connections with mismatched certs are rejected immediately
- Peers evicted automatically after 15 seconds of missed heartbeats

#### Commands
- `/list` — show online peers with discriminators, IPs, and latency
- `/msg <name[#disc]> [text]` — direct message with optional one-shot pending mode
- `/ping <name>` — measure round-trip time to a peer
- `/focus <name>` / `/back` — sticky focused chat mode; auto-exits if peer goes offline
- `/all <text>` — broadcast to all online peers simultaneously
- `/history [name]` — in-memory message log, filterable by peer
- `/notify` — toggle desktop notifications on/off at runtime
- `/clear` — clear terminal screen without exiting focus mode
- `/help` — show command reference
- `/exit` — quit

#### Profiles and identity
- Persistent profiles stored in `~/.lnchat/profiles/` (UUID, TLS keys, Ed25519 keys)
- `--profile <name>` — run multiple identities simultaneously
- `--new-account` — regenerate identity while keeping the profile name
- `--list-profiles` — list all saved profiles
- `--remove-profile <name>` — delete a profile and all its cryptographic keys
- `--factory-reset` — wipe `~/.lnchat/` entirely (confirmation required)
- 4-character hex discriminator derived from UUID to disambiguate same-nickname peers

#### Spaces
- `--space <name>` — restrict discovery to peers sharing the same space name
- Space name is part of the Ed25519-signed payload — cannot be forged or stripped

#### Notifications
- Terminal bell (`\x07`) on every incoming message
- Native desktop notification via `osascript` (macOS) or `notify-send` (Linux)
- `--no-notify` — start with notifications silenced
- `/notify` — toggle notifications on/off at runtime

#### UX
- ASCII art banner with version on startup
- Startup update notice when a newer npm version is available
- Startup deprecation warning (red) when the running version has been deprecated on npm
- Input syntax highlighting: `/command` cyan, peer name bold-yellow, as you type
- Live typing indicators in focused chat (TYPING / STOP_TYPING packets, 4-second idle timeout)
- `Esc Esc` clears the current input line
- `↑` / `↓` navigates command history (duplicates suppressed)
- "Quitting…" message on Ctrl+C / SIGTERM

#### CLI packaging
- Single minified bundle (`dist/lnchat.js`, ~30 kB) built with esbuild
- `npm install -g lnchat` / `npx lnchat` global CLI
- npm provenance attestation on publish ("Signed via GitHub Actions" badge)

#### Developer tooling
- CI workflow — syntax check, security audit, tests on Node 18 / 20 / 22
- Publish workflow — manual trigger, auto-creates signed GitHub release + npm publish with provenance
- 103 tests using Node's built-in `node:test` (zero extra test dependencies)

---

[Unreleased]: https://github.com/anishhs-gh/lnchat/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/anishhs-gh/lnchat/releases/tag/v1.0.0
