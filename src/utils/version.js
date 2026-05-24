'use strict';

// Single source of truth for the package version.
// esbuild inlines package.json at bundle time, so the version string is baked
// directly into dist/lnchat.js — no runtime file-system access needed.
module.exports = require('../../package.json').version;
