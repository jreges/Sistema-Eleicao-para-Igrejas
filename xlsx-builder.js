/**
 * Minimal XLSX builder — pure Node.js, zero dependencies.
 * Builds a valid .xlsx file (ZIP + XML) in memory.
 */
'use strict';
const zlib = require('zlib');

// ── CRC32 ──
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

// ── Little-endian helpers ──
function le16(n) { const b = Buffer.allocUnsafe(2); b.writeUInt16LE(n, 0); return b; }
function le32(n) { const b = Buffer.allocUnsafe(4); b.writeUInt32LE(n >>> 0, 0); return b; }

// ── Build ZIP ──
function zipFile(files) {
  // files = [{name, data (Buffer)}]
  const entries = [];
  let offset = 0;

  const parts = [];
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = f.data;
    const crc  = crc32(data);
    const comp = zlib.deflateRawSync(data, { level: 6 });
    // Use stored if deflated is larger
    const useDeflate = comp.length < data.length;
    const compData   = useDeflate ? comp : data;
    const method     = useDeflate ? 8 : 0;

    // Local file header
    const lhdr = Buffer.concat([
      Buffer.from([0x50,0x4B,0x03,0x04]), // signature
      le16(20),           // version needed
      le16(0),            // flags
      le16(method),       // compression
      le16(0), le16(0),   // mod time, mod date
      le32(crc),
      le32(compData.length),
      le32(data.length),
      le16(name.length),
      le16(0),            // extra len
    ]);
    parts.push(lhdr, name, compData);

    entries.push({ name, crc, method, compSize: compData.length, uncompSize: data.length, offset });
    offset += lhdr.length + name.length + compData.length;
  }

  // Central directory
  const cdParts = [];
  for (const e of entries) {
    const cdhdr = Buffer.concat([
      Buffer.from([0x50,0x4B,0x01,0x02]), // signature
      le16(20), le16(20), le16(0),        // version made, needed, flags
      le16(e.method),
      le16(0), le16(0),   // mod time, date
      le32(e.crc),
      le32(e.compSize),
      le32(e.uncompSize),
      le16(e.name.length),
      le16(0), le16(0),   // extra, comment
      le16(0), le16(0),   // disk start, int attrs
      le32(0),            // ext attrs
      le32(e.offset),
    ]);
    cdParts.push(cdhdr, e.name);
  }
  const cd     = Buffer.concat(cdParts);
  const cdOffset = offset;

  // End of central directory
  const eocd = Buffer.concat([
    Buffer.from([0x50,0x4B,0x05,0x06]),
    le16(0), le16(0),
    le16(entries.length), le16(entries.length),
    le32(cd.length),
    le32(cdOffset),
    le16(0),
  ]);

  return Buffer.concat([...parts, cd, eocd]);
}

// ── XML escape ──
function xe(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}

// ── Build XLSX ──
/**
 * sheets = [{ name: 'Sheet1', rows: [[cell,...], ...] }]
 * cell = string | number | { v: value, bold?: bool, bg?: 'RRGGBB', color?: 'RRGGBB', wrap?: bool }
 */
