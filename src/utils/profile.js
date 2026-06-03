'use strict';

const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');
const { generateSelfSignedCert } = require('./tlsCert');

const LNCHAT_DIR  = path.join(os.homedir(), '.lnchat');
const PROFILES_DIR = path.join(LNCHAT_DIR, 'profiles');

// 4-char hex suffix derived from the first 2 bytes of the UUID (no hyphens)
function discriminatorFor(deviceId) {
  return deviceId.replace(/-/g, '').slice(0, 4);
}

// Derive a hex SHA-256 fingerprint from a PEM certificate.
// Strips headers/whitespace to get the raw DER bytes, then hashes.
function certFingerprint(certPem) {
  const der = Buffer.from(
    certPem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''),
    'base64'
  );
  return crypto.createHash('sha256').update(der).digest('hex');
}

// Generate Ed25519 signing key pair for this profile.
// Keys are saved as <name>-sign-priv.pem / <name>-sign-pub.pem and returned as PEM strings.
function generateSigningKeys(name) {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
  });
  fs.writeFileSync(path.join(PROFILES_DIR, `${name}-sign-priv.pem`), privateKey, 'utf8');
  fs.writeFileSync(path.join(PROFILES_DIR, `${name}-sign-pub.pem`),  publicKey,  'utf8');
  return { privateKey, publicKey };
}

// Load previously saved signing keys for a profile, or null if missing.
function loadSigningKeys(name) {
  const privPath = path.join(PROFILES_DIR, `${name}-sign-priv.pem`);
  const pubPath  = path.join(PROFILES_DIR, `${name}-sign-pub.pem`);
  if (!fs.existsSync(privPath) || !fs.existsSync(pubPath)) return null;
  return {
    privateKey: fs.readFileSync(privPath, 'utf8'),
    publicKey:  fs.readFileSync(pubPath,  'utf8'),
  };
}

// Generate a self-signed RSA-2048 TLS cert+key using Node's built-in crypto.
// Cert and key are saved as <name>-cert.pem / <name>-key.pem in PROFILES_DIR
// and returned as PEM strings.  This runs once per profile creation.
function generateTlsCreds(name) {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
  const { cert, key } = generateSelfSignedCert();
  fs.writeFileSync(path.join(PROFILES_DIR, `${name}-cert.pem`), cert, 'utf8');
  fs.writeFileSync(path.join(PROFILES_DIR, `${name}-key.pem`),  key,  'utf8');
  return { cert, key };
}

// Load previously generated TLS creds for a profile, or null if missing.
function loadTlsCreds(name) {
  const certPath = path.join(PROFILES_DIR, `${name}-cert.pem`);
  const keyPath  = path.join(PROFILES_DIR, `${name}-key.pem`);
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) return null;
  return {
    cert: fs.readFileSync(certPath, 'utf8'),
    key:  fs.readFileSync(keyPath,  'utf8'),
  };
}

// Load a saved profile or return null if it doesn't exist
function loadProfile(name) {
  const file = path.join(PROFILES_DIR, `${name}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

// Persist { deviceId, nickname } for the given profile name
function saveProfile(name, data) {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
  const file = path.join(PROFILES_DIR, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// Build a full profile object, creating it if it doesn't exist.
// Pass forceNew=true (--new-account) to skip saved data and start fresh.
// Returns { deviceId, nickname, discriminator, cert, key, signingKey }.
async function resolveProfile(name, forceNew, ui) {
  let saved = forceNew ? null : loadProfile(name);

  if (saved) {
    // Existing profile — load TLS creds and signing keys; regenerate silently if missing
    const creds   = loadTlsCreds(name)    || generateTlsCreds(name);
    const signing = loadSigningKeys(name) || generateSigningKeys(name);
    return {
      deviceId:               saved.deviceId,
      nickname:               saved.nickname,
      discriminator:          discriminatorFor(saved.deviceId),
      cert:                   creds.cert,
      key:                    creds.key,
      signingKey:             signing.privateKey,
      downloadsDir:           saved.downloadsDir           || null,
      notificationHintShown:  saved.notificationHintShown || false,
    };
  }

  // First use (or --new-account): prompt, persist, generate TLS creds + signing keys
  const nickname = (await ui.question('Enter nickname:\n> ')).trim() || 'Anonymous';
  const deviceId = crypto.randomUUID();
  saveProfile(name, { deviceId, nickname });
  const creds   = generateTlsCreds(name);
  const signing = generateSigningKeys(name);

  return {
    deviceId,
    nickname,
    discriminator:         discriminatorFor(deviceId),
    cert:                  creds.cert,
    key:                   creds.key,
    signingKey:            signing.privateKey,
    downloadsDir:          null,
    notificationHintShown: false,
  };
}

// Return all saved profiles as [{ name, nickname, discriminator }]
function listProfiles() {
  if (!fs.existsSync(PROFILES_DIR)) return [];
  return fs.readdirSync(PROFILES_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const name = f.slice(0, -5);
      const data = loadProfile(name);
      if (!data) return null;
      return { name, nickname: data.nickname, discriminator: discriminatorFor(data.deviceId) };
    })
    .filter(Boolean);
}

// Delete a profile and its TLS + signing key files; returns true if it existed
function removeProfile(name) {
  const file = path.join(PROFILES_DIR, `${name}.json`);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  try { fs.unlinkSync(path.join(PROFILES_DIR, `${name}-cert.pem`));       } catch (_) {}
  try { fs.unlinkSync(path.join(PROFILES_DIR, `${name}-key.pem`));        } catch (_) {}
  try { fs.unlinkSync(path.join(PROFILES_DIR, `${name}-sign-priv.pem`)); } catch (_) {}
  try { fs.unlinkSync(path.join(PROFILES_DIR, `${name}-sign-pub.pem`));  } catch (_) {}
  return true;
}

// Delete the entire ~/.lnchat directory — all profiles, keys, and the TOFU
// peer store.  Returns true if data existed, false if there was nothing to remove.
function factoryReset() {
  if (!fs.existsSync(LNCHAT_DIR)) return false;
  fs.rmSync(LNCHAT_DIR, { recursive: true, force: true });
  return true;
}

module.exports = { resolveProfile, discriminatorFor, certFingerprint, listProfiles, removeProfile, factoryReset, saveProfile, loadProfile };
