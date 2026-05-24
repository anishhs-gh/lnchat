'use strict';

const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const DIM    = '\x1b[2m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';
const CYAN   = '\x1b[36m';

// Cycle through colors for peer nicknames so each peer gets a distinct color
const PEER_COLORS = [
  '\x1b[31m', // red
  '\x1b[32m', // green
  '\x1b[33m', // yellow
  '\x1b[34m', // blue
  '\x1b[35m', // magenta
  '\x1b[36m', // cyan
];

let colorIndex = 0;
const nicknameColors = new Map();

function getNicknameColor(nickname) {
  if (!nicknameColors.has(nickname)) {
    nicknameColors.set(nickname, PEER_COLORS[colorIndex % PEER_COLORS.length]);
    colorIndex++;
  }
  return nicknameColors.get(nickname);
}

function colorize(nickname) {
  return `${getNicknameColor(nickname)}${BOLD}${nickname}${RESET}`;
}

function timestamp() {
  const now = new Date();
  const h = now.getHours().toString().padStart(2, '0');
  const m = now.getMinutes().toString().padStart(2, '0');
  return `${DIM}[${h}:${m}]${RESET}`;
}

function dim(text)   { return `${DIM}${text}${RESET}`; }

// Dim an already-formatted ANSI string without stripping its colours.
// Re-inserts DIM after every RESET so embedded colour codes stay active (just muted).
function dimLine(str) { return DIM + str.replace(/\x1b\[0m/g, RESET + DIM) + RESET; }
function info(msg)   { return `${GREEN}✓${RESET} ${msg}`; }
function warn(msg)   { return `${YELLOW}⚠${RESET} ${msg}`; }
function error(msg)  { return `${RED}✗${RESET} ${msg}`; }
function system(msg) { return `${CYAN}${msg}${RESET}`; }

module.exports = { colorize, dim, dimLine, timestamp, info, warn, error, system };
