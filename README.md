# lnchat

**Zero-config terminal messenger for devices on the same LAN.**  
No servers. No cloud. No accounts. No setup. Just run it.

[![npm](https://img.shields.io/npm/v/lnchat?color=cb3837)](https://www.npmjs.com/package/lnchat)
[![CI](https://img.shields.io/github/actions/workflow/status/anishhs-gh/lnchat/ci.yml?label=CI)](https://github.com/anishhs-gh/lnchat/actions/workflows/ci.yml)
[![Node](https://img.shields.io/node/v/lnchat)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-source--available-blue)](./LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-anishhs--gh%2Flnchat-24292e?logo=github)](https://github.com/anishhs-gh/lnchat)

---

## Features

- **Zero config** — peers discover each other automatically over UDP broadcast; no IP addresses, no pairing codes
- **Encrypted in transit** — all messages travel over TLS with self-signed certificates per identity
- **Authenticated peers** — every discovery packet is signed with Ed25519; forged or replayed HELLOs are rejected
- **Trust On First Use (TOFU)** — the first public key seen for a device is trusted; a changed key triggers a security warning
- **Focused chat** — `/focus` locks onto one peer so you can type freely without prefixing every message
- **Broadcast** — `/all` sends a message to every online peer in one command
- **Typing indicators** — a live "● Alice is typing..." line appears and disappears in real time
- **Message history** — `/history` shows recent messages, optionally filtered by peer
- **Desktop notifications** — native OS notification on every incoming message; toggleable with `/notify` or `--no-notify`
- **Spaces** — `--space <name>` isolates a group of peers so only same-space instances discover each other
- **Multiple profiles** — run different identities simultaneously with `--profile`
- **Input syntax highlighting** — slash commands are coloured cyan, peer names bold-yellow, as you type
- **No runtime dependencies** — ships as a single self-contained JS file (~30 kB)

---

## Install

```bash
# Global install (recommended)
npm install -g lnchat
lnchat

# One-off with npx (no install needed)
npx lnchat

# Check version
lnchat --version
```

**Requirements:** Node.js 18+, `openssl` (ships with macOS and most Linux distros).

---

## Quick start

```
$ lnchat

  _                    _           _
 | | __ _ _ __    ___| |__   __ _| |_
 | |/ _` | '_ \  / __| '_ \ / _` | __|
 | | (_| | | | || (__| | | | (_| | |_
 |_|\__,_|_| |_| \___|_| |_|\__,_|\__|

  v1.0.0

  ℹ  Logged in as anish#3fa1  (profile: default)
  ℹ  Connected to LAN
  ℹ  Your IP: 192.168.1.42
  ℹ  TCP messaging port : 9000
  ℹ  UDP discovery port : 41234  (range 41234–41238)

Type /help for available commands.
>
```

On first launch you are prompted for a nickname. Your identity — nickname, stable UUID, TLS cert, and Ed25519 signing keys — is saved to `~/.lnchat/profiles/` and reused automatically on every subsequent run.

When another lnchat instance appears on the network:

```
  ● rahul#c2d9 joined the network
```

---

## Commands

| Command | Description |
|---|---|
| `/list` | Show discovered peers with discriminators, IPs, and latency |
| `/msg <name[#disc]> [text]` | Send a message; use `name#disc` when names clash |
| `/ping <name[#disc]>` | Ping a peer and show round-trip time |
| `/focus <name[#disc]>` | Enter focused chat — all plain text goes to that peer |
| `/back` | Exit focused chat and return to the global prompt |
| `/all <text>` | Broadcast a message to every online peer |
| `/history [name]` | Show recent messages (all peers, or filtered by peer name) |
| `/notify` | Toggle desktop notifications on/off |
| `/clear` | Clear the terminal screen (local only) |
| `/help` | Show available commands |
| `/exit` | Quit |

### Sending messages

```
> /list
  1. Rahul#c2d9   192.168.1.11   8ms
  2. Priya#8ab3   192.168.1.55

> /msg Rahul deployment done?
[14:02] You → Rahul#c2d9: deployment done?

> /msg Priya
Messaging Priya — type your message:
> quick question about the PR
[14:03] You → Priya#8ab3: quick question about the PR
```

When two peers share the same nickname, use the 4-character discriminator:

```
> /msg Rahul hi
  ⚠  Multiple peers named "Rahul". Use the discriminator: Rahul#c2d9, Rahul#7f1e

> /msg Rahul#7f1e hi
[14:04] You → Rahul#7f1e: hi
```

### Focused chat

`/focus` locks the prompt onto one peer so you can have a real back-and-forth without typing `/msg` on every line:

```
> /focus Rahul
  ℹ  Focused on Rahul#c2d9. Type /back to return.

@Rahul#c2d9> hey, you around?
[14:10] You → Rahul#c2d9: hey, you around?

@Rahul#c2d9> what's the status on the deploy?
[14:10] You → Rahul#c2d9: what's the status on the deploy?

@Rahul#c2d9> /back
  ℹ  Left conversation with Rahul#c2d9.
>
```

Slash commands still work normally while in focus mode. If the focused peer goes offline, focus exits automatically with a notice.

### Broadcast

```
> /all standup in 5 minutes
[14:15] You → everyone: standup in 5 minutes
```

### Typing indicators

While typing in focus mode (or composing a message via `/msg`), a live indicator appears on the recipient's terminal:

```
  ● Rahul#c2d9 is typing...
```

It disappears the moment the message arrives or after a few seconds of inactivity.

### Message history

```
> /history
  [13:45] Rahul#c2d9: good morning
  [13:46] You → Rahul: morning!
  [14:02] You → Rahul: deployment done?

> /history Priya
  [14:03] You → Priya#8ab3: quick question about the PR
```

### Desktop notifications

lnchat fires a native OS desktop notification for every incoming message — useful when the terminal window is behind other apps or minimised.

- **macOS** — uses `osascript`; no install needed. Grant notification permission when prompted (System Settings → Notifications → Terminal).
- **Linux** — uses `notify-send` (install with `sudo apt install libnotify-bin` if missing).
- The terminal bell (`\x07`) always sounds regardless of notification state.

Toggle notifications at runtime:

```
> /notify
  ℹ  Desktop notifications off.

> /notify
  ℹ  Desktop notifications on.
```

### Input highlighting

Slash commands are highlighted as you type:

- `/command` → **cyan**
- `peername` (first argument to `/msg`, `/focus`, `/ping`, `/history`) → **bold yellow**
- rest of the text → normal

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Esc Esc` | Clear the current input line |
| `↑` / `↓` | Navigate command history |

---

## Profiles and CLI flags

### Multiple profiles

Each profile is an independent identity with its own UUID, nickname, and cryptographic keys.

```bash
# Default profile
lnchat

# Named profiles — two instances can run simultaneously
lnchat --profile work
lnchat --profile personal

# Start fresh: re-prompt for nickname, generate new keys
lnchat --new-account
lnchat --profile work --new-account

# List all saved profiles
lnchat --list-profiles

# Remove a profile and all its keys permanently
lnchat --remove-profile work
```

### Spaces

`--space` restricts peer discovery to instances that share the same space name. Peers without the flag (or with a different name) are invisible to each other.

```bash
# Everyone in this space sees each other; default-space peers are hidden
lnchat --space team-alpha

# Combine with --profile to separate identities too
lnchat --profile alice --space dev
lnchat --profile bob   --space dev      # sees alice
lnchat --profile carol --space staging  # does NOT see alice or bob
```

The space name is included in the Ed25519-signed HELLO packet, so it cannot be forged or stripped by an attacker.

### Full flag reference

| Flag | Description |
|---|---|
| `--profile <name>` | Select a named profile (default: `default`) |
| `--new-account` | Ignore saved profile data and create a fresh identity |
| `--list-profiles` | Print all saved profiles and exit |
| `--remove-profile <name>` | Delete a profile and all its cryptographic keys, then exit |
| `--factory-reset` | Delete **all** lnchat data (`~/.lnchat/`) — prompts for `yes` to confirm |
| `--space <name>` | Restrict peer discovery to instances using the same space name |
| `--no-notify` | Start with desktop notifications silenced (toggle later with `/notify`) |
| `--version` / `-v` | Print the installed version and exit |

### Removing a profile

`--remove-profile` deletes everything about that identity:
device UUID, TLS cert + key, Ed25519 signing keys. On next launch, a fresh UUID and new keys are generated. Other peers will treat you as a brand-new device.

### Factory reset

```bash
lnchat --factory-reset
```

Removes `~/.lnchat/` entirely — all profiles, all keys, and the peer trust store. Requires typing exactly `yes` at the prompt. This cannot be undone.

---

## Security

lnchat is designed for trusted LAN environments. Here is exactly what is and is not protected.

### What's protected

**Encryption in transit**  
All messages travel over TLS using a self-signed RSA-2048 certificate generated once per profile. TCP message traffic cannot be read by plain-text sniffers on the network.

**Peer authentication (signed HELLOs)**  
Every UDP discovery broadcast is signed with an Ed25519 private key unique to your profile. The receiver verifies the signature and rejects unsigned or forged packets. A 30-second timestamp window prevents replay attacks.

**Trust On First Use (TOFU)**  
The first public key seen for a device ID is stored in `~/.lnchat/known_peers.json`. If a subsequent HELLO arrives for the same device ID with a *different* public key, it is rejected and you see:

```
  ⚠  Security warning: Rahul (abc12345…) sent a HELLO with a different
     public key — possible impersonation. Message rejected.
```

**Space isolation**  
The `--space` name is part of the signed payload. An attacker on the network cannot forge or strip the field to inject peers across space boundaries.

### What's not protected

- **UDP discovery packets** are visible to anyone on the network (they are signed, but the content — nickname, IP, port — is readable).
- **TOFU first contact** — if an attacker impersonates a peer *before* you ever see the real peer, they become trusted. Subsequent key changes will be flagged.
- **Local storage** — profile data, TLS keys, and signing keys are stored unencrypted in `~/.lnchat/profiles/`. Physical access to your machine is outside lnchat's threat model.
- **Network scope** — lnchat is LAN-only by design and is not hardened for use over the internet.

### Identity file layout

| File | Contents |
|---|---|
| `~/.lnchat/profiles/<name>.json` | Device UUID and nickname |
| `~/.lnchat/profiles/<name>-cert.pem` | TLS certificate (public) |
| `~/.lnchat/profiles/<name>-key.pem` | TLS private key |
| `~/.lnchat/profiles/<name>-sign-priv.pem` | Ed25519 signing private key |
| `~/.lnchat/profiles/<name>-sign-pub.pem` | Ed25519 signing public key |
| `~/.lnchat/known_peers.json` | TOFU store — trusted peer public keys |

---

## How it works

### Discovery — UDP broadcast

Each instance sends a UDP `HELLO` packet every 5 seconds containing the device ID, nickname, discriminator, TCP port, TLS fingerprint, Ed25519 public key, signature, space name, and a timestamp. Packets are sent to:

- `127.0.0.1` on ports 41234–41238 — reaches other lnchat instances on the same machine; bypasses the macOS Application Firewall (loopback is always allowed)
- The subnet broadcast address of every active network interface (e.g. `192.168.1.255`) — reaches peers on the same LAN

Five ports are used so multiple instances on the same machine each bind their own exclusive port without conflict. Peers that stop heartbeating are evicted after 15 seconds.

### Messaging — TCP + TLS

Each instance runs a TLS server (port 9000 by default, falls back to a random OS-assigned port if taken). Messages are short-lived TLS connections directly to the peer's IP and port; they are newline-delimited JSON objects. The TLS connection verifies the peer's certificate against the fingerprint announced in the HELLO — a mismatch closes the connection immediately.

### Identity

A persistent UUID is generated once per profile and stored in `~/.lnchat/profiles/<name>.json`. The 4-character discriminator (e.g. `#3fa1`) is the first 4 hex characters of the UUID — deterministic, stable, and unique enough to distinguish peers with the same nickname.

---

## Firewall notes

**macOS**
- Same-machine discovery uses loopback — always bypasses the Application Firewall.
- Cross-machine discovery uses subnet broadcast. The macOS firewall may show "Do you want the application node to accept incoming network connections?" on first run — click **Allow**.

**Linux**
- `ufw`: `sudo ufw allow 41234:41238/udp && sudo ufw allow 9000/tcp`
- `iptables`: `iptables -A INPUT -p udp --dport 41234:41238 -j ACCEPT && iptables -A INPUT -p tcp --dport 9000 -j ACCEPT`
- The TCP port falls back to a random port if 9000 is taken; the actual port is shown at startup.

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, testing guidelines, code style, and how to submit a pull request.

---

## Author

**Anish Shekh** — [@anishhs-gh](https://github.com/anishhs-gh)  
**Repository** — [github.com/anishhs-gh/lnchat](https://github.com/anishhs-gh/lnchat)

---

## License

lnchat is source-available with a non-compete restriction. You may freely use, modify, study, and contribute to the project. You may not publish the software — or a substantially similar derivative — to npm or any other package registry, nor offer it as a competing hosted service or tool.

See [LICENSE](./LICENSE) for the full terms.