function buildXLSX(sheets) {
  // Collect all unique styles
  // We'll use a simple fixed set: normal, bold, header (bold+bg), number
  // Style indices:
  // 0 = normal
  // 1 = bold
  // 2 = header (bold, bg=4472C4, color=FFFFFF)
  // 3 = number normal
  // 4 = bold green bg (elected)
  // 5 = center gray bg

  const sharedStrings = [];
  const ssMap = {};
  function si(s) {
    s = String(s == null ? '' : s);
    if (ssMap[s] === undefined) { ssMap[s] = sharedStrings.length; sharedStrings.push(s); }
    return ssMap[s];
  }

  // Build worksheet XML for each sheet
  const wsXmls = sheets.map(sheet => {
    const rows = sheet.rows;
    let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    xml += '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">';

    // Column widths
    const maxCols = Math.max(...rows.map(r => r.length));
    xml += '<cols>';
    for (let c = 1; c <= maxCols; c++) {
      xml += `<col min="${c}" max="${c}" width="22" bestFit="1" customWidth="1"/>`;
    }
    xml += '</cols>';

    xml += '<sheetData>';
    rows.forEach((row, ri) => {
      xml += `<row r="${ri+1}">`;
      row.forEach((cell, ci) => {
        const col = String.fromCharCode(65 + ci) + (ri+1);
        if (cell == null || cell === '') { xml += `<c r="${col}"/>`; return; }
        const isObj  = typeof cell === 'object';
        const val    = isObj ? cell.v : cell;
        const bold   = isObj && cell.bold;
        const bg     = isObj && cell.bg;
        const wrap   = isObj && cell.wrap;
        const isNum  = typeof val === 'number';

        let styleIdx = 0;
        if (bold && bg === '4472C4') styleIdx = 2;      // header
        else if (bold && bg === '70AD47') styleIdx = 4; // elected green
        else if (bold && bg === 'BDD7EE') styleIdx = 5; // light blue
        else if (bold) styleIdx = 1;
        else if (isNum) styleIdx = 3;

        if (isNum) {
          xml += `<c r="${col}" s="${styleIdx}"><v>${val}</v></c>`;
        } else {
          const idx = si(String(val));
          xml += `<c r="${col}" t="s" s="${styleIdx}"><v>${idx}</v></c>`;
        }
      });
      xml += '</row>';
    });
    xml += '</sheetData>';
    xml += '<sheetFormatPr defaultRowHeight="15"/>';
    xml += '</worksheet>';
    return xml;
  });

  // Shared strings XML
  const ssXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">
${sharedStrings.map(s => `<si><t xml:space="preserve">${xe(s)}</t></si>`).join('\n')}
</sst>`;

  // Styles XML
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="4">
  <font><sz val="11"/><name val="Arial"/></font>
  <font><b/><sz val="11"/><name val="Arial"/></font>
  <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Arial"/></font>
  <font><sz val="11"/><name val="Arial"/></font>
</fonts>
<fills count="6">
  <fill><patternFill patternType="none"/></fill>
  <fill><patternFill patternType="gray125"/></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FF4472C4"/></patternFill></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FF70AD47"/></patternFill></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FFBDD7EE"/></patternFill></fill>
  <fill><patternFill patternType="none"/></fill>
</fills>
<borders count="2">
  <border><left/><right/><top/><bottom/><diagonal/></border>
  <border><left style="thin"><color rgb="FFB0B0B0"/></left><right style="thin"><color rgb="FFB0B0B0"/></right><top style="thin"><color rgb="FFB0B0B0"/></top><bottom style="thin"><color rgb="FFB0B0B0"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">
  <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0"><alignment wrapText="1"/></xf>
  <xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0"/>
  <xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0"><alignment horizontal="center"/></xf>
  <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0"><alignment horizontal="center"/></xf>
  <xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0"><alignment horizontal="center"/></xf>
  <xf numFmtId="0" fontId="1" fillId="4" borderId="1" xfId="0"/>
</cellXfs>
</styleSheet>`;

  // Workbook XML
  const wbXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>
${sheets.map((s,i) => `<sheet name="${xe(s.name)}" sheetId="${i+1}" r:id="rId${i+2}"/>`).join('\n')}
</sheets>
</workbook>`;

  // Relationships
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
<Relationship Id="rId${sheets.length+2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
${sheets.map((_,i) => `<Relationship Id="rId${i+2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('\n')}
</Relationships>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml"  ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml"      ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
<Override PartName="/xl/styles.xml"        ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_,i) => `<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`;

  const files = [
    { name: '[Content_Types].xml',           data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels',                   data: Buffer.from(rootRels, 'utf8') },
    { name: 'xl/workbook.xml',               data: Buffer.from(wbXml, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels',    data: Buffer.from(wbRels, 'utf8') },
    { name: 'xl/sharedStrings.xml',          data: Buffer.from(ssXml, 'utf8') },
    { name: 'xl/styles.xml',                 data: Buffer.from(stylesXml, 'utf8') },
    ...sheets.map((_, i) => ({
      name: `xl/worksheets/sheet${i+1}.xml`,
      data: Buffer.from(wsXmls[i], 'utf8'),
    })),
  ];

  return zipFile(files);
}

module.exports = { buildXLSX };
