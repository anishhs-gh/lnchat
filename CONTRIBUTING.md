# Contributing to lnchat

Thanks for your interest in contributing! This document covers everything you need to get started.

---

## Code of conduct

Be respectful. Constructive criticism is welcome; personal attacks are not.

---

## Before you start

- **Bug fix or small improvement** — open an issue first (or comment on an existing one) so we can agree it's the right approach before you write code.
- **New feature** — open an issue describing the feature and why it belongs in lnchat. Features that add external runtime dependencies are unlikely to be accepted (zero-dependency is a core design goal).
- **Security vulnerability** — do **not** open a public issue. Email the details directly to the repository owner instead. You'll find the contact on the GitHub profile.

---

## Development setup

**Requirements:** Node.js 18+, npm, openssl (comes with macOS and most Linux distros).

```bash
# 1. Fork the repo on GitHub, then clone your fork
git clone https://github.com/<your-username>/lnchat.git
cd lnchat

# 2. Install dev dependencies (only esbuild — no runtime deps)
npm install

# 3. Run the test suite to verify a clean baseline
npm test
# expected: 100 pass, 0 fail

# 4. Start the app in dev mode
npm start
```

---

## Project layout

```
src/
  index.js              entry point, main() wires everything together
  cli/
    ui.js               readline wrapper, prompt management, input coloring
    commands.js         slash-command parser and handlers
  discovery/
    broadcaster.js      UDP HELLO heartbeat (signed with Ed25519)
    listener.js         UDP HELLO receiver — verifies signatures, TOFU
  messaging/
    tcpServer.js        TLS server — receives messages and pings
    tcpClient.js        TLS client — sends messages and pings
  peer/
    peerStore.js        in-memory peer registry with stale-peer eviction
  utils/
    banner.js           ASCII art, version check against npm registry
    knownPeers.js       TOFU persistent store (known_peers.json)
    logger.js           timestamp, colour helpers
    messageHistory.js   in-memory per-peer message log
    network.js          local IP / subnet broadcast helpers
    profile.js          profile management, TLS cert + Ed25519 key generation
    version.js          re-exports package.json version
tests/
  *.test.js             Node built-in test runner (node:test)
  testCreds.js          shared TLS + Ed25519 test credentials
```

---

## Running tests

```bash
npm test                  # run the full suite (node --test)
```

Tests use only Node's built-in `node:test` and `assert` modules — no Jest, no Mocha, no extra installs. New code must ship with tests. Target: every public code path covered.

**Test isolation rules:**
- Each test creates its own `PeerStore` and calls `.destroy()` in cleanup.
- Tests that spin up a `TCPServer` import `testCreds` for shared TLS credentials.
- Tests that use `KnownPeers` pass a temp file path (`os.tmpdir()/...`) to the constructor to avoid touching `~/.lnchat/known_peers.json`.

---

## Building

```bash
npm run build             # produces dist/lnchat.js (minified, single file)
```

The bundle is created by esbuild with identifier mangling (`--minify`) and a `#!/usr/bin/env node` shebang injected via `--banner:js`. The `dist/` directory is git-ignored; it is produced fresh on every publish.

---

## Code style

No formatter or linter config is enforced yet (contributions welcome). Informal rules in use:

- `'use strict';` at the top of every file.
- CommonJS (`require` / `module.exports`) throughout — no ESM.
- 2-space indentation, single quotes for strings.
- Align related assignments with spaces where it aids readability.
- Keep functions small and focused. Prefer many small methods over one large one.
- No `console.log` in library code; use `logger.js` helpers or `ui.print()`.
- Error handling: `try { ... } catch (_) {}` (underscore) for intentionally ignored errors.

---

## Submitting a pull request

1. Create a branch off `master`:
   ```bash
   git checkout -b fix/descriptive-name
   ```
2. Make your changes. Add or update tests.
3. Make sure `npm test` passes and `node --check` is clean on every file you touched:
   ```bash
   find src tests -name '*.js' -exec node --check {} \;
   npm test
   ```
4. Commit with a clear message:
   ```
   Short summary (50 chars or less)

   Longer explanation if needed. Wrap at 72 chars.
   Reference any related issue: Fixes #42
   ```
5. Push and open a PR against `master`. Fill in the PR description — what changed and why.
6. A review from `@anishhs-gh` is required before merge (enforced by CODEOWNERS).

---

## What will and won't be merged

| Likely accepted | Unlikely accepted |
|---|---|
| Bug fixes with regression tests | New runtime npm dependencies |
| Performance improvements | Breaking changes to the HELLO protocol without migration |
| New commands that fit the zero-config ethos | Features requiring a server or cloud component |
| Security improvements | Anything that breaks the 100-test baseline |
| Documentation, typos, examples | Cosmetic reformatting of unrelated files |

---

## Licence note

By submitting a pull request you agree that your contribution will be licensed under the same terms as the rest of the project (see [LICENSE](./LICENSE)). You retain copyright on your contribution; you are granting a licence to include it in lnchat.
