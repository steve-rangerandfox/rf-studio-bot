/**
 * PPTX text replacement module — surgical ZIP patching.
 *
 * PPTX files are ZIP archives containing XML slides.
 * Each slide is at ppt/slides/slideN.xml.
 * Text is stored in <a:t> elements within <a:r> (run) elements.
 *
 * MEMORY-EFFICIENT: Instead of decompressing/recompressing the entire ZIP
 * (which uses ~5x memory), this module:
 *   1. Parses the ZIP central directory to find slide entries
 *   2. Decompresses only the slide XMLs (~100-500KB total)
 *   3. Modifies text in those slides
 *   4. Recompresses only the modified slides
 *   5. Rebuilds the ZIP by copying unmodified entries byte-for-byte
 *
 * Peak memory: ~2x input file size (original buffer + output buffer).
 * This allows processing 40MB+ PPTXs within Cloudflare Workers' 128MB limit.
 */

import { inflateSync, deflateSync } from "fflate";

/* ─── ZIP format constants ─── */
const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

/**
 * Modify text in a PPTX file using surgical ZIP patching.
 *
 * @param {ArrayBuffer} pptxBuffer — raw PPTX bytes
 * @param {object} opts
 * @param {Array<{client:string, project:string}>} opts.selectedWork
 * @param {Array<{client:string, project:string}>} opts.masterWork
 * @param {object} [opts.cover] — { month, day, year }
 * @param {object} [opts.masterCover] — { month, day, year }
 * @returns {Uint8Array} modified PPTX bytes
 */
export function modifyPptxText(pptxBuffer, opts) {
  const { selectedWork, masterWork, cover, masterCover } = opts;
  const data = new Uint8Array(
    pptxBuffer instanceof ArrayBuffer ? pptxBuffer : pptxBuffer.buffer
  );
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // ── Parse ZIP structure ──
  const eocdOffset = findEOCD(data, view);
  if (eocdOffset === -1) throw new Error("Not a valid ZIP file");

  const cdOffset = view.getUint32(eocdOffset + 16, true);
  const numEntries = view.getUint16(eocdOffset + 10, true);

  // Parse central directory
  const entries = parseCentralDirectory(data, view, cdOffset, numEntries);

  // ── Find and modify slide XMLs ──
  const modifications = {}; // entryIndex → { compressed, uncompressedSize, crc32 }

  for (let idx = 0; idx < entries.length; idx++) {
    const entry = entries[idx];
    if (!entry.name.match(/^ppt\/slides\/slide\d+\.xml$/)) continue;

    // Read compressed data from the local file entry
    const localNameLen = view.getUint16(entry.localOffset + 26, true);
    const localExtraLen = view.getUint16(entry.localOffset + 28, true);
    const dataStart = entry.localOffset + 30 + localNameLen + localExtraLen;
    const compressed = data.subarray(dataStart, dataStart + entry.compressedSize);

    // Decompress slide XML
    let xmlBytes;
    if (entry.compression === 0) {
      xmlBytes = compressed;
    } else if (entry.compression === 8) {
      xmlBytes = inflateSync(compressed);
    } else {
      continue; // skip unsupported compression
    }

    let xml = new TextDecoder().decode(xmlBytes);
    let modified = false;

    // Selected Work slide
    if (xml.includes(">SELECTED WORK<") && masterWork && selectedWork) {
      xml = replaceSelectedWork(xml, masterWork, selectedWork);
      modified = true;
    }

    // Cover slide
    if (xml.includes(">CAPABILITIES<") && cover && masterCover) {
      xml = replaceCoverFields(xml, masterCover, cover);
      modified = true;
    }

    if (modified) {
      const newBytes = new TextEncoder().encode(xml);
      const newCompressed = deflateSync(newBytes, { level: 6 });
      modifications[idx] = {
        compressed: newCompressed,
        uncompressedSize: newBytes.length,
        crc32: crc32(newBytes),
      };
    }
  }

  if (Object.keys(modifications).length === 0) return data; // nothing changed

  // ── Rebuild ZIP with modified entries ──
  return rebuildZip(data, view, entries, modifications, eocdOffset);
}

/* ─── ZIP rebuilding ─── */

