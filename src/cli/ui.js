'use strict';

const readline = require('readline');

// Commands whose first argument is a peer nickname — only these get the
// bold-yellow nickname highlight in the input field.
const NICK_COMMANDS = new Set(['/msg', '/focus', '/ping', '/history', '/share']);

// Return a colored version of a slash-command input line:
//   /command              → cyan
//   /command nick         → cyan + bold-yellow nick
//   /command nick rest    → cyan + bold-yellow nick + normal rest
//   /all text             → cyan + normal text  (no nick arg)
// Non-slash input is returned unchanged.
function colorizeInput(line) {
  if (!line.startsWith('/')) return line;

  // (command)(optional-space)(rest)
  const m = line.match(/^(\/[^\s]*)(\s*)(.*)$/);
  if (!m) return line;

  const [, cmd, space, rest] = m;
  const coloredCmd = `\x1b[36m${cmd}\x1b[0m`; // cyan

  if (NICK_COMMANDS.has(cmd) && rest) {
    // first word of rest is the nickname
    const nm = rest.match(/^(\S+)(.*)/);
    if (nm) {
      const [, nick, remainder] = nm;
      return `${coloredCmd}${space}\x1b[1m\x1b[33m${nick}\x1b[0m${remainder}`;
    }
  }
  return `${coloredCmd}${space}${rest}`;
}

// Wraps Node's readline interface.
// The key challenge: incoming messages must not corrupt the user's current input line.
// We do this by clearing the current line before printing, then redrawing the prompt.
class UI {
  constructor() {
    this.rl = readline.createInterface({
      input:    process.stdin,
      output:   process.stdout,
      terminal: true,
    });
    this.rl.setPrompt('> ');
    this._typingActive  = false;       // true when the typing indicator is above the prompt
    this._progressLines = null;        // null = none; string[] = currently shown progress lines
    this._setupInputColoring();
  }

  // Apply syntax colors to whatever is currently in the input field.
  // Called AFTER readline has already rendered the prompt + plain text.
  // Cursor math: step back to start of input, erase, write colored version
  // (same visual width — ANSI codes are zero-width), reposition cursor.
  _repaintInput() {
    const rl     = this.rl;
    const line   = rl.line   || '';
    const cursor = rl.cursor || 0;
    if (!line.startsWith('/')) return;
    // Cursor math only works within a single visual line. If the prompt + input
    // would wrap, \x1b[nD is clipped at column 0 and we'd corrupt the display.
    const cols = process.stdout.columns || 80;
    if (this.rl.getPrompt().length + line.length >= cols) return;
    const colored = colorizeInput(line);
    if (colored === line) return; // no ANSI injected, nothing to do

    if (cursor > 0) process.stdout.write(`\x1b[${cursor}D`);
    process.stdout.write('\x1b[K');
    process.stdout.write(colored);
    const moveBack = line.length - cursor;
    if (moveBack > 0) process.stdout.write(`\x1b[${moveBack}D`);
  }

  // Wire up input coloring via two independent hooks:
  //
  // 1. Patch rl.prompt() — readline's internal refresh uses Symbol(_refreshLine)
  //    directly (not the public _refreshLine), so we can't hook that.  But every
  //    explicit redraw in our UI code goes through rl.prompt(), which we CAN patch.
  //    This covers: showPrompt, setPrompt, print, printSent, showTyping, clearTyping, clear.
  //
  // 2. Keypress listener — covers readline's internal Symbol(_refreshLine) calls
  //    that happen during typing.  readline's own keypress listener runs first
  //    (registered earlier), so rl.line is already updated when ours fires.
  //    setImmediate defers until after all synchronous readline processing is done
  //    and deduplicates bursts (e.g. paste).
  _setupInputColoring() {
    const rl = this.rl;

    // ── 1. rl.prompt() patch ─────────────────────────────────────────────────
    const origPrompt = rl.prompt.bind(rl);
    rl.prompt = (...args) => { origPrompt(...args); this._repaintInput(); };

    // ── 2. Keypress listener ─────────────────────────────────────────────────
    readline.emitKeypressEvents(process.stdin);
    let pending = false;
    process.stdin.on('keypress', () => {
      if (!pending) {
        pending = true;
        setImmediate(() => { pending = false; this._repaintInput(); });
      }
    });
  }

  // Ask a one-off question and return the answer via Promise
  question(q) {
    return new Promise((resolve) => {
      this.rl.question(q, resolve);
    });
  }

