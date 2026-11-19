const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { normalizePartNumber, run, get, transaction } = require('../db');

const DIAGRAMS_DIR =
  process.env.DIAGRAMS_DIR || path.join(__dirname, '..', 'public', 'diagrams');

const VALID_CODES = new Set(['A1', 'A2', 'A3', 'A4', 'B1', 'B2', 'C1', 'C2', 'C3']);

const DEFAULT_SECTION_NAMES = {
  A: 'ENGINE RELATED PARTS',
  B: 'COOLING SYSTEM',
  C: 'FUEL TANK & RELATED PARTS',
  D: 'ELECTRICAL SYSTEM',
  E: 'HYDRAULIC SYSTEM',
  F: 'MAIN FRAME & RELATED PARTS',
  G: 'OPERATOR COMPARTMENT & CONTROL SYSTEM',
  H: 'HYDRAULIC SYSTEM',
  J: 'GUARD',
  K: 'REVOLVING FRAME & SWING CIRCLE',
  L: 'UNDERCARRIAGE',
  M: 'TRACK FRAME & RELATED PARTS',
  N: 'FINAL DRIVE & TRAVEL MOTOR',
  P: 'WORK EQUIPMENT',
  R: 'WORK EQUIPMENT',
  S: 'MARKS & PLATES',
  T: 'WORK EQUIPMENT (SUPPLEMENT)',
  U: 'ACCESSORIES',
  V: 'MISCELLANEOUS',
  KIT: 'SERVICE KIT PARTS'
};

let pdfjsLibCache = null;
async function getPdfJs() {
  if (pdfjsLibCache) return pdfjsLibCache;
  pdfjsLibCache = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsLibCache;
}

let pdftoppmAvailable = null;
let sharpModule = null;

function checkDiagramTools() {
  if (pdftoppmAvailable !== null) return pdftoppmAvailable;
  try {
    execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' });
    sharpModule = require('sharp');
    pdftoppmAvailable = true;
  } catch (_) {
    pdftoppmAvailable = false;
  }
  return pdftoppmAvailable;
}

/**
 * Group PDF.js text items into visual horizontal lines using Y-coordinate clustering
 */
function groupItemsIntoLines(items, yTolerance = 3.5) {
  const cleaned = items
    .filter((it) => it.str && it.str.trim().length > 0)
    .map((it) => ({
      str: it.str,
      x: it.transform[4],
      y: it.transform[5],
      w: it.width || 0,
      h: Math.abs(it.transform[3]) || it.height || 8
    }))
    .sort((a, b) => {
      if (Math.abs(b.y - a.y) > yTolerance) return b.y - a.y; // top to bottom
      return a.x - b.x; // left to right
    });

  const lines = [];
  for (const item of cleaned) {
    let line = lines.find((l) => Math.abs(l.y - item.y) <= yTolerance);
    if (!line) {
      line = { y: item.y, items: [] };
      lines.push(line);
    }
    line.items.push(item);
  }

  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    line.text = line.items
      .map((i) => i.str)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  lines.sort((a, b) => b.y - a.y);
  return lines;
}

function parseBulletsAndMeta(rawDesc) {
  let desc = (rawDesc || '').trim();
  let indentLevel = 0;

  // Count leading bullet dots like "• • • Description" or "· · Description"
  const bulletMatch = desc.match(/^((?:[•·●▪◦\*]\s*)+)(.*)$/);
  if (bulletMatch) {
    const bulletStr = bulletMatch[1];
    const dots = bulletStr.match(/[•·●▪◦\*]/g);
    indentLevel = dots ? Math.min(dots.length, 5) : 0;
    desc = bulletMatch[2].trim();
  }

  // Extract Kit reference: (Kit : K26) or (KIT: K25)
  let kitRef = '';
  const kitMatch = desc.match(/\(?\bKIT\s*[:\-]\s*(K\d+[A-Z]?)\)?/i);
  if (kitMatch) {
    kitRef = kitMatch[1].toUpperCase();
  }

  // Extract cross-page reference: (Refer to Page 125) or (Refer to Page T018004)
  let referToPage = '';
  const referMatch = desc.match(/Refer\s+to\s+Page\s+([A-Z0-9\-]+)/i);
  if (referMatch) {
    referToPage = referMatch[1].trim();
  }

  return { description: desc, indentLevel, kitRef, referToPage };
}