function rebuildZip(data, view, entries, modifications, eocdOffset) {
  // Calculate new size: original size + size deltas from modifications
  let sizeDelta = 0;
  for (const [idxStr, mod] of Object.entries(modifications)) {
    const entry = entries[parseInt(idxStr)];
    sizeDelta += mod.compressed.length - entry.compressedSize;
  }

  const output = new Uint8Array(data.length + sizeDelta);
  let writePos = 0;

  // Track new local header offsets for central directory
  const newLocalOffsets = new Array(entries.length);

  // ── Write local file entries ──
  for (let idx = 0; idx < entries.length; idx++) {
    const entry = entries[idx];
    newLocalOffsets[idx] = writePos;

    const localNameLen = view.getUint16(entry.localOffset + 26, true);
    const localExtraLen = view.getUint16(entry.localOffset + 28, true);
    const headerSize = 30 + localNameLen + localExtraLen;
    const dataStart = entry.localOffset + headerSize;

    if (modifications[idx]) {
      const mod = modifications[idx];

      // Copy local file header
      output.set(data.subarray(entry.localOffset, entry.localOffset + headerSize), writePos);

      // Patch the header with new sizes and CRC
      const hv = new DataView(output.buffer, output.byteOffset, output.length);
      hv.setUint32(writePos + 14, mod.crc32, true);         // CRC-32
      hv.setUint32(writePos + 18, mod.compressed.length, true); // compressed size
      hv.setUint32(writePos + 22, mod.uncompressedSize, true);  // uncompressed size
      writePos += headerSize;

      // Write new compressed data
      output.set(mod.compressed, writePos);
      writePos += mod.compressed.length;
    } else {
      // Copy entire local entry (header + data) byte-for-byte
      const entrySize = headerSize + entry.compressedSize;
      output.set(data.subarray(entry.localOffset, entry.localOffset + entrySize), writePos);
      writePos += entrySize;
    }
  }

  // ── Write central directory ──
  const newCdOffset = writePos;

  for (let idx = 0; idx < entries.length; idx++) {
    const entry = entries[idx];

    // Copy original central directory entry
    output.set(
      data.subarray(entry.cdOffset, entry.cdOffset + entry.cdLength),
      writePos
    );

    // Patch with new local header offset
    const hv = new DataView(output.buffer, output.byteOffset, output.length);
    hv.setUint32(writePos + 42, newLocalOffsets[idx], true);

    // Patch sizes/CRC if modified
    if (modifications[idx]) {
      const mod = modifications[idx];
      hv.setUint32(writePos + 16, mod.crc32, true);
      hv.setUint32(writePos + 20, mod.compressed.length, true);
      hv.setUint32(writePos + 24, mod.uncompressedSize, true);
    }

    writePos += entry.cdLength;
  }

  const newCdSize = writePos - newCdOffset;

  // ── Write EOCD ──
  const eocdLen = data.length - eocdOffset; // includes any comment
  output.set(data.subarray(eocdOffset, eocdOffset + eocdLen), writePos);
  const hv = new DataView(output.buffer, output.byteOffset, output.length);
  hv.setUint32(writePos + 12, newCdSize, true);     // size of central directory
  hv.setUint32(writePos + 16, newCdOffset, true);    // offset of central directory
  writePos += eocdLen;

  return output.subarray(0, writePos);
}

/* ─── ZIP parsing helpers ─── */

function findEOCD(data, view) {
  // Search backwards for EOCD signature (handles ZIP comments up to 64KB)
  const searchStart = Math.max(0, data.length - 65557);
  for (let i = data.length - 22; i >= searchStart; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) return i;
  }
  return -1;
}

function parseCentralDirectory(data, view, cdOffset, numEntries) {
  const entries = [];
  let pos = cdOffset;

  for (let i = 0; i < numEntries; i++) {
    if (view.getUint32(pos, true) !== SIG_CENTRAL) break;

    const compression = view.getUint16(pos + 10, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localOffset = view.getUint32(pos + 42, true);
    const name = new TextDecoder().decode(data.subarray(pos + 46, pos + 46 + nameLen));

    const cdLength = 46 + nameLen + extraLen + commentLen;

    entries.push({
      name,
      compression,
      compressedSize,
      localOffset,
      cdOffset: pos,
      cdLength,
    });

    pos += cdLength;
  }

  return entries;
}

/* ─── CRC-32 ─── */

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/* ─── Text replacement helpers ─── */

function replaceSelectedWork(xml, masterWork, selectedWork) {
  for (let i = 0; i < masterWork.length; i++) {
    const mw = masterWork[i];
    if (!mw.client && !mw.project) continue;

    const sw = i < selectedWork.length ? selectedWork[i] : { client: "", project: "" };

    if (mw.client) {
      xml = replaceAtText(xml, mw.client, sw.client || " ");
    }
    if (mw.project) {
      xml = replaceAtText(xml, mw.project, sw.project || " ");
    }
  }
  return xml;
}

function replaceCoverFields(xml, masterCover, cover) {
  if (masterCover.month && cover.month) {
    xml = replaceAtText(xml, masterCover.month, cover.month || " ");
  }
  if (masterCover.day && cover.day) {
    xml = replaceAtText(xml, masterCover.day, cover.day || " ");
  }
  if (masterCover.year && cover.year) {
    xml = replaceAtTextAll(xml, masterCover.year, cover.year || " ");
  }
  return xml;
}

function replaceAtText(xml, oldText, newText) {
  const escapedForRegex = escapeRegex(escapeXml(oldText));
  const regex = new RegExp(`(<a:t[^>]*>)${escapedForRegex}(</a:t>)`);
  const match = xml.match(regex);
  if (!match) return xml;
  return xml.slice(0, match.index) + match[1] + escapeXml(newText) + match[2] + xml.slice(match.index + match[0].length);
}

function replaceAtTextAll(xml, oldText, newText) {
  const escapedForRegex = escapeRegex(escapeXml(oldText));
  const regex = new RegExp(`(<a:t[^>]*>)${escapedForRegex}(</a:t>)`, "g");
  return xml.replace(regex, (_, open, close) => open + escapeXml(newText) + close);
}

function escapeXml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
