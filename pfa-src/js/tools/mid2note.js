#!/usr/bin/env node
/**
 * mid2note.js — Node.js CLI tool: convert .mid files to .note.
 * Usage: node mid2note.js <input.mid> [output-dir]
 *
 * Output format: { notes: [{t,c,n,v,d}], tempo: [{t,u}], div }
 * Compatible with KaiOS Black MIDI Player sequencer.
 *
 * Writes a single-line (JSON without pretty-print) .note file so it stays
 * small. KaiOS File Manager recognises .note → text/kai_plain as a
 * selectable/op-able type, unlike .json which it cannot pick.
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

// ---- Main ----

function main() {
  var args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    console.log('mid2note — Convert .mid to .note');
    console.log('Usage: node mid2note.js <input.mid> [output-dir]');
    console.log('');
    console.log('Output: { notes: [{t,c,n,v,d}], tempo: [{t,u}], div } (single line)');
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

    console.log('  Notes: ' + midiData.notes.length);
    console.log('  Tempo events: ' + midiData.tempo.length);
    console.log('  Division: ' + midiData.div);

    // Write as a single line (no pretty-print / newlines) to keep the file small.
    fs.writeFileSync(outputFile, JSON.stringify(midiData), 'utf-8');
    console.log('Done! ' + outputFile);
  } catch (e) {
    console.error('Error: ' + e.message);
    process.exit(1);
  }
}

main();
