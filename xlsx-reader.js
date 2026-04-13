/**
 * xlsx-reader.js — Leitor mínimo de XLSX puro Node.js, zero dependências.
 * Lê a primeira planilha e retorna array de objetos com base no cabeçalho da linha 1.
 */
'use strict';
const zlib = require('zlib');

// ── Extrai arquivo do ZIP ─────────────────────────────────────────────────────
function getZipFile(buf, targetName) {
  let pos = 0;
  while (pos < buf.length - 4) {
    if (buf[pos]===0x50 && buf[pos+1]===0x4B && buf[pos+2]===0x03 && buf[pos+3]===0x04) {
      const method  = buf.readUInt16LE(pos + 8);
      const compSz  = buf.readUInt32LE(pos + 18);
      const nameLen = buf.readUInt16LE(pos + 26);
      const extrLen = buf.readUInt16LE(pos + 28);
      const name    = buf.slice(pos + 30, pos + 30 + nameLen).toString('utf8');
      const dataOff = pos + 30 + nameLen + extrLen;
      const compBuf = buf.slice(dataOff, dataOff + compSz);
      if (name === targetName) {
        return method === 8 ? zlib.inflateRawSync(compBuf).toString('utf8') : compBuf.toString('utf8');
      }
      pos = dataOff + compSz;
    } else {
      pos++;
    }
  }
  return null;
}

// ── Parseia XML simples (apenas tags e texto) ─────────────────────────────────
function parseXML(xml) {
  // Retorna array de { tag, attrs, text }
  const elements = [];
  const re = /<([^!?/][^>]*)>([^<]*)|<\/[^>]+>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    if (!m[1]) continue;
    const full   = m[1].trim();
    const spIdx  = full.search(/[\s/]/);
    const tag    = spIdx === -1 ? full : full.slice(0, spIdx);
    const rest   = spIdx === -1 ? '' : full.slice(spIdx);
    const attrs  = {};
    const attrRe = /(\w+)="([^"]*)"/g;
    let am;
    while ((am = attrRe.exec(rest)) !== null) attrs[am[1]] = am[2];
    const text = (m[2] || '').trim();
    elements.push({ tag, attrs, text });
  }
  return elements;
}

