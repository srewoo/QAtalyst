/**
 * document-extractor.js (F24) — real text extraction for attached specs.
 *
 * The previous implementation ran a regex over RAW PDF bytes looking for
 * `(text)Tj` operators. Almost every real PDF compresses its content streams
 * with FlateDecode, so that regex matched nothing on ordinary documents — and
 * the code then declared the file "scanned" and returned base64. Its caller kept
 * only results with non-empty text, so the base64 fallback was never delivered
 * either: a requirement living in an attached PDF reached nothing, silently.
 * DOCX was rejected outright with "requires a zip parser".
 *
 * Chrome MV3 provides DecompressionStream, so both are solvable with no
 * dependency: 'deflate' inflates PDF FlateDecode streams, 'deflate-raw' inflates
 * ZIP members, which is all a DOCX is.
 *
 * Every path reports an explicit status instead of collapsing to "no text":
 *   extracted | no_text_layer | encrypted | unsupported | parse_failed
 * so the UI can say which attachment could not be read, and why.
 *
 * ponytail: text extraction only. No font/CMap mapping (so a PDF using a
 * non-standard encoding can yield mojibake), no OCR, no layout reconstruction.
 * Upgrade path is a packaged pdf.js or an external processing service — this
 * module is the seam. Pure except for DecompressionStream; unit-testable.
 */
(function () {

const MAX_TEXT = 40000;      // per document, after extraction
const MAX_BYTES = 25 * 1024 * 1024;

/** Inflate bytes with the platform's DecompressionStream. Returns null on failure. */
async function inflate(bytes, format) {
  if (typeof DecompressionStream === 'undefined') return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (_) {
    return null;
  }
}

/** Base64 without spreading a multi-megabyte array into function arguments. */
function toBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// ───────────────────────────── PDF ─────────────────────────────

/** Decode a PDF string literal, resolving escapes and \\ooo octal codes. */
function decodePdfString(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '\\') { out += c; continue; }
    const n = raw[++i];
    if (n === undefined) break;
    if (n === 'n') out += '\n';
    else if (n === 'r') out += '\r';
    else if (n === 't') out += '\t';
    else if (n === 'b') out += '\b';
    else if (n === 'f') out += '\f';
    else if (n >= '0' && n <= '7') {
      let oct = n;
      while (oct.length < 3 && raw[i + 1] >= '0' && raw[i + 1] <= '7') oct += raw[++i];
      out += String.fromCharCode(parseInt(oct, 8));
    } else out += n; // \( \) \\ and any other escaped literal
  }
  return out;
}

/**
 * Pull readable text out of a decoded PDF content stream.
 * Handles Tj, TJ arrays, ' and " (next-line show-text), and hex <...> strings.
 */
