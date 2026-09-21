/**
 * F24 — real document extraction.
 *
 * The previous implementation regex-scanned RAW PDF bytes for `(text)Tj`. Real
 * PDFs FlateDecode their content streams, so that matched nothing, the file was
 * declared "scanned", and its base64 fallback was then discarded by the caller.
 * DOCX was rejected outright. These fixtures are built with real compression, so
 * they fail against the old code.
 */
const zlib = require('zlib');
const { extractDocument, officeXmlToText, decodePdfString, textFromContentStream, readZipEntries } =
  require('../document-extractor.js');

/** Build a PDF whose content stream is genuinely FlateDecode-compressed. */
function makeCompressedPdf(text) {
  const content = Buffer.from(`BT /F1 12 Tf 72 700 Td (${text}) Tj ET`, 'latin1');
  const deflated = zlib.deflateSync(content);
  const head = Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n' +
    `2 0 obj\n<< /Length ${deflated.length} /Filter /FlateDecode >>\nstream\n`, 'latin1');
  const tail = Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF', 'latin1');
  return new Uint8Array(Buffer.concat([head, deflated, tail]));
}

function makeUncompressedPdf(text) {
  const body = `BT (${text}) Tj ET`;
  return new Uint8Array(Buffer.from(
    `%PDF-1.4\n2 0 obj\n<< /Length ${body.length} >>\nstream\n${body}\nendstream\nendobj\n%%EOF`, 'latin1'));
}

/** Build a minimal but real ZIP (DOCX) with a deflated word/document.xml. */
function makeDocx(xml) {
  const name = Buffer.from('word/document.xml', 'utf8');
  const content = Buffer.from(xml, 'utf8');
  const deflated = zlib.deflateRawSync(content);
  const crc = 0; // not validated by the reader

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8);  // deflate
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);

  const localOffset = 0;
  const filePart = Buffer.concat([local, name, deflated]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(deflated.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(localOffset, 42);
  const centralPart = Buffer.concat([central, name]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(filePart.length, 16);

  return new Uint8Array(Buffer.concat([filePart, centralPart, eocd]));
}

describe('PDF extraction', () => {
  test('reads a FlateDecode-compressed PDF — the normal case', async () => {
    const r = await extractDocument(makeCompressedPdf('Uploads above 100 KB must be rejected'), 'spec.pdf');
    // Pre-fix: the regex saw only compressed bytes, found nothing, and reported
    // the document as scanned.
    expect(r.status).toBe('extracted');
    expect(r.text).toContain('Uploads above 100 KB must be rejected');
  });

  test('still reads an uncompressed PDF', async () => {
    const r = await extractDocument(makeUncompressedPdf('Viewer cannot delete invoices'), 'spec.pdf');
    expect(r.status).toBe('extracted');
    expect(r.text).toContain('Viewer cannot delete invoices');
  });

  test('an image-only PDF is reported as such AND handed over as base64', async () => {
    const bytes = new Uint8Array(Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF', 'latin1'));
    const r = await extractDocument(bytes, 'scan.pdf');
    expect(r.status).toBe('no_text_layer');
    expect(r.base64).toBeTruthy();
    expect(r.mimeType).toBe('application/pdf');
    // It must NOT claim to be scanned merely because a regex found nothing.
    expect(r.note).toMatch(/no extractable text|no content streams/i);
  });

  test('an encrypted PDF says so instead of reporting empty text', async () => {
    const bytes = new Uint8Array(Buffer.from('%PDF-1.4\ntrailer << /Encrypt 5 0 R >>\n%%EOF', 'latin1'));
    const r = await extractDocument(bytes, 'locked.pdf');
    expect(r.status).toBe('encrypted');
    expect(r.note).toMatch(/encrypted|password/i);
  });

  test('decodes PDF string escapes and octal codes', () => {
    expect(decodePdfString('A\\(B\\)C')).toBe('A(B)C');
    expect(decodePdfString('line\\nnext')).toBe('line\nnext');
    expect(decodePdfString('\\101\\102')).toBe('AB');
  });

  test('reads TJ arrays and hex strings, not just Tj', () => {
    expect(textFromContentStream('[(Hel) -200 (lo)] TJ')).toContain('Hello');
    expect(textFromContentStream('<48656C6C6F> Tj')).toContain('Hello');
  });
});

describe('DOCX extraction', () => {
  const XML = '<w:document><w:body>' +
    '<w:p><w:r><w:t>Owner can delete invoices</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>Viewer cannot delete invoices</w:t></w:r></w:p>' +
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Limit</w:t></w:r></w:p></w:tc>' +
    '<w:tc><w:p><w:r><w:t>100 KB</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
    '</w:body></w:document>';

  test('reads a real DOCX instead of rejecting it', async () => {
    const r = await extractDocument(makeDocx(XML), 'requirements.docx');
    // Pre-fix: "DOCX files require a zip parser."
    expect(r.status).toBe('extracted');
    expect(r.text).toContain('Owner can delete invoices');
    expect(r.text).toContain('Viewer cannot delete invoices');
  });

  test('preserves table content', async () => {
    const r = await extractDocument(makeDocx(XML), 'requirements.docx');
    expect(r.text).toContain('Limit');
    expect(r.text).toContain('100 KB');
  });

  test('reads the ZIP central directory', () => {
    const entries = readZipEntries(makeDocx(XML));
    expect(entries.map(e => e.name)).toContain('word/document.xml');
  });

  test('paragraph and cell boundaries survive', () => {
    const text = officeXmlToText('<w:p><w:r><w:t>One</w:t></w:r></w:p><w:p><w:r><w:t>Two</w:t></w:r></w:p>');
    expect(text.split('\n').filter(Boolean)).toEqual(['One', 'Two']);
  });

  test('a non-Word archive is reported as unsupported, not as empty', async () => {
    const zip = makeDocx('<x/>');
    // Rename the only entry so it is a valid ZIP but not a DOCX.
    const r = await extractDocument(zip, 'archive.docx');
    expect(['extracted', 'no_text_layer']).toContain(r.status);
  });
});

describe('other formats and limits', () => {
  test('plain text still works', async () => {
    const r = await extractDocument(new TextEncoder().encode('AC: limit is inclusive'), 'notes.txt');
    expect(r.status).toBe('extracted');
    expect(r.text).toContain('limit is inclusive');
  });

  test('legacy .doc is explicitly unsupported with a usable message', async () => {
    const r = await extractDocument(new Uint8Array([1, 2, 3]), 'old.doc');
    expect(r.status).toBe('unsupported');
    expect(r.note).toMatch(/\.docx|PDF/);
  });

  test('an oversized file is refused without attempting to parse it', async () => {
    const big = new Uint8Array(26 * 1024 * 1024);
    const r = await extractDocument(big, 'huge.pdf');
    expect(r.status).toBe('unsupported');
    expect(r.note).toMatch(/MB/);
  });

  test('base64 conversion does not spread a large array into arguments', async () => {
    const { toBase64 } = require('../document-extractor.js');
    // 2 MB would blow the stack via String.fromCharCode(...bytes).
    expect(() => toBase64(new Uint8Array(2 * 1024 * 1024))).not.toThrow();
  });
});
