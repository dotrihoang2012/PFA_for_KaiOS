/**
 * midiParser.js — Binary MIDI to JSON converter.
 * Parses MIDI format 0/1 files and outputs {
 *   notes: [{t: tick, c: channel, n: note, v: velocity, d: duration}],
 *   tempo: [{t: tick, u: microsecondsPerQuarterNote}],
 *   div: ticksPerQuarterNote
 * }
 *
 * Dependencies: none (plain JavaScript, works in browser and Node).
 */
var MidiParser = (function () {
  'use strict';

  // --- Helper functions ---

  /**
   * Read a variable-length quantity (VLQ) from data view at offset.
   * Returns { value: number, offset: newOffset }.
   */
  function readVLQ(dataView, offset) {
    var value = 0;
    var b;
    do {
      b = dataView.getUint8(offset);
      value = (value << 7) | (b & 0x7f);
      offset++;
    } while (b & 0x80);
    return { value: value, offset: offset };
  }

  /**
   * Parse a MIDI file from ArrayBuffer.
   * @param {ArrayBuffer} buf - MIDI file binary data.
   * @returns {Object} Parsed MIDI in JSON format.
   */
  function parseMIDI(buf) {
    var dv = new DataView(buf);
    var offset = 0;

    // --- Helper to read strings ---
    function readString(length) {
      var str = '';
      for (var i = 0; i < length; i++) {
        str += String.fromCharCode(dv.getUint8(offset + i));
      }
      offset += length;
      return str;
    }

    // --- Parse MThd header ---
    if (readString(4) !== 'MThd') {
      throw new Error('Invalid MIDI file: missing MThd header');
    }
    var headerLength = dv.getUint32(offset, false); // big endian
    offset += 4;
    if (headerLength !== 6) {
      throw new Error('Unexpected header length: ' + headerLength);
    }
    var format = dv.getUint16(offset, false);
    offset += 2;
    var numTracks = dv.getUint16(offset, false);
    offset += 2;
    var division = dv.getUint16(offset, false);
    offset += 2;

    if (format > 1) {
      throw new Error('Only MIDI format 0 and 1 are supported');
    }

    // --- Parse each track ---
    var tracks = [];
    for (var trackIdx = 0; trackIdx < numTracks; trackIdx++) {
      if (readString(4) !== 'MTrk') {
        throw new Error('Invalid MIDI file: missing MTrk track header');
      }
      var trackLength = dv.getUint32(offset, false);
      offset += 4;
      var trackStart = offset;
      offset += trackLength; // we'll parse the track data in-place

      // Parse events within this track
      var trackEvents = parseTrack(dv, trackStart, trackLength);
      tracks.push(trackEvents);
    }

    // --- Merge events from all tracks and sort by absolute tick ---
    var allEvents = [];
    for (var i = 0; i < tracks.length; i++) {
      allEvents = allEvents.concat(tracks[i]);
    }
    allEvents.sort(function (a, b) { return a.tick - b.tick; });

    // --- Build notes and tempo arrays ---
    var notes = []; // {t, c, n, v, d}
    var tempo = []; // {t, u}
    var activeNotes = {} // key: channel*128+note -> {tick: onTick, velocity}

    for (var e = 0; e < allEvents.length; e++) {
      var ev = allEvents[e];
      if (ev.type === 'noteOn' || ev.type === 'noteOff') {
        var key = ev.channel * 128 + ev.note;
        if (ev.type === 'noteOn' && ev.velocity > 0) {
          // Note on
          activeNotes[key] = { tick: ev.tick, velocity: ev.velocity };
        } else {
          // Note off (or note on with velocity 0)
          var on = activeNotes[key];
          if (on) {
            var duration = ev.tick - on.tick;
            if (duration < 0) duration = 0; // sanity
            notes.push({
              t: on.tick,
              c: ev.channel,
              n: ev.note,
              v: on.velocity,
              d: duration
            });
            delete activeNotes[key];
          }
        }
      } else if (ev.type === 'tempo') {
        tempo.push({
          t: ev.tick,
          u: ev.microsecondsPerQuarterNote
        });
      }
    }

    // Any remaining active notes? Assume they end at the last event's tick (or track end)
    var lastTick = allEvents.length > 0 ? allEvents[allEvents.length - 1].tick : 0;
    for (var key in activeNotes) {
      var on = activeNotes[key];
      var duration = lastTick - on.tick;
      if (duration < 0) duration = 0;
      var channel = Math.floor(key / 128);
      var note = key % 128;
      notes.push({
        t: on.tick,
        c: channel,
        n: note,
        v: on.velocity,
        d: duration
      });
    }

    // Sort notes by start tick
    notes.sort(function (a, b) { return a.t - b.t; });

    // Ensure tempo array has at least one event (default 120 BPM = 500000 us)
    if (tempo.length === 0) {
      tempo.push({ t: 0, u: 500000 });
    } else {
      tempo.sort(function (a, b) { return a.t - b.t; });
    }

    return {
      notes: notes,
      tempo: tempo,
      div: division
    };
  }

  /**
   * Parse a single track chunk.
   * @param {DataView} dv - DataView of the MIDI file.
   * @param {number} trackStart - Offset where track data begins.
   * @param {number} trackLength - Length of track data in bytes.
   * @returns {Array} Array of events, each with {tick, type, ...}.
   */
  function parseTrack(dv, trackStart, trackLength) {
    var offset = trackStart;
    var endOffset = trackStart + trackLength;
    var currentTick = 0;
    var runningStatus = 0; // last status byte
    var runningChannel = 0; // last channel
    var events = [];

    while (offset < endOffset) {
      // Read delta time (VLQ)
      var vlqResult = readVLQ(dv, offset);
      offset = vlqResult.offset;
      currentTick += vlqResult.value;

      // Read event type
      var eventType = dv.getUint8(offset);
      offset++;

      // Check if this is a meta event or sysex
      if (eventType === 0xff) {
        // Meta event
        var metaType = dv.getUint8(offset);
        offset++;
        var lengthResult = readVLQ(dv, offset);
        offset = lengthResult.offset;
        var length = lengthResult.value;
        var metaDataOffset = offset;
        offset += length;

        if (metaType === 0x51) { // Set Tempo
          if (length === 3) {
            var microsecondsPerQuarterNote =
              (dv.getUint8(metaDataOffset) << 16) |
              (dv.getUint8(metaDataOffset + 1) << 8) |
              dv.getUint8(metaDataOffset + 2);
            events.push({
              tick: currentTick,
              type: 'tempo',
              microsecondsPerQuarterNote: microsecondsPerQuarterNote
            });
          }
        }
        // Ignore other meta events for now
        continue;
      } else if (eventType === 0xf0 || eventType === 0xf7) {
        // Sysex event - skip length bytes
        var lengthResult = readVLQ(dv, offset);
        offset = lengthResult.offset;
        offset += lengthResult.value;
        continue;
      }

      // MIDI channel event
      var status = eventType & 0xf0;
      var channel = eventType & 0x0f;
      var dataByte1, dataByte2;

      // Check for running status
      if (status < 0x80) {
        // eventType IS the first data byte — reuse last status
        status = runningStatus;
        channel = runningChannel;
        dataByte1 = eventType;
      } else {
        // New status byte
        runningStatus = status;
        runningChannel = channel;
        dataByte1 = dv.getUint8(offset); offset++;
      }

      // Read appropriate number of data bytes based on status type
      // 2-byte events: 0x80(N), 0x90, 0xA0, 0xB0, 0xE0
      // 1-byte events: 0xC0, 0xD0
      var statusNeeds2Bytes = (status === 0x80 || status === 0x90 ||
                                        status === 0xA0 || status === 0xB0 ||
                                        status === 0xE0);
      if (statusNeeds2Bytes) {
        dataByte2 = dv.getUint8(offset); offset++;
      } else {
        // 1-byte events (0xC0, 0xD0) — don't read second byte
        dataByte2 = 0;
      }

      // Process only note events (0x80 note off, 0x90 note on)
      if (status === 0x80 || status === 0x90) {
        var evType = (status === 0x90 && dataByte2 > 0) ? 'noteOn' : 'noteOff';
        events.push({
          tick: currentTick,
          type: evType,
          channel: channel,
          note: dataByte1,
          velocity: dataByte2
        });
      }
      // Ignoret control change, programs , etc. — bytes are consumed and discarded
    }

    return events;
  }

  // --- Export ---
  // Browser: window.MidiParser = { parseMIDI: parseMIDI }
  // Node: module.exports = { parseMIDI: parseMIDI }
  if (typeof window !== 'undefined') {
    window.MidiParser = { parseMIDI: parseMIDI };
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parseMIDI: parseMIDI };
  }

  return { parseMIDI: parseMIDI };
})();