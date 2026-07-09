'use strict';

// Single source of truth for the voice audio format, shared by the capture,
// playback, jitter-buffer, echo-canceller, and media-socket code.
//
// 10 ms frames are deliberate: at 48 kHz/16-bit/mono a 10 ms frame is 480
// samples = 960 bytes of PCM, so even with the media-socket overhead the UDP
// packet stays comfortably under the ~1472-byte Ethernet/Wi-Fi MTU and is never
// IP-fragmented (a fragmented audio packet is lost entirely if either fragment
// drops). It also halves end-to-end latency versus 20 ms frames.
const SAMPLE_RATE   = 48_000;
const FRAME_MS      = 10;
const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000; // 480
const FRAME_BYTES   = FRAME_SAMPLES * 2;               // 960 (16-bit mono)

module.exports = { SAMPLE_RATE, FRAME_MS, FRAME_SAMPLES, FRAME_BYTES };