  // Like question() but shows * instead of the typed characters.
  // Replaces readline's _writeToOutput temporarily:
  //   - strings containing \x1b, \r, or \n are control/ANSI sequences → passed through as-is
  //     so cursor positioning and line-erase sequences still work correctly
  //   - pure printable content (the line buffer readline echoes) → replaced with * characters
  questionSecret(prompt) {
    return new Promise((resolve) => {
      process.stdout.write(prompt);
      const orig = this.rl._writeToOutput;
      this.rl._writeToOutput = (str) => {
        if (!str) return;
        if (str.includes('\x1b') || str.includes('\r') || str.includes('\n')) {
          process.stdout.write(str); // control/ANSI — pass through unchanged
        } else {
          process.stdout.write('*'.repeat(str.length)); // printable content — mask
        }
      };
      this.rl.question('', (answer) => {
        this.rl._writeToOutput = orig;
        process.stdout.write('\n');
        resolve(answer);
      });
    });
  }

  // Start showing the interactive prompt
  showPrompt() {
    this.rl.prompt(true);
  }

  // Change the prompt string and redraw immediately (used by focus mode)
  setPrompt(str) {
    this.rl.setPrompt(str);
    this.rl.prompt(true);
  }

  // Print a message without breaking whatever the user is currently typing.
  // Handles three possible states for the transient area above the prompt:
  //   - progress lines showing  → erase all N lines + prompt, write msg, redraw both
  //   - typing indicator showing → erase 1 line + prompt, write msg
  //   - nothing showing          → just clear the prompt line and write msg
  print(msg) {
    if (this._progressLines !== null) {
      const n = this._progressLines.length;
      process.stdout.write('\r\x1b[K');                  // clear prompt line
      process.stdout.write(`\x1b[${n}A\r\x1b[J`);       // up N lines, clear to end of screen
      process.stdout.write(msg + '\n');
      this.rl.prompt(true);
      this._redrawProgress();
    } else if (this._typingActive) {
      process.stdout.write('\r\x1b[K\x1b[1A\r\x1b[J' + msg + '\n');
      this._typingActive = false;
      this.rl.prompt(true);
    } else {
      process.stdout.write('\r\x1b[K' + msg + '\n');
      this.rl.prompt(true);
    }
  }

  // Print a sent-message confirmation. The cursor is already on a new line
  // because readline moved it after Enter. Go up to overwrite readline's echo.
  // With progress: go up N+1 lines (N progress + 1 prompt/input), then redraw.
  printSent(msg) {
    if (this._progressLines !== null) {
      const n = this._progressLines.length;
      process.stdout.write(`\x1b[${n + 1}A\r\x1b[J`);   // up N+1, clear to end of screen
      process.stdout.write(msg + '\n');
      this.rl.prompt(true);
      this._redrawProgress();
    } else if (this._typingActive) {
      process.stdout.write('\x1b[2A\r\x1b[J' + msg + '\n');
      this._typingActive = false;
      this.rl.prompt(true);
    } else {
      process.stdout.write('\x1b[1A\r\x1b[K' + msg + '\n');
      this.rl.prompt(true);
    }
  }

  // Same as print but does NOT redraw the prompt — used during startup before the
  // main loop starts
  printRaw(msg) {
    process.stdout.write(msg + '\n');
  }

  // Show a transient "X is typing..." hint above the prompt.
  // No-op if progress lines are visible (progress takes the transient slot) or
  // if the indicator is already showing.
  showTyping(peerTag) {
    if (this._progressLines !== null) return; // progress has priority
    if (this._typingActive) return;
    process.stdout.write('\r\x1b[K\x1b[2m● ' + peerTag + ' is typing...\x1b[0m\n');
    this._typingActive = true;
    this.rl.prompt(true);
  }

  // Erase the typing indicator and restore the prompt.
  clearTyping() {
    if (!this._typingActive) return;
    if (this._progressLines !== null) {
      // Was suppressed by progress — just clear the flag; nothing to erase
      this._typingActive = false;
      return;
    }
    process.stdout.write('\r\x1b[K\x1b[1A\r\x1b[J');
    this._typingActive = false;
    this.rl.prompt(true);
  }

  // ── Progress display ──────────────────────────────────────────────────────────
  //
  // Progress lines are rendered ABOVE the prompt (same slot as the typing
  // indicator).  The progress area can be multiple lines (broadcast transfers).
  //
  // Screen layout while progress is showing:
  //   [progress line 1]
  //   [progress line 2]    ← _progressLines.length rows above prompt
  //   > [user input]       ← prompt (cursor here after rl.prompt(true))

  // Render progress lines above the prompt for the first time (or replace all).
  showProgress(lines) {
    if (!lines || lines.length === 0) { this.clearProgress(); return; }

    if (this._progressLines !== null) {
      // Erase existing lines: cursor is on prompt line, go up N + clear to end
      process.stdout.write('\r\x1b[K');
      process.stdout.write(`\x1b[${this._progressLines.length}A\r\x1b[J`);
    } else if (this._typingActive) {
      process.stdout.write('\r\x1b[K\x1b[1A\r\x1b[J');
      this._typingActive = false;
    } else {
      process.stdout.write('\r\x1b[K'); // clear prompt line only
    }

    this._progressLines = lines;
    this._writeProgressLines(lines);
    this.rl.prompt(true);
  }

