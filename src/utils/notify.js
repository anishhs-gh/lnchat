'use strict';

const { spawn } = require('child_process');

// Escape a string for safe embedding inside an AppleScript double-quoted string.
function escapeAS(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Send a native desktop notification — detached, non-blocking, silent on error.
//
// Platform support:
//   macOS  — uses osascript (always present, no install needed)
//   Linux  — uses notify-send (libnotify); silently does nothing if not installed
//   other  — no-op (the terminal bell fired by the caller is the only signal)
//
// Notifications are best-effort: any spawn error or missing binary is caught
// and swallowed so a broken notification path never affects the main app.
function notify(title, body) {
  try {
    if (process.platform === 'darwin') {
      spawn(
        'osascript',
        ['-e', `display notification "${escapeAS(body)}" with title "${escapeAS(title)}"`],
        { detached: true, stdio: 'ignore' }
      ).unref();

    } else if (process.platform === 'linux') {
      spawn(
        'notify-send',
        ['--app-name=lnchat', '--expire-time=4000', title, body],
        { detached: true, stdio: 'ignore' }
      ).unref();
    }
    // Windows / other: terminal bell (sent separately in index.js) is the fallback.
  } catch (_) {}
}

module.exports = { notify };
