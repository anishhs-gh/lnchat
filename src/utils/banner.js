'use strict';

const https = require('https');

// ── ASCII art ─────────────────────────────────────────────────────────────────

const ART = `\x1b[36m\x1b[1m
 _            _           _   
| |_ __   ___| |__   __ _| |_ 
| | '_ \\ / __| '_ \\ / _\` | __|
| | | | | (__| | | | (_| | |_ 
|_|_| |_|\\___|_| |_|\\__,_|\\__|
\x1b[0m`;

// ── semver comparison ─────────────────────────────────────────────────────────

// Returns true when `latest` is strictly greater than `current`.
// Only handles x.y.z numeric versions — good enough for a fresh package with
// no pre-release suffixes.
function isNewer(latest, current) {
  const parse = (v) => String(v).split('.').map(Number);
  const [lMaj, lMin, lPat] = parse(latest);
  const [cMaj, cMin, cPat] = parse(current);
  if (lMaj !== cMaj) return lMaj > cMaj;
  if (lMin !== cMin) return lMin > cMin;
  return lPat > cPat;
}

// ── npm registry check ────────────────────────────────────────────────────────

// Hits the npm registry full package document and resolves with:
//   { latest: string|null, deprecated: string|null }
// where:
//   latest     — the version tagged "latest" on npm (null if unavailable)
//   deprecated — the deprecation message for `currentVersion` (null if not deprecated)
//
// Using the full packument (/lnchat instead of /lnchat/latest) lets us read
// both dist-tags.latest AND the per-version deprecated field in one request.
// Always resolves — never rejects — so callers need no .catch().
function checkNpmStatus(currentVersion) {
  return new Promise((resolve) => {
    const done = (result) => resolve(result);
    const fail = () => done({ latest: null, deprecated: null });

    let req;
    try {
      req = https.get(
        'https://registry.npmjs.org/lnchat',
        { timeout: 3000 },
        (res) => {
          if (res.statusCode !== 200) { res.resume(); return fail(); }
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => {
            try {
              const data   = JSON.parse(body);
              const latest = data['dist-tags'] && typeof data['dist-tags'].latest === 'string'
                ? data['dist-tags'].latest
                : null;
              // data.versions[v].deprecated is a string when deprecated, absent otherwise
              const verMeta   = data.versions && data.versions[currentVersion];
              const deprecated = (verMeta && typeof verMeta.deprecated === 'string')
                ? verMeta.deprecated
                : null;
              done({ latest, deprecated });
            } catch {
              fail();
            }
          });
          res.on('error', fail);
        }
      );
      req.on('timeout', () => { req.destroy(); fail(); });
      req.on('error',   fail);
    } catch {
      fail();
    }
  });
}

// ── banner printer ────────────────────────────────────────────────────────────

// Prints the ASCII art, current version, and (if available):
//   · a red deprecation warning when the running version has been deprecated on npm
//   · an update notice when a newer version is available
// `npmStatus` is the in-flight Promise returned by checkNpmStatus() — started
// early in main() so most of the network latency is consumed by the time we
// arrive here.
async function printBanner(ui, currentVersion, npmStatus) {
  ui.printRaw(ART);
  ui.printRaw(`  \x1b[2mv${currentVersion}\x1b[0m`);

  // Give the in-flight check at most 500ms more — by this point it has
  // been running since before the profile prompt, so the race is nearly
  // always instant.
  const { latest, deprecated } = await Promise.race([
    npmStatus,
    new Promise((r) => setTimeout(() => r({ latest: null, deprecated: null }), 500)),
  ]);

  // Deprecation warning — shown before the update notice so it's the most
  // prominent thing the user sees on startup.
  if (deprecated) {
    // Trim to 80 chars so it fits on a standard terminal; append '…' if cut.
    const msg = deprecated.length > 80 ? deprecated.slice(0, 79) + '…' : deprecated;
    ui.printRaw(
      `\n  \x1b[31m\x1b[1m⛔  v${currentVersion} is deprecated:\x1b[0m \x1b[31m${msg}\x1b[0m` +
      `\n  \x1b[2mUpdate now:  npm install -g lnchat\x1b[0m` +
      `\n  \x1b[2m      or:   npx lnchat@latest\x1b[0m`
    );
  }

  if (latest && isNewer(latest, currentVersion)) {
    ui.printRaw(
      `\n  \x1b[33m⬆  Update available:\x1b[0m v${currentVersion} \x1b[2m→\x1b[0m \x1b[32m\x1b[1mv${latest}\x1b[0m` +
      `\n  \x1b[2mTo update:  npm install -g lnchat\x1b[0m` +
      `\n  \x1b[2m      or:   npx lnchat@latest\x1b[0m`
    );
  }

  ui.printRaw('');
}

// Prints "lnchat vX.Y.Z" then fetches npm status and appends the same
// deprecation / update notice used in the startup banner.
// Intended for the --version / -v flag — no UI object needed, writes directly
// to stdout.  Waits up to 3 seconds for the registry (the full timeout, since
// there is no prior in-flight request to piggyback on).
async function printVersionStatus(currentVersion) {
  process.stdout.write(`lnchat v${currentVersion}\n`);
  const { latest, deprecated } = await checkNpmStatus(currentVersion);
  if (deprecated) {
    const msg = deprecated.length > 80 ? deprecated.slice(0, 79) + '…' : deprecated;
    process.stdout.write(
      `\n  \x1b[31m\x1b[1m⛔  v${currentVersion} is deprecated:\x1b[0m \x1b[31m${msg}\x1b[0m` +
      `\n  \x1b[2mUpdate now:  npm install -g lnchat\x1b[0m` +
      `\n  \x1b[2m      or:   npx lnchat@latest\x1b[0m\n`
    );
  } else if (latest && isNewer(latest, currentVersion)) {
    process.stdout.write(
      `\n  \x1b[33m⬆  Update available:\x1b[0m v${currentVersion} \x1b[2m→\x1b[0m \x1b[32m\x1b[1mv${latest}\x1b[0m` +
      `\n  \x1b[2mTo update:  npm install -g lnchat\x1b[0m` +
      `\n  \x1b[2m      or:   npx lnchat@latest\x1b[0m\n`
    );
  }
}

module.exports = { checkNpmStatus, printBanner, printVersionStatus };
