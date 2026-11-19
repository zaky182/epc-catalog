const { get, run, transaction, normalizePartNumber } = require('../db');

/**
 * Simple RFC-4180 compliant CSV parser (handles quoted fields & commas)
 */
function parseCsvText(csvText) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  const text = csvText.replace(/^\uFEFF/, ''); // strip UTF-8 BOM

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',' || ch === ';') {
        row.push(field.trim());
        field = '';
      } else if (ch === '\r' && next === '\n') {
        row.push(field.trim());
        rows.push(row);
        row = [];
        field = '';
        i++;
      } else if (ch === '\n' || ch === '\r') {
        row.push(field.trim());
        rows.push(row);
        row = [];
        field = '';
      } else {
        field += ch;
      }
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field.trim());
    rows.push(row);
  }

  return rows.filter((r) => r.some((cell) => cell.length > 0));
}

function ingestCsvCatalog({ csvText, bookId }) {
  const rows = parseCsvText(csvText);
  if (rows.length < 2) {
    throw new Error('CSV must contain a header row and at least one data row.');
  }

  const headers = rows[0].map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const colIdx = (aliases) => {
    for (const a of aliases) {
      const idx = headers.indexOf(a);
      if (idx !== -1) return idx;
    }
    return -1;
  };

  const iSecCode = colIdx(['sectioncode', 'seccode', 'groupcode', 'section']);
  const iSecName = colIdx(['sectionname', 'secname', 'groupname', 'group']);
  const iFigNo = colIdx(['figno', 'figureno', 'figure', 'reference', 'ref']);
  const iFigTitle = colIdx(['figtitle', 'figuretitle', 'title', 'assembly']);
  const iIndex = colIdx(['indexno', 'index', 'item', 'no', 'refno']);
  const iCode = colIdx(['code', 'ica', 'remarkcode']);
  const iPn = colIdx(['partnumber', 'pn', 'partno', 'oempartnumber']);
  const iDesc = colIdx(['description', 'desc', 'partname', 'name']);
  const iIndent = colIdx(['indentlevel', 'indent', 'level']);
  const iQty = colIdx(['qty', 'quantity']);
  const iSn = colIdx(['serialnumber', 'serialnumberrange', 'sn', 'snrange']);
  const iKit = colIdx(['kitref', 'kit']);
  const iRefer = colIdx(['refertopage', 'referpage', 'page']);
  const iBin = colIdx(['binlocation', 'bin', 'location', 'rack']);
  const iNotes = colIdx(['notes', 'note', 'remarks']);

  if (iPn === -1 && iDesc === -1) {
    throw new Error('CSV must include at least "part_number" or "description" column.');
  }

  const getVal = (r, idx, fallback = '') => (idx >= 0 && r[idx] !== undefined ? r[idx] : fallback);

  let figuresCount = 0;
  let partsCount = 0;

  transaction(() => {
    const secMap = new Map();
    const figMap = new Map();
    let secOrder = 1;
    let figOrder = 1;

    for (let rIdx = 1; rIdx < rows.length; rIdx++) {
      const r = rows[rIdx];
      const secCode = getVal(r, iSecCode, 'GEN') || 'GEN';
      const secName = getVal(r, iSecName, 'GENERAL PARTS') || 'GENERAL PARTS';
      const figNo = getVal(r, iFigNo, 'FIG-001') || 'FIG-001';
      const figTitle = getVal(r, iFigTitle, figNo) || figNo;

      const secKey = `${secCode}::${secName}`;
      let sectionId = secMap.get(secKey);
      if (!sectionId) {
        const existing = get(
          'SELECT id FROM sections WHERE book_id = ? AND code = ? AND name = ?',
          [bookId, secCode, secName]
        );
        sectionId = existing
          ? existing.id
          : run(
              'INSERT INTO sections (book_id, code, name, sort_order) VALUES (?, ?, ?, ?)',
              [bookId, secCode, secName, secOrder++],
              { deferSave: true }
            ).lastInsertRowid;
        secMap.set(secKey, sectionId);
      }

      const figKey = `${sectionId}::${figNo}`;
      let figureId = figMap.get(figKey);
      if (!figureId) {
        const existingFig = get(
          'SELECT id FROM figures WHERE book_id = ? AND fig_no = ?',
          [bookId, figNo]
        );
        if (existingFig) {
          figureId = existingFig.id;
        } else {
          figureId = run(
            `INSERT INTO figures (book_id, section_id, fig_no, title, layout_type, sort_order)
             VALUES (?, ?, ?, ?, 'generic', ?)`,
            [bookId, sectionId, figNo, figTitle, figOrder++],
            { deferSave: true }
          ).lastInsertRowid;
          figuresCount++;
        }
        figMap.set(figKey, figureId);
      }

      const pn = getVal(r, iPn);
      const desc = getVal(r, iDesc);
      if (!pn && !desc) continue;

      run(
        `INSERT INTO figure_parts
          (figure_id, book_id, index_no, code, part_number, part_number_norm, description, indent_level, qty, serial_number_range, kit_ref, refer_to_page, bin_location, notes, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          figureId,
          bookId,
          getVal(r, iIndex),
          getVal(r, iCode).toUpperCase(),
          pn,
          normalizePartNumber(pn),
          desc || pn,
          parseInt(getVal(r, iIndent, '0'), 10) || 0,
          getVal(r, iQty),
          getVal(r, iSn),
          getVal(r, iKit).toUpperCase(),
          getVal(r, iRefer),
          getVal(r, iBin),
          getVal(r, iNotes),
          rIdx
        ],
        { deferSave: true }
      );
      partsCount++;
    }

    run(
      'UPDATE part_books SET parse_status = ?, parse_progress = 100, parse_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      ['completed', `CSV imported: ${figuresCount} figures, ${partsCount} parts.`, bookId],
      { deferSave: true }
    );
  });

  return { figuresCount, partsCount };
}

const CSV_TEMPLATE = [
  'section_code,section_name,fig_no,fig_title,index_no,code,part_number,description,indent_level,qty,serial_number,kit_ref,refer_to_page,bin_location,notes',
  '23,FUEL SYSTEM,233-0010,Fuel Filter Assembly,1,,VOE20976003,FILTER FUEL MAIN,0,1,210001-,,,RACK-V02,OEM Genuine',
  '23,FUEL SYSTEM,233-0010,Fuel Filter Assembly,2,,VOE11110683,FILTER WATER SEPARATOR,0,1,210001-,,,RACK-V03,'
].join('\n');

module.exports = {
  ingestCsvCatalog,
  parseCsvText,
  CSV_TEMPLATE
};