function textFromContentStream(content) {
  const parts = [];
  // (literal) Tj | ' | "   and   [ (a) -250 (b) ] TJ
  const re = /\((?:[^()\\]|\\.)*\)|<[0-9A-Fa-f\s]*>|\bT[Jj]\b|\bTd\b|\bTD\b|\bT\*\b|'|"/g;
  let m, pending = [];
  while ((m = re.exec(content)) !== null) {
    const tok = m[0];
    if (tok.startsWith('(')) {
      pending.push(decodePdfString(tok.slice(1, -1)));
    } else if (tok.startsWith('<')) {
      // Hex string: pairs of hex digits → char codes.
      const hex = tok.slice(1, -1).replace(/\s+/g, '');
      let s = '';
      for (let i = 0; i + 1 < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
      pending.push(s);
    } else if (tok === 'TJ' || tok === 'Tj' || tok === "'" || tok === '"') {
      if (pending.length) { parts.push(pending.join('')); pending = []; }
      if (tok === "'" || tok === '"') parts.push('\n');
    } else if (tok === 'Td' || tok === 'TD' || tok === 'T*') {
      if (pending.length) { parts.push(pending.join('')); pending = []; }
      parts.push('\n');
    }
  }
  if (pending.length) parts.push(pending.join(''));
  return parts.join('');
}

/** Byte offsets of every `stream`…`endstream` payload, with its preceding dict. */
function findPdfStreams(latin1) {
  const out = [];
  const re = /stream\r?\n?/g;
  let m;
  while ((m = re.exec(latin1)) !== null) {
    const start = m.index + m[0].length;
    const end = latin1.indexOf('endstream', start);
    if (end < 0) continue;
    // The object dictionary sits immediately before the `stream` keyword.
    const dict = latin1.slice(Math.max(0, m.index - 600), m.index);
    out.push({ dict, start, end });
    re.lastIndex = end;
  }
  return out;
}

async function extractPdf(bytes) {
  const latin1 = new TextDecoder('latin1').decode(bytes);

  if (/\/Encrypt\b/.test(latin1)) {
    return { status: 'encrypted', text: '',
      note: 'The PDF is encrypted or password-protected; its text could not be read.' };
  }

  const streams = findPdfStreams(latin1);
  const chunks = [];
  let inflated = 0, rawStreams = 0, failed = 0;

  for (const s of streams) {
    const isFlate = /\/FlateDecode/.test(s.dict);
    // Streams that aren't page content (images, fonts, metadata) waste time.
    const isImage = /\/Subtype\s*\/Image|\/DCTDecode|\/JPXDecode|\/CCITTFaxDecode/.test(s.dict);
    if (isImage) continue;

    let content = null;
    if (isFlate) {
      const slice = bytes.subarray(s.start, s.end);
      const out = await inflate(slice, 'deflate');
      if (out) { content = new TextDecoder('latin1').decode(out); inflated++; }
      else failed++;
    } else if (!/\/Filter/.test(s.dict)) {
      content = latin1.slice(s.start, s.end);
      rawStreams++;
    }
    if (!content) continue;

    const text = textFromContentStream(content);
    if (text && text.trim().length > 1) chunks.push(text);
  }

  const text = chunks.join('\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  if (text.length > 20) {
    return { status: 'extracted', text: text.slice(0, MAX_TEXT),
      note: `Extracted from ${inflated + rawStreams} content stream(s).` };
  }

  // F24: do NOT call it "scanned" merely because extraction found nothing. Say
  // what actually happened, and distinguish "decoded fine, no text operators"
  // (genuinely image-only) from "could not decode the streams" (our limitation).
  if (failed > 0 && inflated === 0) {
    return { status: 'parse_failed', text: '', pageStreams: streams.length,
      note: `Found ${streams.length} stream(s) but could not decompress ${failed} of them — the PDF may use an unsupported filter.` };
  }
  return { status: 'no_text_layer', text: '', pageStreams: streams.length,
    note: streams.length
      ? 'The PDF contains no extractable text layer — it is most likely a scan or image-only export.'
      : 'No content streams were found in the PDF.' };
}

// ───────────────────────────── ZIP / DOCX ─────────────────────────────

function readU16(b, o) { return b[o] | (b[o + 1] << 8); }
function readU32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

/** Locate and list the members of a ZIP archive via its central directory. */
function readZipEntries(bytes) {
  // End of Central Directory: scan backwards for 0x06054b50.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 66000; i--) {
    if (readU32(bytes, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;

  const count = readU16(bytes, eocd + 10);
  let ptr = readU32(bytes, eocd + 16);
  const entries = [];
  for (let i = 0; i < count && ptr + 46 <= bytes.length; i++) {
    if (readU32(bytes, ptr) !== 0x02014b50) break;
    const method = readU16(bytes, ptr + 10);
    const compSize = readU32(bytes, ptr + 20);
    const nameLen = readU16(bytes, ptr + 28);
    const extraLen = readU16(bytes, ptr + 30);
    const commentLen = readU16(bytes, ptr + 32);
    const localOffset = readU32(bytes, ptr + 42);
    const name = new TextDecoder('utf-8').decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
    entries.push({ name, method, compSize, localOffset });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Raw bytes of one ZIP member, inflating when it is deflated. */
async function readZipEntry(bytes, entry) {
  const lo = entry.localOffset;
  if (readU32(bytes, lo) !== 0x04034b50) return null;
  const nameLen = readU16(bytes, lo + 26);
  const extraLen = readU16(bytes, lo + 28);
  const dataStart = lo + 30 + nameLen + extraLen;
  const data = bytes.subarray(dataStart, dataStart + entry.compSize);
  if (entry.method === 0) return data;              // stored
  if (entry.method === 8) return await inflate(data, 'deflate-raw');
  return null;                                       // unsupported method
}

/** Office XML → text, preserving paragraph and table-cell boundaries. */
function officeXmlToText(xml) {
  return xml
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:br\b[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/w:tc>/g, '\t')
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function extractDocx(bytes) {
  const entries = readZipEntries(bytes);
  if (!entries) {
    return { status: 'parse_failed', text: '', note: 'The file is not a readable ZIP/DOCX archive.' };
  }
  // Main body first, then headers/footers/footnotes — requirements hide there too.
  const wanted = entries.filter(e =>
    e.name === 'word/document.xml' ||
    /^word\/(header|footer|footnotes|endnotes)\d*\.xml$/.test(e.name));
  if (!wanted.length) {
    return { status: 'unsupported', text: '',
      note: `Archive has no word/document.xml (found ${entries.length} entries) — not a Word document.` };
  }

  const parts = [];
  for (const entry of wanted.sort((a, b) => (a.name === 'word/document.xml' ? -1 : 1))) {
    const raw = await readZipEntry(bytes, entry);
    if (!raw) continue;
    parts.push(officeXmlToText(new TextDecoder('utf-8').decode(raw)));
  }
  const text = parts.filter(Boolean).join('\n\n').trim();
  return text
    ? { status: 'extracted', text: text.slice(0, MAX_TEXT), note: `Extracted from ${wanted.length} document part(s).` }
    : { status: 'no_text_layer', text: '', note: 'The document contains no extractable text.' };
}

// ───────────────────────────── entry point ─────────────────────────────

/**
 * @param {ArrayBuffer|Uint8Array} buffer raw file bytes
 * @param {string} fileName
 * @param {string} [contentType]
 * @returns {Promise<{status, text, fileName, type, note, base64?, mimeType?}>}
 */
async function extractDocument(buffer, fileName, contentType = '') {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const ext = String(fileName || '').split('.').pop().toLowerCase();
  const base = { fileName, type: ext };

  if (bytes.length > MAX_BYTES) {
    return { ...base, status: 'unsupported', text: '',
      note: `File is ${(bytes.length / 1048576).toFixed(1)} MB — above the ${MAX_BYTES / 1048576} MB extraction limit.` };
  }

  try {
    if (['txt', 'md', 'csv', 'log', 'json', 'xml', 'yaml', 'yml'].includes(ext) || contentType.includes('text/')) {
      const text = new TextDecoder('utf-8').decode(bytes).slice(0, MAX_TEXT);
      return { ...base, status: text.trim() ? 'extracted' : 'no_text_layer', text, type: 'text' };
    }

    if (ext === 'pdf' || contentType.includes('pdf')) {
      const r = await extractPdf(bytes);
      // Only an image-only PDF is worth handing to a vision model.
      if (r.status === 'no_text_layer') {
        return { ...base, ...r, type: 'pdf', base64: toBase64(bytes), mimeType: 'application/pdf' };
      }
      return { ...base, ...r, type: 'pdf' };
    }

    if (ext === 'docx' || contentType.includes('wordprocessingml')) {
      return { ...base, ...(await extractDocx(bytes)), type: 'docx' };
    }

    if (ext === 'doc') {
      return { ...base, status: 'unsupported', text: '',
        note: 'Legacy .doc (binary Word 97) is not supported — save as .docx or PDF.' };
    }

    return { ...base, status: 'unsupported', text: '', note: `Unsupported document type: .${ext}` };
  } catch (e) {
    return { ...base, status: 'parse_failed', text: '', note: `Extraction failed: ${e.message}` };
  }
}

const api = { extractDocument, extractPdf, extractDocx, officeXmlToText, textFromContentStream,
              decodePdfString, readZipEntries, toBase64 };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof self !== 'undefined') Object.assign(self, api);
})();
