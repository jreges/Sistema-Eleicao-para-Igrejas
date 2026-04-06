/**
 * Minimal XLSX builder — pure Node.js, zero dependencies.
 * Builds a spec-compliant .xlsx (OOXML) file in memory.
 *
 * Fixes vs previous version:
 *  - sheetFormatPr now appears BEFORE sheetData (required by OOXML strict)
 *  - sheetView element added (required by some validators)
 *  - All strings pass through xmlSafe() which strips invalid XML 1.0 chars
 *  - Multi-letter column addresses (AA, AB, etc.) supported
 *  - Relationship IDs are stable and correctly ordered
 */
'use strict';
const zlib = require('zlib');

// ── CRC32 ──────────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ── Little-endian helpers ──────────────────────────────────────────────────────
function le16(n) { const b = Buffer.allocUnsafe(2); b.writeUInt16LE(n & 0xFFFF, 0); return b; }
function le32(n) { const b = Buffer.allocUnsafe(4); b.writeUInt32LE(n >>> 0, 0); return b; }

// ── ZIP builder ───────────────────────────────────────────────────────────────
function zipFile(files) {
  const entries = [], parts = [];
  let offset = 0;
  for (const f of files) {
    const name     = Buffer.from(f.name, 'utf8');
    const data     = f.data;
    const crc      = crc32(data);
    const comp     = zlib.deflateRawSync(data, { level: 6 });
    const useDefl  = comp.length < data.length;
    const compData = useDefl ? comp : data;
    const method   = useDefl ? 8 : 0;
    const lhdr = Buffer.concat([
      Buffer.from([0x50,0x4B,0x03,0x04]),
      le16(20), le16(0), le16(method), le16(0), le16(0),
      le32(crc), le32(compData.length), le32(data.length),
      le16(name.length), le16(0),
    ]);
    parts.push(lhdr, name, compData);
    entries.push({ name, crc, method, compSize: compData.length, uncompSize: data.length, offset });
    offset += lhdr.length + name.length + compData.length;
  }
  const cdParts = [];
  for (const e of entries) {
    cdParts.push(Buffer.concat([
      Buffer.from([0x50,0x4B,0x01,0x02]),
      le16(20), le16(20), le16(0), le16(e.method), le16(0), le16(0),
      le32(e.crc), le32(e.compSize), le32(e.uncompSize),
      le16(e.name.length), le16(0), le16(0), le16(0), le16(0), le32(0), le32(e.offset),
    ]), e.name);
  }
  const cd = Buffer.concat(cdParts);
  return Buffer.concat([
    ...parts, cd,
    Buffer.concat([
      Buffer.from([0x50,0x4B,0x05,0x06]),
      le16(0), le16(0),
      le16(entries.length), le16(entries.length),
      le32(cd.length), le32(offset), le16(0),
    ]),
  ]);
}

// ── XML helpers ───────────────────────────────────────────────────────────────

// Remove characters invalid in XML 1.0:
// Valid: #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]
function xmlSafe(s) {
  return String(s == null ? '' : s).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g, '');
}