// ── Desescapa entidades XML ───────────────────────────────────────────────────
function xmlUnescape(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

// ── Converte referência de coluna Excel (A=0, B=1, AA=26…) ───────────────────
function colIndex(ref) {
  // ref = 'A', 'B', 'AA', etc. (sem número)
  let n = 0;
  for (let i = 0; i < ref.length; i++) n = n * 26 + ref.charCodeAt(i) - 64;
  return n - 1;
}

// ── Parseia shared strings ────────────────────────────────────────────────────
function parseSharedStrings(xml) {
  const strings = [];
  // Each <si> contains one or more <t> tags (with possible <r> rich text)
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  const tRe  = /<t[^>]*>([^<]*)<\/t>/g;
  let si;
  while ((si = siRe.exec(xml)) !== null) {
    let text = '';
    let t;
    tRe.lastIndex = 0;
    const inner = si[1];
    while ((t = tRe.exec(inner)) !== null) text += t[1];
    strings.push(xmlUnescape(text));
  }
  return strings;
}

// ── Parseia worksheet e retorna rows[][cols] ──────────────────────────────────
function parseSheet(xml, sharedStrings) {
  // Extract all <row> blocks
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
  const cellRe = /<c r="([A-Z]+)(\d+)"([^>]*)>([\s\S]*?)<\/c>|<c r="([A-Z]+)(\d+)"[^>]*\/>/g;
  const vRe   = /<v>([^<]*)<\/v>/;

  const rows = {};
  let rm;
  while ((rm = rowRe.exec(xml)) !== null) {
    const rowNum = parseInt((rm[0].match(/r="(\d+)"/) || ['','0'])[1], 10);
    const rowXml = rm[1];
    const cols   = {};
    let cm;
    cellRe.lastIndex = 0;
    while ((cm = cellRe.exec(rowXml)) !== null) {
      const colRef  = cm[1] || cm[5];
      const cellXml = cm[0];
      const isStr   = /t="s"/.test(cellXml);
      const isInl   = /t="inlineStr"/.test(cellXml);
      const vMatch  = vRe.exec(cellXml);
      let val = '';
      if (isInl) {
        const tM = /<t>([^<]*)<\/t>/.exec(cellXml);
        val = tM ? xmlUnescape(tM[1]) : '';
      } else if (vMatch) {
        const raw = vMatch[1];
        if (isStr) {
          val = sharedStrings[parseInt(raw, 10)] || '';
        } else {
          val = raw; // number as string; we'll keep it as-is
        }
      }
      cols[colIndex(colRef)] = val;
    }
    rows[rowNum] = cols;
  }
  return rows;
}

// ── API pública ───────────────────────────────────────────────────────────────
/**
 * Lê um Buffer de arquivo .xlsx e retorna array de objetos.
 * A primeira linha é usada como cabeçalho.
 * @param {Buffer} buf
 * @returns {{ rows: Array<{[key:string]:string}>, error?: string }}
 */
function readXLSX(buf) {
  try {
    // Identifica qual worksheet é a sheet1
    const wbXml = getZipFile(buf, 'xl/workbook.xml');
    if (!wbXml) return { rows: [], error: 'Arquivo XLSX inválido (sem workbook.xml).' };

    // Pega o rId da primeira sheet
    const sheetMatch = /<sheet[^>]+r:id="([^"]+)"/.exec(wbXml);
    if (!sheetMatch) return { rows: [], error: 'Nenhuma planilha encontrada no arquivo.' };
    const rId = sheetMatch[1];

    // Resolve o target da sheet pelo relationships
    const relsXml = getZipFile(buf, 'xl/_rels/workbook.xml.rels');
    if (!relsXml) return { rows: [], error: 'Arquivo XLSX inválido (sem relationships).' };
    const relMatch = new RegExp(`Id="${rId}"[^>]+Target="([^"]+)"`).exec(relsXml);
    if (!relMatch) return { rows: [], error: 'Planilha não encontrada nos relationships.' };

    let sheetPath = relMatch[1];
    if (!sheetPath.startsWith('xl/')) sheetPath = 'xl/' + sheetPath;

    const sheetXml = getZipFile(buf, sheetPath);
    if (!sheetXml) return { rows: [], error: `Planilha não encontrada: ${sheetPath}` };

    // Shared strings (podem não existir se todas as células são números)
    const ssXml  = getZipFile(buf, 'xl/sharedStrings.xml') || '';
    const ss     = parseSharedStrings(ssXml);

    const rawRows = parseSheet(sheetXml, ss);
    const rowNums = Object.keys(rawRows).map(Number).sort((a, b) => a - b);
    if (rowNums.length < 2) return { rows: [], error: 'Planilha vazia ou sem dados além do cabeçalho.' };

    // Linha 1 = cabeçalho
    const hdrRow = rawRows[rowNums[0]];
    const maxCol = Math.max(...Object.keys(hdrRow).map(Number));
    const headers = [];
    for (let c = 0; c <= maxCol; c++) {
      headers.push((hdrRow[c] || '').toLowerCase().trim());
    }

    // Linhas de dados
    const rows = [];
    for (let i = 1; i < rowNums.length; i++) {
      const rowNum = rowNums[i];
      const cols   = rawRows[rowNum] || {};
      const obj    = {};
      headers.forEach((h, c) => { if (h) obj[h] = (cols[c] || '').trim(); });
      // Ignora linhas completamente vazias
      if (headers.some(h => h && obj[h])) rows.push(obj);
    }

    return { rows };
  } catch (e) {
    return { rows: [], error: 'Erro ao processar XLSX: ' + e.message };
  }
}

module.exports = { readXLSX };