function detectColumnBounds(lines, tableLeft, tableRight) {
  const tableWidth = tableRight - tableLeft;
  // Default proportional boundaries for Komatsu tables
  const bounds = {
    indexEnd: tableLeft + tableWidth * 0.08,
    codeEnd: tableLeft + tableWidth * 0.145,
    pnEnd: tableLeft + tableWidth * 0.34,
    descEnd: tableLeft + tableWidth * 0.76,
    qtyEnd: tableLeft + tableWidth * 0.84
  };

  for (const line of lines) {
    const upper = line.text.toUpperCase();
    if (
      (upper.includes('PART') && upper.includes('DESCRIPTION')) ||
      (upper.includes('INDEX') && upper.includes('QTY'))
    ) {
      let xCode = null;
      let xPn = null;
      let xDesc = null;
      let xQty = null;
      let xSn = null;

      for (const it of line.items) {
        const s = it.str.trim().toUpperCase();
        if (s === 'CODE' && xCode === null) xCode = it.x;
        if ((s.startsWith('PART') || s === 'P/N') && xPn === null) xPn = it.x;
        if (s.startsWith('DESC') && xDesc === null) xDesc = it.x;
        if ((s === 'QTY' || s === 'Q\'TY') && xQty === null) xQty = it.x;
        if (s.startsWith('SERIAL') && xSn === null) xSn = it.x;
      }

      if (xCode) bounds.indexEnd = xCode - 4;
      if (xPn) bounds.codeEnd = xPn - 4;
      if (xDesc) bounds.pnEnd = xDesc - 4;
      if (xQty) bounds.descEnd = xQty - 6;
      if (xSn) bounds.qtyEnd = xSn - 6;
      return { bounds, headerY: line.y };
    }
  }

  return { bounds, headerY: null };
}

