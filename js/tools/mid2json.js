#!/usr/bin/env node
/**
 * mid2json.js — Node.js CLI tool: convert .mid files to .mid.json.
 * Usage: node mid2json.js <input.mid> [output.json]
 *
 * Output format: { notes: [{t,c,n,v,d}], tempo: [{t,u}], div }
 * Compatible with KaiOS Black MIDI Player sequencer.
 *
 * If no output specified, writes to same directory as input with .mid.json extension.
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
    console.log('mid2json — Convert .mid to .mid.json');
    console.log('Usage: node mid2json.js <input.mid> [output-dir]');
    console.log('');
    console.log('Output: { notes: [{t,c,n,v,d}], tempo: [{t,u}], div }');
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
  var outputFile = path.join(outputDir, baseName + '.mid.json');

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

    // Write JSON
    fs.writeFileSync(outputFile, JSON.stringify(midiData, null, 2), 'utf-8');
    console.log('Done! ' + outputFile);
  } catch (e) {
    console.error('Error: ' + e.message);
    process.exit(1);
  }
}

main();