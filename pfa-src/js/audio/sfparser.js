/**
 * sfparser.js — In-app SoundFont 2 (.sf2 / .sf3) parser for PFA.
 *
 * Parses the RIFF/SFBK container directly from an ArrayBuffer (read by
 * caller from DeviceStorage / MozActivity 'pick'), resolving every preset
 * through its zone chain:
 *   phdr → pbag → pgen (instrument refs + key/vel ranges)
 *   inst → ibag → igen (sample refs + key/vel ranges + root key)
 *   shdr → smpl (raw PCM16 mono sample data)
 *
 * Output shape mirrors tools/sfextract.js but for the FULL font (all
 * presets, all samples, per-key zones) instead of "first preset, first
 * sample". SF3 (Ogg-compressed) fonts are attempted best-effort: if the
 * sample slice starts with an OggS ID the raw bytes are handed straight
 * to the Web Audio decoder (supported on Gecko builds with Ogg/Vorbis).
 *
 * Public API:
 *   SfParser.parse(arrayBuffer) → { name, samples, presets }
 *     samples: [{ index, name, sampleRate, originalKey, pcm (Int16Array) }]
 *     presets: [{ name, bank, program, zones }]
 *       zones: [{ keyLo, keyHi, velLo, velHi, rootKey, sampleIndex }]
 *   SfParser.pcm16ToWav(pcm, sampleRate) → ArrayBuffer (mono 16-bit WAV)
 */
