/**
 * gendemo.js — Tạo file MIDI test đơn giản để kiểm tra converter.
 * Tạo 1 track với vài nốt: C4, D4, E4, F4, G4 (mỗi nốt dài 240 ticks ở 120BPM)
 */
var fs   = require('fs');
var path = require('path');

var out = [];
var running = 0;

function w(v, len) {
  for (var i = len - 1; i >= 0; i--) {
    out.push((v >>> (i * 8)) & 0xFF);
  }
}

function wStr(s) {
  for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
}

function wVLQ(v) {
  var b = [];
  do {
    b.unshift(v & 0x7F);
    v >>>= 7;
  } while (v > 0);
  for (var i = 0; i < b.length; i++) {
    if (i < b.length - 1) b[i] |= 0x80;
    out.push(b[i]);
  }
}

// Track events
var track = [];

function addEvent(delta, bytes) {
  wVLQ(delta);
  for (var i = 0; i < bytes.length; i++) out.push(bytes[i]);
}

// ── Build ──

// Header: MThd
wStr('MThd');
w(6, 4);    // chunk length
w(0, 2);    // format 0
w(1, 2);    // ntrks = 1
w(480, 2);  // division = 480 ticks/qn

// Track chunk (we'll build separately)
var trackStart = out.length;
// Reserve space for MTrk + length (padded later)
out.push(0,0,0,0, 0,0,0,0); // 8 bytes for "MTrk" + length

// Set Tempo: 120 BPM = 500000 usec/qn
addEvent(0, [0xFF, 0x51, 0x03, 0x07, 0xA1, 0x20]); // 500000

// Notes: C4(60), D4(62), E4(64), F4(65), G4(67)
//        velocity 100, each 240 ticks long
var notes = [60, 62, 64, 65, 67];
var tickNow = 0;

for (var i = 0; i < notes.length; i++) {

  // Note On
  addEvent(0, [0x90, notes[i], 100]);
   addEvent(240, [0x80, notes[i], 0]);

}// End of Track — delta 0
addEvent(0, [0xFF, 0x2F, 0x00]);

// Write MTrk header + length at reserved position
var trackEnd = out.length;
var trackLen = trackEnd - trackStart - 8;

// Patch "MTrk"
var p = trackStart;
out[p] = 0x4D; out[p+1] = 0x54; out[p+2] = 0x72; out[p+3] = 0x6B;
// Patch length (big-endian)
out[p+4] = (trackLen >>> 24) & 0xFF;
out[p+5] = (trackLen >>> 16) & 0xFF;
out[p+6] = (trackLen >>> 8) & 0xFF;
out[p+7] = trackLen & 0xFF;

// Write
var buf = Buffer.from(out);
var outPath = path.join(__dirname, '..', 'assets', 'demo', 'test.mid');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, buf);
console.log('Written: ' + outPath + ' (' + out.length + ' bytes)');