  // Overwrite progress lines in-place.  If the count changes, falls back to showProgress.
  updateProgress(lines) {
    if (!lines || lines.length === 0) { this.clearProgress(); return; }
    if (this._progressLines === null || this._progressLines.length !== lines.length) {
      this.showProgress(lines);
      return;
    }
    // Same number of lines — overwrite without scrolling.
    // Cursor is on the prompt line; step up N lines and rewrite each.
    this._progressLines = lines;
    process.stdout.write(`\x1b[${lines.length}A`);
    this._writeProgressLines(lines);
    this.rl.prompt(true);
  }

  // Erase all progress lines and restore the prompt.
  clearProgress() {
    if (this._progressLines === null) return;
    const n = this._progressLines.length;
    process.stdout.write('\r\x1b[K');                    // clear prompt line
    process.stdout.write(`\x1b[${n}A\r\x1b[J`);         // up N, clear to end of screen
    this._progressLines = null;
    this.rl.prompt(true);
  }

  // Write each progress line followed by a newline.  Cursor ends on the line
  // immediately after the last progress line (where rl.prompt(true) will draw).
  // Lines are clipped to terminal width so they never wrap — wrapping would
  // break the cursor-math in clearProgress/updateProgress (each entry must be
  // exactly 1 terminal row).
  _writeProgressLines(lines) {
    const maxW = Math.max(40, (process.stdout.columns || 80) - 2);
    for (const line of lines) {
      const safe = line.length > maxW ? line.slice(0, maxW - 1) + '…' : line;
      process.stdout.write('\r\x1b[K\x1b[2m' + safe + '\x1b[0m\n');
    }
  }

  // After printing a message, redraw the progress area that was erased.
  _redrawProgress() {
    if (this._progressLines === null) return;
    this._writeProgressLines(this._progressLines);
    this.rl.prompt(true);
  }

  // Erase all text currently typed into the input line.
  clearInput() {
    this.rl.write(null, { ctrl: true, name: 'a' }); // cursor to start
    this.rl.write(null, { ctrl: true, name: 'k' }); // delete to end
  }

  // Clear the visible terminal screen (local only — peers are not affected).
  // After erasing, we force readline to do a full redraw (no preserveCursor) so
  // it resets its internal cursor-position tracking and the prompt + input field
  // reappear correctly at the top of the fresh screen.
  clear() {
    process.stdout.write('\x1b[2J\x1b[H'); // erase screen + cursor to top-left
    this._typingActive  = false;
    this._progressLines = null;
    this.rl.prompt(false); // full redraw: move to col 0, write prompt + line buffer
  }

  // Hook into readline's keypress stream (terminal: true already enables it).
  // Up/Down are passed to readline's built-in history navigation.
  // Esc+Esc clears the input line; two forms are handled:
  //   slow (>100 ms apart): two separate escape events, timer-based detection
  //   fast (<100 ms apart): terminal encodes ESC ESC as a single meta+escape
  //     event, so key.meta=true is treated as an immediate double-Esc.
  // clearInput() is deferred to nextTick so it runs after readline finishes
  // processing the current keypress event.
  onKeypress(callback) {
    readline.emitKeypressEvents(process.stdin);
    let lastEscAt = 0;
    process.stdin.on('keypress', (str, key) => {
      if (!key || key.ctrl) return;

      if (key.name === 'escape') {
        if (key.meta) {
          // Fast ESC ESC decoded as a single meta+escape — clear immediately.
          process.nextTick(() => this.clearInput());
          lastEscAt = 0;
        } else {
          const now = Date.now();
          if (now - lastEscAt < 500) {
            process.nextTick(() => this.clearInput());
            lastEscAt = 0;
          } else {
            lastEscAt = now;
          }
        }
        return;
      }

      if (key.meta) return;
      if (key.name === 'return' || key.name === 'enter') { lastEscAt = 0; return; }
      if (key.name === 'up'     || key.name === 'down')  { lastEscAt = 0; return; }

      lastEscAt = 0;
      callback();
    });
  }

  // Wrap readline's line event with history deduplication: if the submitted
  // text already exists somewhere lower in history, remove the older copy so
  // the same entry never appears twice.
  onLine(callback) {
    this.rl.on('line', (line) => {
      if (this.rl.history.length > 1) {
        const top = this.rl.history[0];
        const dup = this.rl.history.indexOf(top, 1);
        if (dup !== -1) this.rl.history.splice(dup, 1);
      }
      callback(line);
    });
  }
  onClose(callback) { this.rl.on('close', callback); }

  close() {
    this.rl.close();
  }
}

module.exports = UI;
