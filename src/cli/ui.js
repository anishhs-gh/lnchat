'use strict';

const readline = require('readline');

// Commands whose first argument is a peer nickname — only these get the
// bold-yellow nickname highlight in the input field.
const NICK_COMMANDS = new Set(['/msg', '/focus', '/ping', '/history']);

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
    this._typingActive = false; // true when the typing indicator is the last printed line
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
  // When a typing indicator is on screen, we first erase it by going up one
  // line (\x1b[1A) then clearing to end-of-screen (\x1b[J) before printing.
  print(msg) {
    if (this._typingActive) {
      process.stdout.write('\r\x1b[K\x1b[1A\r\x1b[J' + msg + '\n');
      this._typingActive = false;
    } else {
      process.stdout.write('\r\x1b[K' + msg + '\n');
    }
    this.rl.prompt(true);
  }

  // Print a sent-message confirmation. Unlike print(), the cursor is already
  // on a new line because readline moved it after the user pressed Enter. We
  // go up one line (\x1b[1A) to overwrite readline's own echo of the input.
  // When a typing indicator is on screen we go up two lines and erase both.
  printSent(msg) {
    if (this._typingActive) {
      process.stdout.write('\x1b[2A\r\x1b[J' + msg + '\n');
      this._typingActive = false;
    } else {
      process.stdout.write('\x1b[1A\r\x1b[K' + msg + '\n');
    }
    this.rl.prompt(true);
  }

  // Same as print but does NOT redraw the prompt — used during startup before the
  // main loop starts
  printRaw(msg) {
    process.stdout.write(msg + '\n');
  }

  // Show a transient "X is typing..." hint. No-op if already showing — prevents
  // stacking multiple lines when the peer goes idle and resumes.
  showTyping(peerTag) {
    if (this._typingActive) return;
    process.stdout.write('\r\x1b[K\x1b[2m● ' + peerTag + ' is typing...\x1b[0m\n');
    this._typingActive = true;
    this.rl.prompt(true);
  }

  // Erase the typing indicator and restore the prompt — called on STOP_TYPING.
  clearTyping() {
    if (!this._typingActive) return;
    process.stdout.write('\r\x1b[K\x1b[1A\r\x1b[J');
    this._typingActive = false;
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
    this._typingActive = false;
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
