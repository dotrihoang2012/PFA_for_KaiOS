/**
 * convert.js — Chuyển đổi MIDI (.mid) → JSON (.json) cho Black MIDI Player KaiOS.
 *
 * Usage:  node tools/convert.js input.mid [output.json]
 *
 * Output:
 *   { fmt, div, tempo: [{t, u}, ...], notes: [{t, c, n, v, d}, ...] }
 */

var fs = require('fs');

var inFile  = process.argv[2];
var outFile = process.argv[3] || inFile.replace(/\.mid$/i, '') + '.json';

if (!inFile) {
  console.error('Usage: node tools/convert.js <file.mid> [out.json]');
  process.exit(1);
}

var raw = new Uint8Array(fs.readFileSync(inFile));
var p = 0;

// ── Helpers ──
function u16() {
  var v = (raw[p] << 8) | raw[p + 1];
  p += 2;
  return v;
}

function u32() {
  var v = (raw[p] << 24) | (raw[p + 1] << 16) | (raw[p + 2] << 8) | raw[p + 3];
  p += 4;
  return v >>> 0;
}

function vlq() {
  var v = 0;
  var b;
  do {
    b = raw[p++];
    v = (v << 7) | (b & 0x7F);
  } while (b & 0x80);
  return v;
}

function readStr(n) {
  var s = '';
  for (var i = 0; i < n; i++) s += String.fromCharCode(raw[p++]);
  return s;
}

// ── Header ──
var chunkId = readStr(4);
if (chunkId !== 'MThd') {
  console.error('ERROR: not a valid MIDI file');
  process.exit(1);
}

var hdrLen  = u32();
var format  = u16();
var tracks  = u16();
var division = u16();
if (hdrLen > 6) p += (hdrLen - 6);

console.log('File:      ' + inFile);
console.log('Format:    ' + format + '  Tracks: ' + tracks + '  Division: ' + division);

// ── Data ──
var tempoList = [];
var noteList  = [];
var openNotes = {}; // "ch:note" → [{t, c, n, v}]

// ── Parse Track ──
function parseOneTrack() {
  if (readStr(4) !== 'MTrk') {
    console.error('ERROR: missing MTrk at offset ' + (p - 4));
    process.exit(1);
  }

  var endPos = p + u32();
  var status = 0;
  var tick   = 0;

  while (p < endPos) {
    var delta = vlq();
    tick += delta;
    var b = raw[p];

    if (b < 0x80) {
      // running status
    } else {
      status = raw[p++];
    }

    var cmd = status & 0xF0;
    var ch  = status & 0x0F;

    // Meta
    if (status === 0xFF) {
      var metaType = raw[p++];
      var metaLen  = vlq();
      if (metaType === 0x2F) return; // EOT
      if (metaType === 0x51 && metaLen === 3) {
        var usec = (raw[p] << 16) | (raw[p + 1] << 8) | raw[p + 2];
        tempoList.push({ t: tick, u: usec });
      }
      p += metaLen;
      continue;
    }

    // SysEx
    if (status === 0xF0 || status === 0xF7) {
      p += vlq();
      continue;
    }

    // Note On
    if (cmd === 0x90) {
      var nn = raw[p++];
      var vv = raw[p++];
      var id = ch + ':' + nn;

      if (vv === 0) {
        // velocity 0 = NoteOff
        if (openNotes[id] && openNotes[id].length) {
          var on = openNotes[id].shift();
          noteList.push({ t: on.t, c: on.c, n: on.n, v: on.v, d: tick - on.t });
        }
      } else {
        if (!openNotes[id]) openNotes[id] = [];
        openNotes[id].push({ t: tick, c: ch, n: nn, v: vv });
      }
      continue;
    }

    // Note Off
    if (cmd === 0x80) {
      var nno = raw[p++];
      var vvo = raw[p++];
      var ido = ch + ':' + nno;
      if (openNotes[ido] && openNotes[ido].length) {
        var on = openNotes[ido].shift();
        noteList.push({ t: on.t, c: on.c, n: on.n, v: on.v, d: tick - on.t });
      }
      continue;
    }

    // CC (2 bytes)
    if (cmd === 0xB0) { p += 2; continue; }

    // Program Change / Channel Aftertouch (1 byte)
    if (cmd === 0xC0 || cmd === 0xD0) { p += 1; continue; }

    // Pitch Bend (2 bytes)
    if (cmd === 0xE0) { p += 2; continue; }
  }
}

// ── Run (scan for MTrk markers to handle alignment/padding) ──
var parsedTracks = 0;
while (parsedTracks < tracks && p < raw.length - 8) {
  // Seek to next MTrk chunk
  while (p < raw.length - 4) {
    if (raw[p] === 0x4D && raw[p+1] === 0x54 && raw[p+2] === 0x72 && raw[p+3] === 0x6B) break;
    p++;
  }
  if (p >= raw.length - 4) break;
  parseOneTrack();
  parsedTracks++;
}

// Close unmatched notes
for (var id in openNotes) {
  var arr = openNotes[id];
  for (var i = 0; i < arr.length; i++) {
    var it = arr[i];
    noteList.push({ t: it.t, c: it.c, n: it.n, v: it.v, d: 0 });
  }
}

// Sort
noteList.sort(function(a, b) { return a.t - b.t; });
tempoList.sort(function(p, q)  { return p.t - q.t; });

// Dedup tempo
for (var i = tempoList.length - 1; i >= 1; i--) {
  if (tempoList[i].t === tempoList[i-1].t) tempoList.splice(i, 1);
}
if (tempoList.length === 0 || tempoList[0].t !== 0) {
  tempoList.unshift({ t: 0, u: 500000 });
}

// Output
var json = { fmt: format, div: division, tempo: tempoList, notes: noteList };
fs.writeFileSync(outFile, JSON.stringify(json), 'utf8');

console.log('Done: ' + noteList.length + ' notes → ' + outFile);
console.log('  Tempo changes: ' + tempoList.length);
if (noteList.length) {
  var last = noteList[noteList.length - 1];
  console.log('  Tick range: ' + noteList[0].t + ' → ' + (last.t + last.d));
}