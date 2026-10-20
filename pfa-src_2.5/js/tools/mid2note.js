#!/usr/bin/env node
/**
 * mid2note.js — Node.js CLI tool: convert .mid files to .note.
 * Usage: node mid2note.js <input.mid> [output-dir]
 *
 * Output: a PFA2 binary .note — identical layout to the file the Nokia
 * writes when it analyzes a MIDI (StreamParser.buildHeader / packNotes).
 * The KaiOS app opens these via NoteStream and streams them straight from
 * disk, so even millions of notes never load fully into RAM.
 *
 * Layout (little-endian):
 *   20-byte header : magic "PFA2" (u32 LE), version 2 (u32), div (u32),
 *                    numTempo (u32), numNotes (u32)
 *   numTempo × 8B  : tempo records {t: u32, u: u32}
 *   numNotes × 12B : note records {t: u32, c: u8, n: u8, v: u8, rsv: u8, d: u32}
 * Notes are globally sorted ascending by t (midiParser already sorts).
 *
 * KaiOS File Manager recognises .note → text/kai_plain as a selectable/
 * op-able type, unlike .json which it cannot pick.
 *
 * If no output dir specified, writes to same directory as input with .note extension.
 */

var fs = require('fs');
var path = require('path');

// ---- Load MIDI parser ----
var midiParserPath = path.resolve(__dirname, '../midi/midiParser.js');
var MidiParser;

try {
  // midiParser.js will attach module.exports automatically
  MidiParser = require(midiParserPath);
} catch (e) {
  console.error('Error: cannot load midiParser.js from ' + midiParserPath);
  console.error(e.message);
  process.exit(1);
}

var PFA2_MAGIC   = 0x32414650;   // "PFA2"
var PFA2_VERSION = 2;
var HEADER_BASE  = 20;
var NOTE_SIZE    = 12;
var TEMPO_SIZE   = 8;

// Pack notes + tempo into a PFA2 binary Buffer (same layout as StreamParser).
function packPFA2(notes, tempo, div) {
  if (!tempo || !tempo.length) tempo = [{ t: 0, u: 500000 }];
  var numTempo = tempo.length, numNotes = notes.length;
  var buf = Buffer.alloc(HEADER_BASE + numTempo * TEMPO_SIZE + numNotes * NOTE_SIZE);
  buf.writeUInt32LE(PFA2_MAGIC, 0);
  buf.writeUInt32LE(PFA2_VERSION, 4);
  buf.writeUInt32LE(div >>> 0, 8);
  buf.writeUInt32LE(numTempo, 12);
  buf.writeUInt32LE(numNotes, 16);
  var o = HEADER_BASE;
  tempo.forEach(function (t) {
    buf.writeUInt32LE(t.t >>> 0, o);
    buf.writeUInt32LE(t.u >>> 0, o + 4);
    o += TEMPO_SIZE;
  });
  for (var i = 0; i < numNotes; i++) {
    var n = notes[i];
    buf.writeUInt32LE(n.t >>> 0, o);
    buf.writeUInt8(n.c & 0xff, o + 4);
    buf.writeUInt8(n.n & 0xff, o + 5);
    buf.writeUInt8(n.v & 0xff, o + 6);
    buf.writeUInt8(0, o + 7);           // reserved byte
    buf.writeUInt32LE(n.d >>> 0, o + 8);
    o += NOTE_SIZE;
  }
  return buf;
}

// ---- Main ----

function main() {
  var args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    console.log('mid2note — Convert .mid to PFA2 binary .note');
    console.log('Usage: node mid2note.js <input.mid> [output-dir]');
    console.log('Output: PFA2 binary .note (streams on Nokia, never fully loaded into RAM)');
    process.exit(0);
  }

  var inputFile = path.resolve(args[0]);
  if (!fs.existsSync(inputFile)) {
    console.error('Error: file not found: ' + inputFile);
    process.exit(1);
  }

  var outputDir = args[1] || path.dirname(inputFile);
  if (!fs.existsSync(outputDir)) {
    console.error('Error: output directory not found: ' + outputDir);
    process.exit(1);
  }

  var baseName = path.basename(inputFile).replace(/\.mid$/i, '');
  var outputFile = path.join(outputDir, baseName + '.note');

  console.log('Input:  ' + inputFile);
  console.log('Output: ' + outputFile);

  try {
    // Read binary data
    var buf = fs.readFileSync(inputFile);

    // Convert Buffer to ArrayBuffer
    var arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

    // Parse MIDI
    var midiData = MidiParser.parseMIDI(arrayBuffer);

    var notes = midiData.notes || [];
    var tempo = midiData.tempo || [];

    console.log('  Notes: ' + notes.length);
    console.log('  Tempo events: ' + tempo.length);
    console.log('  Division: ' + midiData.div);

    // Pack as PFA2 binary (notes already sorted ascending by t) and write.
    var pfa = packPFA2(notes, tempo, midiData.div);
    fs.writeFileSync(outputFile, pfa);
    console.log('Done! ' + outputFile + ' (' + pfa.length + ' bytes)');
  } catch (e) {
    console.error('Error: ' + e.message);
    process.exit(1);
  }
}

main();