function parseTableRows(tableLines, tableLeft, tableRight) {
  const { bounds, headerY } = detectColumnBounds(tableLines, tableLeft, tableRight);
  const parts = [];

  for (const line of tableLines) {
    // Skip lines above or on the table header
    if (headerY !== null && line.y >= headerY - 2) continue;

    const upper = line.text.toUpperCase();
    // Skip page footers and boilerplate
    if (
      upper.startsWith('FIG.') ||
      upper.startsWith('PAGE:') ||
      upper.startsWith('REFERENCE:') ||
      upper.startsWith('SERIAL NO') ||
      upper.startsWith('PC500') ||
      /^[\-_=\s]+$/.test(upper)
    ) {
      continue;
    }

    const cols = {
      index: [],
      code: [],
      pn: [],
      desc: [],
      qty: [],
      sn: []
    };

    for (const it of line.items) {
      const x = it.x;
      const t = it.str.trim();
      if (!t) continue;

      if (x < bounds.indexEnd) cols.index.push(t);
      else if (x < bounds.codeEnd) cols.code.push(t);
      else if (x < bounds.pnEnd) cols.pn.push(t);
      else if (x < bounds.descEnd) cols.desc.push(t);
      else if (x < bounds.qtyEnd) cols.qty.push(t);
      else cols.sn.push(t);
    }

    let indexNo = cols.index.join('').trim();
    let code = cols.code.join('').trim().toUpperCase();
    let partNumber = cols.pn.join('').trim();
    let rawDesc = cols.desc.join(' ').trim();
    let qty = cols.qty.join('').trim();
    let sn = cols.sn.join(' ').trim();

    // Sometimes index + code bleed together or code lands in index/pn column
    if (code && !VALID_CODES.has(code)) {
      if (/^[0-9A-Z\-()]{6,}$/.test(code) && !partNumber) {
        partNumber = code;
        code = '';
      } else if (/^\d{1,3}[A-Z]?$/.test(code) && !indexNo) {
        indexNo = code;
        code = '';
      } else {
        rawDesc = `${code} ${rawDesc}`.trim();
        code = '';
      }
    }

    // Validate indexNo is reasonable (number, Kxx, or short token)
    if (indexNo && !/^([A-Z]?\d{1,3}[A-Z]?|\*)$/.test(indexNo)) {
      // Probably header/noise text
      if (!partNumber && !rawDesc) continue;
    }

    const hasRowAnchor = Boolean(indexNo || partNumber || VALID_CODES.has(code) || qty);
    const hasLeadingBullet = /^[•·●▪◦\*]/.test(rawDesc);

    if (!hasRowAnchor && !hasLeadingBullet && rawDesc && parts.length > 0) {
      // Continuation line of previous part's description (e.g. Oversize / Refer to Page)
      const prev = parts[parts.length - 1];
      prev.description = `${prev.description} ${rawDesc}`.replace(/\s+/g, ' ').trim();
      const meta = parseBulletsAndMeta(prev.description);
      if (meta.kitRef && !prev.kitRef) prev.kitRef = meta.kitRef;
      if (meta.referToPage && !prev.referToPage) prev.referToPage = meta.referToPage;
      if (sn && !prev.serialNumberRange) prev.serialNumberRange = sn;
      continue;
    }

    if (!rawDesc && !partNumber) continue;

    const meta = parseBulletsAndMeta(rawDesc);
    parts.push({
      indexNo,
      code: VALID_CODES.has(code) ? code : '',
      partNumber,
      partNumberNorm: normalizePartNumber(partNumber),
      description: meta.description || rawDesc || partNumber,
      indentLevel: meta.indentLevel,
      qty,
      serialNumberRange: sn,
      kitRef: meta.kitRef || (/^K\d+$/i.test(indexNo) ? indexNo.toUpperCase() : ''),
      referToPage: meta.referToPage
    });
  }

  return parts;
}

async function cropDiagramIfPossible(pdfPath, bookId, pageNum, figNo, isPortrait) {
  if (!checkDiagramTools()) return null;

  const bookDir = path.join(DIAGRAMS_DIR, `book_${bookId}`);
  fs.mkdirSync(bookDir, { recursive: true });

  const safeFig = figNo.replace(/[^A-Za-z0-9_\-]/g, '_');
  const tmpPrefix = path.join(bookDir, `tmp_${pageNum}_${safeFig}`);
  const outName = `${safeFig}_p${pageNum}.webp`;
  const outPath = path.join(bookDir, outName);

  try {
    execFileSync(
      'pdftoppm',
      ['-png', '-r', '150', '-f', String(pageNum), '-l', String(pageNum), '-singlefile', pdfPath, tmpPrefix],
      { stdio: 'ignore' }
    );
    const pngPath = `${tmpPrefix}.png`;
    if (!fs.existsSync(pngPath)) return null;

    const img = sharpModule(pngPath);
    const meta = await img.metadata();
    if (!meta.width || !meta.height) {
      fs.unlinkSync(pngPath);
      return null;
    }

    const cropRegion = isPortrait
      ? { left: 0, top: 0, width: meta.width, height: Math.floor(meta.height * 0.48) }
      : { left: 0, top: 0, width: Math.floor(meta.width * 0.49), height: meta.height };

    await img.extract(cropRegion).webp({ quality: 84 }).toFile(outPath);
    fs.unlinkSync(pngPath);

    return `/diagrams/book_${bookId}/${outName}`;
  } catch (_) {
    return null;
  }
}