// Escape for XML text content and attribute values
function xe(s) {
  return xmlSafe(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Convert zero-based column index to Excel column letters (A, B, ..., Z, AA, AB, ...)
function colLetter(idx) {
  let s = '';
  idx++; // 1-based
  while (idx > 0) {
    idx--;
    s = String.fromCharCode(65 + (idx % 26)) + s;
    idx = Math.floor(idx / 26);
  }
  return s;
}

// ── XLSX builder ──────────────────────────────────────────────────────────────
/**
 * sheets = [{ name: 'Sheet1', rows: [[cell, ...], ...] }]
 * cell   = string | number | null |
 *          { v: value, bold?: bool, bg?: 'RRGGBB', color?: 'RRGGBB' }
 *
 * Built-in styles (by bg colour used in server.js):
 *   (none)   → normal text          styleIdx=0
 *   bold     → bold text            styleIdx=1
 *   4472C4   → blue header          styleIdx=2
 *   70AD47   → green elected        styleIdx=3
 */
function buildXLSX(sheets) {
  // ── Shared-string table ────────────────────────────────────────────────────
  const ssArr = [], ssMap = {};
  function si(raw) {
    const s = xmlSafe(String(raw == null ? '' : raw));
    if (ssMap[s] === undefined) { ssMap[s] = ssArr.length; ssArr.push(s); }
    return ssMap[s];
  }

  // ── Build worksheet XMLs ───────────────────────────────────────────────────
  const wsXmls = sheets.map(sheet => {
    const rows    = sheet.rows || [];
    const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0);

    // OOXML-compliant element order:
    // worksheet > sheetViews > sheetFormatPr > cols > sheetData
    let x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    x += '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">';

    // sheetViews (required by strict mode validators)
    x += '<sheetViews><sheetView tabSelected="1" workbookViewId="0"/></sheetViews>';

    // sheetFormatPr MUST come before sheetData
    x += '<sheetFormatPr defaultRowHeight="15" customHeight="1"/>';

    // cols – fixed width for readability
    if (maxCols > 0) {
      x += '<cols>';
      for (let c = 1; c <= maxCols; c++) {
        x += `<col min="${c}" max="${c}" width="24" bestFit="0" customWidth="1"/>`;
      }
      x += '</cols>';
    }

    // sheetData
    x += '<sheetData>';
    rows.forEach((row, ri) => {
      const rowNum = ri + 1;
      x += `<row r="${rowNum}">`;
      row.forEach((cell, ci) => {
        const addr  = colLetter(ci) + rowNum;
        const isObj = cell !== null && typeof cell === 'object';
        const val   = isObj ? cell.v : cell;
        const bold  = isObj && !!cell.bold;
        const bg    = isObj ? (cell.bg || '') : '';

        // Resolve style index
        let sIdx = 0;
        if      (bg === '4472C4') sIdx = 2;  // blue header
        else if (bg === '70AD47') sIdx = 3;  // green elected
        else if (bold)            sIdx = 1;  // plain bold

        if (val == null || val === '') {
          x += `<c r="${addr}" s="${sIdx}"/>`;
        } else if (typeof val === 'number') {
          x += `<c r="${addr}" s="${sIdx}"><v>${val}</v></c>`;
        } else {
          const idx = si(val);
          x += `<c r="${addr}" t="s" s="${sIdx}"><v>${idx}</v></c>`;
        }
      });
      x += '</row>';
    });
    x += '</sheetData>';
    x += '</worksheet>';
    return x;
  });

  // ── sharedStrings.xml ──────────────────────────────────────────────────────
  const ssXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${ssArr.length}" uniqueCount="${ssArr.length}">`,
    ...ssArr.map(s => `<si><t xml:space="preserve">${xe(s)}</t></si>`),
    '</sst>',
  ].join('');

  // ── styles.xml ─────────────────────────────────────────────────────────────
  // 4 fonts: normal, bold, bold-white (for coloured headers), normal
  // 5 fills: none, gray125 (required placeholders), blue, green, none
  // 1 border: none
  // 4 xfs: normal, bold, blue-header, green-elected
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="3">
  <font><sz val="11"/><name val="Calibri"/></font>
  <font><b/><sz val="11"/><name val="Calibri"/></font>
  <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
</fonts>
<fills count="4">
  <fill><patternFill patternType="none"/></fill>
  <fill><patternFill patternType="gray125"/></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FF4472C4"/><bgColor indexed="64"/></patternFill></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FF70AD47"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="1">
  <border><left/><right/><top/><bottom/><diagonal/></border>
</borders>
<cellStyleXfs count="1">
  <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
</cellStyleXfs>
<cellXfs count="4">
  <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
  <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0"/>
  <xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0"/>
  <xf numFmtId="0" fontId="2" fillId="3" borderId="0" xfId="0"/>
</cellXfs>
<cellStyles count="1">
  <cellStyle name="Normal" xfId="0" builtinId="0"/>
</cellStyles>
</styleSheet>`;

  // ── workbook.xml ───────────────────────────────────────────────────────────
  const wbXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"',
    '  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="16384" windowHeight="8192"/></bookViews>',
    '<sheets>',
    ...sheets.map((s, i) => `<sheet name="${xe(s.name)}" sheetId="${i+1}" r:id="rId${i+3}"/>`),
    '</sheets>',
    '</workbook>',
  ].join('');

  // ── workbook.xml.rels ──────────────────────────────────────────────────────
  // Stable layout: rId1=styles, rId2=sharedStrings, rId3..rId(N+2)=sheets
  const wbRels = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>',
    ...sheets.map((_, i) =>
      `<Relationship Id="rId${i+3}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`
    ),
    '</Relationships>',
  ].join('');

  // ── _rels/.rels ────────────────────────────────────────────────────────────
  const rootRels = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>',
    '</Relationships>',
  ].join('');

  // ── [Content_Types].xml ────────────────────────────────────────────────────
  const contentTypes = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>',
    ...sheets.map((_, i) =>
      `<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    ),
    '</Types>',
  ].join('');

  // ── Assemble ZIP ───────────────────────────────────────────────────────────
  const B = s => Buffer.from(s, 'utf8');
  const files = [
    { name: '[Content_Types].xml',         data: B(contentTypes) },
    { name: '_rels/.rels',                 data: B(rootRels)     },
    { name: 'xl/workbook.xml',             data: B(wbXml)        },
    { name: 'xl/_rels/workbook.xml.rels',  data: B(wbRels)       },
    { name: 'xl/styles.xml',               data: B(stylesXml)    },
    { name: 'xl/sharedStrings.xml',        data: B(ssXml)        },
    ...sheets.map((_, i) => ({
      name: `xl/worksheets/sheet${i+1}.xml`,
      data: B(wsXmls[i]),
    })),
  ];

  return zipFile(files);
}

module.exports = { buildXLSX };
