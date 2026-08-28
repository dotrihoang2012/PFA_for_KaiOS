/**
 * sfextract.js – Simple SoundFont 2 (.sf2) → .soundbank.json extractor.
 *
 * This implementation handles the most common case: a single preset with
 * one sample covering the full MIDI key range. It parses the RIFF container,
 * extracts the first sample (shdr[0]), builds a mono 16‑bit WAV, base64‑encodes
 * it, and emits a JSON structure suitable for the KaiOS soundbank engine.
 *
 * Usage:
 *   node tools/sfextract.js path/to/font.sf2 [out.soundbank.json]
 *
 * Output format (example):
 * {
 *   "name": "Acoustic Grand Piano",
 *   "presets": [
 *     {
 *       "name": "Acoustic Grand Piano",
 *       "bank": 0,
 *       "program": 0,
 *       "zones": [
 *         {
 *           "keyLo": 0,
 *           "keyHi": 127,
 *           "rootKey": 60,
 *           "sampleRate": 44100,
 *           "wav": "base64..."
 *         }
 *       ]
 *     }
 *   ]
 * }
 */

const fs = require('fs');

const inFile = process.argv[2];
const outFile = process.argv[3] || (inFile ? inFile.replace(/\.[^.]+$/, '.soundbank.json') : null);
if (!inFile) {
  console.error('Usage: node tools/sfextract.js <file.sf2> [out.soundbank.json]');
  process.exit(1);
}

// Load entire file into a Uint8Array for binary parsing.
const raw = new Uint8Array(fs.readFileSync(inFile));
let pos = 0;
const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);

// Helper to read ASCII strings.
function readString(len) {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(raw[pos++]);
  return s;
}
function u32() { const v = dv.getUint32(pos, true); pos += 4; return v; }
function u16() { const v = dv.getUint16(pos, true); pos += 2; return v; }
function u8()  { return raw[pos++]; }
function alignEven() { if (pos % 2) pos++; }

// ---- Parse top‑level RIFF ----
if (readString(4) !== 'RIFF') throw new Error('Not a RIFF file');
const fileSize = u32(); // includes "SFBK"
if (readString(4) !== 'sfbk') throw new Error('Not a SoundFont file (missing sfbk)');

let sampleData = null; // Uint8Array slice of raw sample PCM (16‑bit signed little‑endian)
let shdr = []; // sample header array
let phdr = []; // preset headers

// Parse chunks
while (pos < raw.length) {
  const chunkId = readString(4);
  const chunkSize = u32();
  const chunkEnd = pos + chunkSize;

  switch (chunkId) {
    case 'LIST':
      const listType = readString(4);
      if (listType === 'sdta') {
        // Sample data chunk: usually a sub‑chunk "smpl"
        // Read sub‑chunks inside sdta
        while (pos < chunkEnd) {
          const subId = readString(4);
          const subSize = u32();
          if (subId === 'smpl') {
            sampleData = raw.slice(pos, pos + subSize);
          }
          pos += subSize;
          alignEven();
        }
      } else if (listType === 'pdta') {
        // >> Parse all sub‑chunks relevant for a minimal extractor.
        while (pos < chunkEnd) {
          const subId = readString(4);
          const subSize = u32();
          const subEnd = pos + subSize;
          switch (subId) {
            case 'phdr': // preset headers
              while (pos + 38 <= subEnd) {
                const name = readString(20).replace(/\0+$/, '');
                const preset = {
                  name,
                  preset: u16(), // program number
                  bank: u16(),
                  bagIndex: u16(),
                };
                // skip library, genre, morphology (12 bytes)
                pos += 12;
                phdr.push(preset);
              }
              break;
            case 'shdr': // sample headers – 46 bytes each
              while (pos + 46 <= subEnd) {
                const name = readString(20).replace(/\0+$/, '');
                const start = u32();
                const end = u32();
                const startLoop = u32();
                const endLoop = u32();
                const sampleRate = u32();
                const originalKey = u8();
                const pitchCorrection = u8();
                const sampleLink = u16();
                const sampleType = u16();
                shdr.push({
                  name,
                  start,
                  end,
                  startLoop,
                  endLoop,
                  sampleRate,
                  originalKey,
                  pitchCorrection,
                  sampleLink,
                  sampleType,
                });
              }
              break;
            default:
              // ignore other sub‑chunks (inst, ibag, igen, pbag, pgen, ...)
              break;
          }
          pos = subEnd;
          alignEven();
        }
      } else {
        // other LIST types – ignore content
        pos = chunkEnd;
      }
      break;
    default:
      // Skip unknown chunks (e.g., "smpl" directly under root, though usually inside LIST sdta)
      pos = chunkEnd;
  }
  alignEven();
}

if (!sampleData) {
  console.error('ERROR: No sample data (smpl) found in the SF2 file');
  process.exit(1);
}
if (shdr.length === 0) {
  console.error('ERROR: No sample headers (shdr) parsed');
  process.exit(1);
}
if (phdr.length === 0) {
  console.error('ERROR: No preset headers (phdr) parsed');
  process.exit(1);
}

// Helper to build a minimal WAV buffer (PCM mono, 16‑bit, little‑endian).
function buildWav(sample, start, end) {
  const numFrames = end - start; // number of 16‑bit samples
  const wavSize = 44 + numFrames * 2;
  const wav = Buffer.allocUnsafe(wavSize);
  // RIFF header
  wav.write('RIFF', 0, 4, 'ascii');
  wav.writeUInt32LE(wavSize - 8, 4);
  wav.write('WAVE', 8, 4, 'ascii');
  // fmt chunk
  wav.write('fmt ', 12, 4, 'ascii');
  wav.writeUInt32LE(16, 16); // subchunk size
  wav.writeUInt16LE(1, 20); // PCM format
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(sample.sampleRate, 24);
  wav.writeUInt32LE(sample.sampleRate * 2, 28); // byte rate (16‑bit mono)
  wav.writeUInt16LE(2, 32); // block align
  wav.writeUInt16LE(16, 34); // bits per sample
  // data chunk
  wav.write('data', 36, 4, 'ascii');
  wav.writeUInt32LE(numFrames * 2, 40);
  // PCM data copy
  const srcStart = sample.start + start * 2; // each sample = 2 bytes
  const srcEnd = sample.start + end * 2;
  sampleData.copy(wav, 44, srcStart, srcEnd);
  return wav.toString('base64');
}

// Build JSON output – map each preset to the first sample (simplified).
const output = {
  name: phdr[0].name || 'Unnamed SoundFont',
  presets: [],
};

// Use the very first sample header for all presets (common simple case).
const firstSample = shdr[0];
const wavBase64 = buildWav(firstSample, firstSample.start, firstSample.end);

phdr.forEach(preset => {
  output.presets.push({
    name: preset.name,
    bank: preset.bank,
    program: preset.preset,
    zones: [
      {
        keyLo: 0,
        keyHi: 127,
        rootKey: firstSample.originalKey,
        sampleRate: firstSample.sampleRate,
        wav: wavBase64,
      },
    ],
  });
});

fs.writeFileSync(outFile, JSON.stringify(output, null, 2), 'utf8');
console.log(`Extracted ${output.presets.length} preset(s) → ${outFile}`);