/**
 * Main Komatsu PDF Part Book Ingestion Function
 */
async function ingestKomatsuPdf({ pdfPath, bookId, onProgress }) {
  const pdfjsLib = await getPdfJs();
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const loadingTask = pdfjsLib.getDocument({
    data,
    verbosity: 0,
    useSystemFonts: true
  });
  const pdfDoc = await loadingTask.promise;
  const totalPages = pdfDoc.numPages;

  run(
    'UPDATE part_books SET total_pages = ?, parse_status = ?, parse_progress = ?, parse_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [totalPages, 'processing', 1, `Scanning ${totalPages} pages...`, bookId]
  );

  const sectionNames = { ...DEFAULT_SECTION_NAMES };
  const extractedFigures = []; // ordered list of figure objects with parts
  let currentFigure = null;
  let inNumericalIndex = false;

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1.0 });
    const { width, height } = viewport;
    const isPortrait = height > width;

    const textContent = await page.getTextContent();
    const allLines = groupItemsIntoLines(textContent.items, 3.5);
    const fullTextUpper = allLines.map((l) => l.text).join('\n').toUpperCase();

    // Update progress every 10 pages
    if (pageNum % 10 === 0 || pageNum === totalPages) {
      const pct = Math.min(92, Math.round((pageNum / totalPages) * 90));
      run(
        'UPDATE part_books SET parse_progress = ?, parse_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [pct, `Parsing page ${pageNum} / ${totalPages}...`, bookId]
      );
      if (onProgress) onProgress(pct, pageNum, totalPages);
    }

    // Skip empty or cover page
    if (allLines.length < 3 || pageNum === 1) continue;

    // Detect Foreword / Numerical Index
    if (
      fullTextUpper.includes('FOREWORD') ||
      fullTextUpper.includes('AVANT-PROPOS') ||
      fullTextUpper.includes('VORWORT') ||
      fullTextUpper.includes('PREFACIO')
    ) {
      continue;
    }

    if (fullTextUpper.includes('NUMERICAL INDEX')) {
      inNumericalIndex = true;
      continue;
    }

    // Resume parsing if Portrait CSS Supplement appears after Numerical Index (e.g. pp. 544-561)
    if (inNumericalIndex && !isPortrait) {
      continue;
    }
    if (isPortrait && (fullTextUpper.includes('REFERENCE:') || fullTextUpper.includes('PART NUMBER'))) {
      inNumericalIndex = false;
    }

    // Parse CONTENTS pages to capture authentic section names
    if (fullTextUpper.includes('CONTENTS') && !fullTextUpper.includes('PART NUMBER')) {
      for (const line of allLines) {
        const secMatch = line.text.match(/^([A-Z])\s+([A-Z][A-Z0-9\s,&/\-]{3,})$/);
        if (secMatch) {
          sectionNames[secMatch[1]] = secMatch[2].trim();
        }
      }
      continue;
    }

    // =========================================================================
    // CASE A: Komatsu Standard Landscape Figure Page (width > height)
    // =========================================================================
    if (!isPortrait) {
      const rightStart = width * 0.46;
      const rightItems = textContent.items.filter((it) => it.transform[4] >= rightStart);
      const rightLines = groupItemsIntoLines(rightItems, 3.5);
      const headerText = allLines.slice(0, 12).map((l) => l.text).join(' ');

      const figMatch = headerText.match(/\bFIG\.?\s*([A-Z0-9]{1,5}\-[A-Z0-9]{4,8}|KIT)\b/i);
      if (!figMatch) continue;

      const figNo = figMatch[1].toUpperCase();
      const drawingMatch = fullTextUpper.match(/\b(JH\d{5,8}|[A-Z]{2}\d{6,8})\b/);
      const drawingCode = drawingMatch ? drawingMatch[1] : '';

      // Extract book page number from bottom or top corner
      const pageLabelMatch = allLines[allLines.length - 1]?.text.match(/\b(\d{1,4}(?:\-\d)?)\b/);
      const bookPageLabel = pageLabelMatch ? pageLabelMatch[1] : String(pageNum);

      // Extract title from top right lines near FIG.
      let title = figNo === 'KIT' ? 'Service Kit Parts' : figNo;
      for (const rl of rightLines.slice(0, 6)) {
        const cleaned = rl.text
          .replace(/\bFIG\.?\s*[A-Z0-9\-]+\b/gi, '')
          .replace(/\bPAGE\s*\d+\b/gi, '')
          .trim();
        if (
          cleaned.length >= 3 &&
          !cleaned.toUpperCase().includes('PART NUMBER') &&
          !cleaned.toUpperCase().includes('SERIAL NO') &&
          !/^\d+$/.test(cleaned)
        ) {
          title = cleaned;
          break;
        }
      }

      const parts = parseTableRows(rightLines, rightStart, width - 12);

      if (currentFigure && currentFigure.figNo === figNo) {
        // Multi-page continuation of the same figure
        currentFigure.pdfPageEnd = pageNum;
        currentFigure.parts.push(...parts);
      } else {
        const sectionCode = figNo === 'KIT' ? 'KIT' : figNo.charAt(0);
        const diagramUrl = await cropDiagramIfPossible(pdfPath, bookId, pageNum, figNo, false);

        currentFigure = {
          sectionCode,
          sectionName: sectionNames[sectionCode] || `SECTION ${sectionCode}`,
          figNo,
          title,
          variantNote: '',
          diagramImageUrl: diagramUrl,
          pdfPageStart: pageNum,
          pdfPageEnd: pageNum,
          bookPageLabel,
          drawingCode,
          layoutType: 'landscape',
          parts
        };
        extractedFigures.push(currentFigure);
      }
      continue;
    }

    // =========================================================================
    // CASE B: Komatsu CSS Portrait Supplement Page (height > width, e.g. Arm 2900mm)
    // =========================================================================
    const fullText = allLines.map((l) => l.text).join(' ');
    const refMatch = fullText.match(/Reference\s*:\s*([A-Z0-9\-]+)/i);
    const pageRefMatch = fullText.match(/Page\s*:\s*([A-Z0-9\-]+)/i);
    if (!refMatch && !fullTextUpper.includes('PART NUMBER')) continue;

    const figNo = refMatch ? refMatch[1].toUpperCase() : `SUP-${pageNum}`;
    const bookPageLabel = pageRefMatch ? pageRefMatch[1].toUpperCase() : String(pageNum);
    const drawingMatch = fullTextUpper.match(/\b(JH\d{5,8}|[A-Z]{2}\d{6,8})\b/);
    const drawingCode = drawingMatch ? drawingMatch[1] : '';

    // In PDF bottom-up coords, bottom half is y <= height * 0.58
    const bottomItems = textContent.items.filter((it) => it.transform[5] <= height * 0.58);
    const bottomLines = groupItemsIntoLines(bottomItems, 3.5);
    const parts = parseTableRows(bottomLines, 15, width - 15);

    let title = figNo;
    for (const l of allLines.slice(0, 6)) {
      const cleaned = l.text
        .replace(/Reference\s*:\s*[A-Z0-9\-]+/gi, '')
        .replace(/Page\s*:\s*[A-Z0-9\-]+/gi, '')
        .trim();
      if (cleaned.length >= 4 && !/^(JH\d+|KOMATSU)$/i.test(cleaned)) {
        title = cleaned;
        break;
      }
    }

    if (currentFigure && currentFigure.figNo === figNo) {
      currentFigure.pdfPageEnd = pageNum;
      currentFigure.parts.push(...parts);
    } else {
      const sectionCode = figNo.charAt(0).match(/[A-Z]/) ? figNo.charAt(0) : 'T';
      const diagramUrl = await cropDiagramIfPossible(pdfPath, bookId, pageNum, figNo, true);

      currentFigure = {
        sectionCode,
        sectionName: sectionNames[sectionCode] || 'WORK EQUIPMENT (SUPPLEMENT)',
        figNo,
        title,
        variantNote: 'Supplement / Portrait CSS',
        diagramImageUrl: diagramUrl,
        pdfPageStart: pageNum,
        pdfPageEnd: pageNum,
        bookPageLabel,
        drawingCode,
        layoutType: 'portrait_css',
        parts
      };
      extractedFigures.push(currentFigure);
    }
  }

  // Persist extracted sections, figures, and parts in a single fast transaction
  run(
    'UPDATE part_books SET parse_progress = 95, parse_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [`Saving ${extractedFigures.length} figures to database...`, bookId]
  );

  let totalPartsInserted = 0;

  transaction(() => {
    // Clear previous parse data for this book if re-ingesting
    run('DELETE FROM figure_parts WHERE book_id = ?', [bookId], { deferSave: true });
    run('DELETE FROM figures WHERE book_id = ?', [bookId], { deferSave: true });
    run('DELETE FROM sections WHERE book_id = ?', [bookId], { deferSave: true });

    const sectionIdMap = new Map();
    let sectionOrder = 1;

    extractedFigures.forEach((fig, fIdx) => {
      const secKey = `${fig.sectionCode}::${fig.sectionName}`;
      let sectionId = sectionIdMap.get(secKey);
      if (!sectionId) {
        const existingSec = get(
          'SELECT id FROM sections WHERE book_id = ? AND code = ? AND name = ?',
          [bookId, fig.sectionCode, fig.sectionName]
        );
        if (existingSec) {
          sectionId = existingSec.id;
        } else {
          sectionId = run(
            'INSERT INTO sections (book_id, code, name, sort_order) VALUES (?, ?, ?, ?)',
            [bookId, fig.sectionCode, fig.sectionName, sectionOrder++],
            { deferSave: true }
          ).lastInsertRowid;
        }
        sectionIdMap.set(secKey, sectionId);
      }

      const figureId = run(
        `INSERT INTO figures
          (book_id, section_id, fig_no, title, variant_note, diagram_image_url, pdf_page_start, pdf_page_end, book_page_label, drawing_code, layout_type, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          bookId,
          sectionId,
          fig.figNo,
          fig.title,
          fig.variantNote || '',
          fig.diagramImageUrl || null,
          fig.pdfPageStart,
          fig.pdfPageEnd,
          fig.bookPageLabel || String(fig.pdfPageStart),
          fig.drawingCode || '',
          fig.layoutType || 'landscape',
          fIdx + 1
        ],
        { deferSave: true }
      ).lastInsertRowid;

      fig.parts.forEach((p, pIdx) => {
        run(
          `INSERT INTO figure_parts
            (figure_id, book_id, index_no, code, part_number, part_number_norm, description, indent_level, qty, serial_number_range, kit_ref, refer_to_page, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            figureId,
            bookId,
            p.indexNo || '',
            p.code || '',
            p.partNumber || '',
            p.partNumberNorm || '',
            p.description || '',
            p.indentLevel || 0,
            p.qty || '',
            p.serialNumberRange || '',
            p.kitRef || '',
            p.referToPage || '',
            pIdx + 1
          ],
          { deferSave: true }
        );
        totalPartsInserted++;
      });
    });

    run(
      'UPDATE part_books SET parse_status = ?, parse_progress = 100, parse_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [
        'completed',
        `Completed: ${extractedFigures.length} figures, ${totalPartsInserted} part rows extracted.`,
        bookId
      ],
      { deferSave: true }
    );
  });

  return {
    totalPages,
    figuresCount: extractedFigures.length,
    partsCount: totalPartsInserted
  };
}

module.exports = {
  ingestKomatsuPdf,
  parseBulletsAndMeta
};