var SfParser = (function () {
  'use strict';

  // Generator opcodes (SF2 spec)
  var GEN_INSTRUMENT      = 41;
  var GEN_KEYRANGE        = 43;
  var GEN_VELRANGE        = 44;
  var GEN_ROOTKEY         = 46;
  var GEN_SAMPLEID        = 53;

  function readString(bytes, off, len) {
    var s = '';
    for (var i = 0; i < len; i++) s += String.fromCharCode(bytes[off + i]);
    return s;
  }
  function trimNull(s) {
    var i = s.indexOf('\u0000');
    if (i >= 0) s = s.substring(0, i);
    return s.replace(/\s+$/, '');
  }

  /**
   * Parse the whole SF2 file. Throws on structural errors (caller should
   * catch and surface a friendly message). pcm slices are copied so the
   * source ArrayBuffer can be released by the caller.
   */
  function parse(bin) {
    if (!bin || bin.byteLength < 12) throw new Error('Not a SoundFont file (too small)');
    var bytes = new Uint8Array(bin);
    var dv = new DataView(bin);
    if (readString(bytes, 0, 4) !== 'RIFF') throw new Error('Not a RIFF file');
    if (readString(bytes, 8, 4) !== 'sfbk') throw new Error('Not a SoundFont (missing sfbk)');

    // Pull the list chunks (sdta + pdta) out of the top level.
    var sdta = null;   // { smpl: Uint8Array }
    var pdta = null;   // { chunkId: { off, size } }
    var pos = 12;
    while (pos + 8 <= bytes.length) {
      var id = readString(bytes, pos, 4);
      var size = dv.getUint32(pos + 4, true);
      var body = pos + 8;
      var end = body + size;
      if (id === 'LIST' && body + 4 <= bytes.length) {
        var listType = readString(bytes, body, 4);
        var sub = body + 4;
        if (listType === 'sdta') {
          sdta = { smpl: null };
          while (sub + 8 <= end) {
            var sid = readString(bytes, sub, 4);
            var ssize = dv.getUint32(sub + 4, true);
            if (sid === 'smpl') sdta.smpl = new Uint8Array(bytes.buffer, bytes.byteOffset + sub + 8, ssize);
            sub += 8 + ssize;
            if (ssize % 2) sub += 1;
          }
        } else if (listType === 'pdta') {
          pdta = {};
          while (sub + 8 <= end) {
            var pid = readString(bytes, sub, 4);
            var psize = dv.getUint32(sub + 4, true);
            pdta[pid] = { off: sub + 8, size: psize };
            sub += 8 + psize;
            if (psize % 2) sub += 1;
          }
        }
      }
      pos = end + (size % 2); // RIFF chunks are word aligned
    }

    if (!sdta || !sdta.smpl) throw new Error('SoundFont has no sample data (smpl)');
    if (!pdta) throw new Error('SoundFont has no preset data (pdta)');

    // ── Sample headers (shdr) ──
    var shdr = pdta.shdr ? pdta.shdr : null;
    if (!shdr) throw new Error('SoundFont has no sample headers (shdr)');
    var sampleHeaders = [];
    var shdrN = Math.floor(shdr.size / 46);
    for (var s = 0; s < shdrN; s++) {
      var so = shdr.off + s * 46;
      sampleHeaders.push({
        name: trimNull(readString(bytes, so, 20)),
        start: dv.getUint32(so + 20, true),     // in sample frames
        end: dv.getUint32(so + 24, true),
        startLoop: dv.getUint32(so + 28, true),
        endLoop: dv.getUint32(so + 32, true),
        sampleRate: dv.getUint32(so + 36, true),
        originalKey: bytes[so + 40],
        pitchCorrection: bytes[so + 41],
        sampleType: dv.getUint16(so + 44, true)
      });
    }

    // ── Preset headers (phdr) ──
    var phdr = pdta.phdr ? pdta.phdr : null;
    var presetHeaders = [];
    if (phdr) {
      var phN = Math.floor(phdr.size / 38);
      for (var p = 0; p < phN; p++) {
        var po = phdr.off + p * 38;
        presetHeaders.push({
          name: trimNull(readString(bytes, po, 20)),
          preset: dv.getUint16(po + 20, true),
          bank: dv.getUint16(po + 22, true),
          bagIndex: dv.getUint16(po + 24, true)
        });
      }
      // Drop the terminal EOP preset.
      if (presetHeaders.length && /^EOP/.test(presetHeaders[presetHeaders.length - 1].name)) {
        presetHeaders.pop();
      }
    }

    // ── Preset bags (pbag) + generators (pgen) ──
    var pbag = pdta.pbag ? pdta.pbag : null;
    var pgen = pdta.pgen ? pdta.pgen : null;

    // Helper: gens[i].genIndex .. gens[i+1].genIndex slice for bags.
    function bagGens(bags, bagIdx, gensArr) {
      var lo = bags[bagIdx].genIndex;
      var hi = (bagIdx + 1 < bags.length) ? bags[bagIdx + 1].genIndex : gensArr.length;
      if (lo >= gensArr.length) return [];
      return gensArr.slice(lo, Math.min(hi, gensArr.length));
    }

    // ── Zones per preset: walk pbag → instrument gen (41) + key/vel ranges ──
    var presets = [];
    for (var pi = 0; pi < presetHeaders.length; pi++) {
      var ph = presetHeaders[pi];
      var zones = [];
      var bagLo = ph.bagIndex;
      var bagHi = (pi + 1 < presetHeaders.length)
        ? presetHeaders[pi + 1].bagIndex
        : (pbag ? Math.floor(pbag.size / 4) : bagLo);

      for (var bi = bagLo; bi < bagHi; bi++) {
        if (!pbag) break;
        var gens = [];
        if (pgen) gens = bagGens(readBagsRaw(pbag), bi, readGensRaw(pgen));
        if (!gens.length) continue;
        var instId = null;
        var keyLo = null, keyHi = null, velLo = null, velHi = null;
        for (var gi = 0; gi < gens.length; gi++) {
          var g = gens[gi];
          if (g.op === GEN_INSTRUMENT) instId = g.amount;
          else if (g.op === GEN_KEYRANGE) {
            keyLo = g.amount & 0xFF;
            keyHi = (g.amount >> 8) & 0xFF;
          } else if (g.op === GEN_VELRANGE) {
            velLo = g.amount & 0xFF;
            velHi = (g.amount >> 8) & 0xFF;
          }
        }
        if (instId == null) continue; // global preset zone — no sample
        zones = zones.concat(
          instrumentZones(instId, keyLo, keyHi, velLo, velHi, dv, bytes, pdta));
      }

      if (!zones.length && sampleHeaders.length) {
        // Fallback: single zone over the full range on the first sample
        // (mirrors the old sfextract behaviour so even oddly-shaped fonts
        // still make a sound).
        zones.push({
          keyLo: 0, keyHi: 127, velLo: 0, velHi: 127,
          rootKey: sampleHeaders[0].originalKey || 60,
          sampleIndex: 0
        });
      }
      presets.push({
        name: ph.name || 'Preset ' + pi,
        bank: ph.bank || 0,
        program: ph.preset || 0,
        zones: zones
      });
    }

    // ── Build samples list from shdr (copying PCM out of smpl) ──
    var samples = [];
    for (var ss = 0; ss < sampleHeaders.length; ss++) {
      var sh = sampleHeaders[ss];
      var pcm = readSamplePcm(bytes, sdta.smpl, sh);
      samples.push({
        index: ss,
        name: sh.name,
        sampleRate: sh.sampleRate || 44100,
        originalKey: sh.originalKey || 60,
        pcm: pcm,
        ogg: !!(pcm && pcm.length >= 4 &&
                String.fromCharCode(pcm[0], pcm[1], pcm[2], pcm[3]) === 'OggS')
      });
    }

    return {
      name: (presets[0] && presets[0].name) || 'Unnamed SoundFont',
      presets: presets,
      samples: samples
    };
  }

  // Read pbag/pgen into plain arrays once (avoid DataView juggling).
  function readBagsRaw(chunk) {
    var n = Math.floor(chunk.size / 4);
    var arr = [];
    var dv2 = new DataView(chunk.buffer, chunk.byteOffset, chunk.size);
    for (var i = 0; i < n; i++) {
      arr.push({ genIndex: dv2.getUint16(i * 4, true), modIndex: dv2.getUint16(i * 4 + 2, true) });
    }
    return arr;
  }
  function readGensRaw(chunk) {
    var n = Math.floor(chunk.size / 4);
    var arr = [];
    var dv2 = new DataView(chunk.buffer, chunk.byteOffset, chunk.size);
    for (var i = 0; i < n; i++) {
      arr.push({ op: dv2.getUint16(i * 4, true), amount: dv2.getInt16(i * 4 + 2, true) });
    }
    return arr;
  }

  /**
   * Zones belonging to an instrument (inst → ibag → igen), each mapping
   * to a sample with a key/vel range and root key. Upper 'frame' ranges
   * come from the preset zone; instrument ranges are merged by
   * intersection (default full).
   */
  function instrumentZones(instId, pKeyLo, pKeyHi, pVelLo, pVelHi,
                           dv, bytes, pdta) {
    var inst = pdta.inst ? pdta.inst : null;
    var ibag = pdta.ibag ? pdta.ibag : null;
    var igen = pdta.igen ? pdta.igen : null;
    var out = [];
    if (!inst || !ibag || !igen) return out;

    var instN = Math.floor(inst.size / 22);
    if (instId < 0 || instId >= instN) return out;
    var io = inst.off + instId * 22;
    var iBagIndex = dv.getUint16(io + 20, true);

    var ibags = readBagsRaw(ibag);
    var igens = readGensRaw(igen);
    var iBagHi = (instId + 1 < instN)
      ? dv.getUint16(inst.off + (instId + 1) * 22 + 20, true)
      : ibags.length;

    for (var bi = iBagIndex; bi < iBagHi; bi++) {
      var lo = ibags[bi] ? ibags[bi].genIndex : 0;
      var hi = (bi + 1 < ibags.length) ? ibags[bi + 1].genIndex : igens.length;
      if (lo >= igens.length) continue;
      var gens = igens.slice(lo, Math.min(hi, igens.length));
      var sampleId = null, iKeyLo = null, iKeyHi = null, iVelLo = null, iVelHi = null, iRoot = null;
      for (var gi = 0; gi < gens.length; gi++) {
        var g = gens[gi];
        if (g.op === GEN_SAMPLEID) sampleId = g.amount & 0xFFFF;
        else if (g.op === GEN_KEYRANGE) {
          iKeyLo = g.amount & 0xFF;
          iKeyHi = (g.amount >> 8) & 0xFF;
        } else if (g.op === GEN_VELRANGE) {
          iVelLo = g.amount & 0xFF;
          iVelHi = (g.amount >> 8) & 0xFF;
        } else if (g.op === GEN_ROOTKEY) iRoot = g.amount & 0xFF;
      }
      if (sampleId == null) continue; // instrument global zone
      var kLo = Math.max(pKeyLo != null ? pKeyLo : 0, iKeyLo != null ? iKeyLo : 0);
      var kHi = Math.min(pKeyHi != null ? pKeyHi : 127, iKeyHi != null ? iKeyHi : 127);
      var vLo = Math.max(pVelLo != null ? pVelLo : 0, iVelLo != null ? iVelLo : 0);
      var vHi = Math.min(pVelHi != null ? pVelHi : 127, iVelHi != null ? iVelHi : 127);
      if (kLo > kHi || vLo > vHi) continue;
      out.push({
        keyLo: kLo, keyHi: kHi, velLo: vLo, velHi: vHi,
        rootKey: iRoot != null ? iRoot : null, // resolved after we know the sample
        sampleIndex: sampleId
      });
    }
    return out;
  }

  /** Copy the PCM frames [start,end) for one sample header out of smpl.
   *  SF3 fonts carry Ogg bytes here — copied verbatim, flag set upstream. */
  function readSamplePcm(bytes, smpl, sh) {
    if (!smpl) return null;
    var byteStart = sh.start * 2;
    var byteEnd = sh.end * 2;
    if (byteStart >= byteEnd) return null;
    // Copy (clone) so we don't pin the whole font buffer.
    var length = byteEnd - byteStart;
    var sliceOffset = bytes.byteOffset + smpl.byteOffset + byteStart;
    // smpl is a Uint8Array view on `bin`; slice gives a copy.
    return new Uint8Array(new Uint8Array(bytes.buffer, sliceOffset, length));
  }

  /** Build a mono 16-bit WAV ArrayBuffer from raw PCM for decodeAudioData. */
  function pcm16ToWav(pcm, sampleRate) {
    var n = pcm.length;
    var ab = new ArrayBuffer(44 + n * 2);
    var dv = new DataView(ab);
    function w32(o, v) { dv.setUint32(o, v, true); }
    function w16(o, v) { dv.setUint16(o, v, true); }
    dv.setUint8(0, 82); dv.setUint8(1, 73); dv.setUint8(2, 70); dv.setUint8(3, 70); // RIFF
    w32(4, 36 + n * 2);
    dv.setUint8(8, 87); dv.setUint8(9, 65); dv.setUint8(10, 86); dv.setUint8(11, 69); // WAVE
    dv.setUint8(12, 102); dv.setUint8(13, 109); dv.setUint8(14, 116); dv.setUint8(15, 32); // 'fmt '
    w32(16, 16);          // fmt chunk size
    w16(20, 1);           // PCM
    w16(22, 1);           // mono
    w32(24, sampleRate || 44100);
    w32(28, (sampleRate || 44100) * 2);
    w16(32, 2);           // block align
    w16(34, 16);          // bits per sample
    dv.setUint8(36, 100); dv.setUint8(37, 97); dv.setUint8(38, 116); dv.setUint8(39, 97); // data
    w32(40, n * 2);
    for (var i = 0; i < n; i++) dv.setInt16(44 + i * 2, pcm[i], true);
    return ab;
  }

  return {
    parse: parse,
    pcm16ToWav: pcm16ToWav
  };
})();