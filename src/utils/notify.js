'use strict';

const { spawn } = require('child_process');

// Escape a string for safe embedding inside an AppleScript double-quoted string.
function escapeAS(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Send a native desktop notification. onFail() is called once if the command
// is unavailable or exits non-zero — lets the caller show a one-time warning.
// All errors are swallowed; a broken notification path never affects the main app.
//
//   macOS  — osascript (always present)
//   Linux  — notify-send (libnotify); calls onFail if missing or daemon not running
//   other  — no-op (terminal bell fired by caller is the only signal)
function notify(title, body, onFail) {
  try {
    if (process.platform === 'darwin') {
      const child = spawn(
        'osascript',
        ['-e', `display notification "${escapeAS(body)}" with title "${escapeAS(title)}"`],
        { stdio: 'ignore' }
      );
      child.on('error', () => { if (onFail) onFail(); });
      child.on('close', (code) => { if (code !== 0 && onFail) onFail(); });
      child.unref();

    } else if (process.platform === 'linux') {
      const child = spawn(
        'notify-send',
        ['--app-name=lnchat', '--expire-time=4000', title, body],
        { stdio: 'ignore' }
      );
      child.on('error', () => { if (onFail) onFail(); });
      child.on('close', (code) => { if (code !== 0 && onFail) onFail(); });
      child.unref();
    }
  } catch (_) {}
}

module.exports = { notify };
