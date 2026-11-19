const { get, run, transaction, normalizePartNumber } = require('./index');

/**
 * Seeds realistic sample data modeled directly after:
 * - Komatsu PC500LC-10R (Form FEN04597-00) + Arm 2900 mm Supplement
 * - Volvo EC480D (demonstrating multi-brand catalog & cross-brand search)
 */
function seedDemoData() {
  return transaction(() => {
    const komatsu = get("SELECT id FROM brands WHERE slug = 'komatsu'");
    const volvo = get("SELECT id FROM brands WHERE slug = 'volvo'");

    // 1. Komatsu PC500LC-10R
    let kModel = get('SELECT id FROM models WHERE brand_id = ? AND model_name = ?', [
      komatsu.id,
      'PC500LC-10R'
    ]);
    if (!kModel) {
      const r = run(
        `INSERT INTO models (brand_id, category, model_name, engine_model, sn_range, notes)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          komatsu.id,
          'Excavator',
          'PC500LC-10R',
          'SAA6D125E-5 (S/N 663485-UP)',
          '100003-UP',
          'Demo seed from Part Book PC500LC-10R + Arm 2900 mm (FEN04597-00)'
        ],
        { deferSave: true }
      );
      kModel = { id: r.lastInsertRowid };
    }

    let kBook = get('SELECT id FROM part_books WHERE model_id = ? AND form_no = ?', [
      kModel.id,
      'FEN04597-00'
    ]);
    if (!kBook) {
      const r = run(
        `INSERT INTO part_books (model_id, form_no, title, pdf_filename, total_pages, parser_type, parse_status, parse_progress, parse_message)
         VALUES (?, ?, ?, ?, ?, 'komatsu', 'completed', 100, 'Demo sample loaded (upload real PDF to ingest all 561 pages)')`,
        [
          kModel.id,
          'FEN04597-00',
          'PC500LC-10R + Arm 2900 mm (Sample)',
          'Part Book PC500LC-10R + Arm 2900 mm.pdf',
          561
        ],
        { deferSave: true }
      );
      kBook = { id: r.lastInsertRowid };

      const secA = run(
        'INSERT INTO sections (book_id, code, name, sort_order) VALUES (?, ?, ?, ?)',
        [kBook.id, 'A', 'ENGINE RELATED PARTS', 1],
        { deferSave: true }
      ).lastInsertRowid;

      const secH = run(
        'INSERT INTO sections (book_id, code, name, sort_order) VALUES (?, ?, ?, ?)',
        [kBook.id, 'H', 'HYDRAULIC SYSTEM', 2],
        { deferSave: true }
      ).lastInsertRowid;

      const secT = run(
        'INSERT INTO sections (book_id, code, name, sort_order) VALUES (?, ?, ?, ?)',
        [kBook.id, 'T', 'WORK EQUIPMENT (+ ARM 2900 MM)', 3],
        { deferSave: true }
      ).lastInsertRowid;

      const secKit = run(
        'INSERT INTO sections (book_id, code, name, sort_order) VALUES (?, ?, ?, ?)',
        [kBook.id, 'KIT', 'SERVICE KIT PARTS', 4],
        { deferSave: true }
      ).lastInsertRowid;

      // Figure 1: Engine Cylinder Block
      const figA1010 = run(
        `INSERT INTO figures (book_id, section_id, fig_no, title, pdf_page_start, pdf_page_end, book_page_label, drawing_code, layout_type, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'landscape', 1)`,
        [kBook.id, secA, 'A1010-001001', 'Cylinder Block', 32, 33, '32', 'JH100001'],
        { deferSave: true }
      ).lastInsertRowid;

      insertParts(kBook.id, figA1010, [
        { idx: '1', code: '', pn: '6251-21-1102', desc: 'BLOCK ASSY, CYLINDER', indent: 0, qty: '1', sn: '663485-' },
        { idx: '2', code: 'C1', pn: '', desc: 'BLOCK, CYLINDER', indent: 1, qty: '1', sn: '663485-' },
        { idx: '3', code: '', pn: '6251-21-1410', desc: 'CAP, MAIN BEARING', indent: 1, qty: '6', sn: '663485-' },
        { idx: '4', code: '', pn: '6150-21-1490', desc: 'BOLT, MAIN BEARING CAP', indent: 1, qty: '14', sn: '663485-' },
        { idx: '5', code: '', pn: '6251-21-2210', desc: 'LINER, CYLINDER', indent: 0, qty: '6', sn: '663485-' },
        { idx: '6', code: '', pn: '6150-21-2220', desc: 'O-RING, CYLINDER LINER (CREVICE SEAL)', indent: 0, qty: '6', sn: '663485-' },
        { idx: '7', code: '', pn: '6251-11-5440', desc: 'GASKET, CYLINDER HEAD', indent: 0, qty: '6', sn: '663485-' },
        { idx: '8', code: '', pn: '07000-13032', desc: 'O-RING', indent: 0, qty: '2', sn: '663485-' }
      ]);

      // Figure 2: Fuel Filter & Injector
      const figA1610 = run(
        `INSERT INTO figures (book_id, section_id, fig_no, title, pdf_page_start, pdf_page_end, book_page_label, drawing_code, layout_type, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'landscape', 2)`,
        [kBook.id, secA, 'A1610-001001', 'Fuel Filter & Injector Piping', 78, 78, '78', 'JH100142'],
        { deferSave: true }
      ).lastInsertRowid;

      insertParts(kBook.id, figA1610, [
        { idx: '1', code: '', pn: '600-319-3841', desc: 'CARTRIDGE, FUEL MAIN FILTER', indent: 0, qty: '1', sn: '663485-', bin: 'RACK-A04' },
        { idx: '2', code: '', pn: '600-319-4540', desc: 'CARTRIDGE, FUEL PRE-FILTER', indent: 0, qty: '1', sn: '663485-', bin: 'RACK-A05' },
        { idx: '3', code: '', pn: '6251-11-3100', desc: 'INJECTOR ASSY, FUEL', indent: 0, qty: '6', sn: '663485-' },
        { idx: '4', code: '', pn: '6251-11-3190', desc: 'O-RING, INJECTOR', indent: 1, qty: '6', sn: '663485-' },
        { idx: '5', code: '', pn: '6251-11-3180', desc: 'GASKET, INJECTOR NOZZLE', indent: 1, qty: '6', sn: '663485-' }
      ]);

      // Figure 3: Control Valve (with C1 & multi-level BOM & Refer to Page)
      const figH0120 = run(
        `INSERT INTO figures (book_id, section_id, fig_no, title, pdf_page_start, pdf_page_end, book_page_label, drawing_code, layout_type, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'landscape', 3)`,
        [kBook.id, secH, 'H0120-001001', 'Control Valve (8-Spool) (1/24)', 125, 125, '125', 'JH101720'],
        { deferSave: true }
      ).lastInsertRowid;

      insertParts(kBook.id, figH0120, [
        { idx: '1', code: '', pn: '723-47-11101', desc: 'VALVE ASSY, CONTROL (8-SPOOL)', indent: 0, qty: '1', sn: '100003-' },
        { idx: '2', code: 'C1', pn: '', desc: 'BODY, VALVE', indent: 1, qty: '1', sn: '100003-' },
        { idx: '3', code: '', pn: '723-40-71103', desc: 'VALVE ASSY, MAIN RELIEF', indent: 1, qty: '1', sn: '100003-' },
        { idx: '4', code: '', pn: '07000-13032', desc: 'O-RING, RELIEF VALVE', indent: 2, qty: '2', sn: '100003-' },
        { idx: '5', code: '', pn: '07001-03032', desc: 'RING, BACK-UP', indent: 2, qty: '2', sn: '100003-' },
        { idx: '6', code: '', pn: '(2A8-03-11881)', desc: 'HOSE, PILOT LINE (Refer to Page 544)', indent: 0, qty: '1', sn: '100003-', refer: '544' }
      ]);

      // Figure 4: Boom Cylinder (with Kit: K26 cross-link)
      const figT1200 = run(
        `INSERT INTO figures (book_id, section_id, fig_no, title, variant_note, pdf_page_start, pdf_page_end, book_page_label, drawing_code, layout_type, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'portrait_css', 4)`,
        [
          kBook.id,
          secT,
          'T1200-005001',
          'Boom Cylinder (RH/LH)',
          'Arm 2900 mm, Heavy Duty Type',
          544,
          544,
          '544',
          'JH103965'
        ],
        { deferSave: true }
      ).lastInsertRowid;

      insertParts(kBook.id, figT1200, [
        { idx: '1', code: '', pn: '707-01-0H430', desc: 'CYLINDER ASSY, BOOM', indent: 0, qty: '2', sn: '100003-' },
        { idx: '2', code: 'A2', pn: '707-01-0H440', desc: 'CYLINDER ASSY, BOOM (HEAVY DUTY)', indent: 0, qty: '2', sn: '100003-' },
        { idx: '3', code: '', pn: '707-44-11020', desc: 'PACKING, ROD (Kit : K26)', indent: 1, qty: '1', sn: '100003-', kit: 'K26' },
        { idx: '4', code: '', pn: '707-51-11030', desc: 'SEAL, DUST (Kit : K26)', indent: 1, qty: '1', sn: '100003-', kit: 'K26' },
        { idx: '5', code: '', pn: '07000-13032', desc: 'O-RING (Kit : K26)', indent: 1, qty: '2', sn: '100003-', kit: 'K26' },
        { idx: '6', code: '', pn: '07001-03032', desc: 'RING, BACK-UP (Kit : K26)', indent: 1, qty: '1', sn: '100003-', kit: 'K26' },
        { idx: '7', code: '', pn: '(723-47-11101)', desc: 'VALVE ASSY, CONTROL (Refer to Page 125)', indent: 0, qty: '1', sn: '100003-', refer: '125' }
      ]);

      // Figure 5: FIG. KIT (Service Kit Parts)
      const figKit = run(
        `INSERT INTO figures (book_id, section_id, fig_no, title, pdf_page_start, pdf_page_end, book_page_label, drawing_code, layout_type, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'landscape', 5)`,
        [kBook.id, secKit, 'KIT', 'Service Kit Parts', 507, 507, '507', ''],
        { deferSave: true }
      ).lastInsertRowid;

      insertParts(kBook.id, figKit, [
        { idx: 'K25', code: '', pn: '707-99-67390', desc: 'SERVICE KIT, ARM CYLINDER SEAL', indent: 0, qty: '1', sn: '100003-', kit: 'K25' },
        { idx: 'K26', code: '', pn: '721-98-03990', desc: 'SERVICE KIT, BOOM CYLINDER SEAL', indent: 0, qty: '1', sn: '100003-', kit: 'K26', bin: 'RACK-S12' },
        { idx: 'K27', code: '', pn: '707-99-59260', desc: 'SERVICE KIT, BUCKET CYLINDER SEAL', indent: 0, qty: '1', sn: '100003-', kit: 'K27' },
        { idx: 'K28', code: '', pn: '707-98-46280', desc: 'SERVICE KIT, CENTER SWIVEL JOINT', indent: 0, qty: '1', sn: '100003-', kit: 'K28' }
      ]);
    }

    // 2. Volvo EC480D (Multi-brand demonstration)
    let vModel = get('SELECT id FROM models WHERE brand_id = ? AND model_name = ?', [
      volvo.id,
      'EC480D'
    ]);
    if (!vModel) {
      const r = run(
        `INSERT INTO models (brand_id, category, model_name, engine_model, sn_range, notes)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [volvo.id, 'Excavator', 'EC480D', 'Volvo D13F', '210001-UP', 'Multi-brand sample unit (CSV/IMPACT structure)'],
        { deferSave: true }
      );
      vModel = { id: r.lastInsertRowid };

      const vBook = run(
        `INSERT INTO part_books (model_id, form_no, title, pdf_filename, total_pages, parser_type, parse_status, parse_progress, parse_message)
         VALUES (?, ?, ?, ?, ?, 'csv', 'completed', 100, 'Sample multi-brand catalog')`,
        [vModel.id, 'VOE-EC480D-01', 'Volvo EC480D Parts Catalog (Sample)', 'volvo-ec480d-sample.csv', 1],
        { deferSave: true }
      ).lastInsertRowid;

      const vSec = run(
        'INSERT INTO sections (book_id, code, name, sort_order) VALUES (?, ?, ?, ?)',
        [vBook, '23', 'FUEL SYSTEM & FILTERS', 1],
        { deferSave: true }
      ).lastInsertRowid;

      const vFig = run(
        `INSERT INTO figures (book_id, section_id, fig_no, title, pdf_page_start, pdf_page_end, book_page_label, layout_type, sort_order)
         VALUES (?, ?, ?, ?, 1, 1, '1', 'generic', 1)`,
        [vBook, vSec, '233-0010', 'Fuel Filter & Water Separator', 1],
        { deferSave: true }
      ).lastInsertRowid;

      insertParts(vBook, vFig, [
        { idx: '1', code: '', pn: 'VOE20976003', desc: 'FILTER, FUEL MAIN', indent: 0, qty: '1', sn: '210001-', bin: 'RACK-V02' },
        { idx: '2', code: '', pn: 'VOE11110683', desc: 'FILTER, WATER SEPARATOR', indent: 0, qty: '1', sn: '210001-', bin: 'RACK-V03' },
        { idx: '3', code: '', pn: 'VOE14524171', desc: 'ELEMENT, HYDRAULIC RETURN FILTER', indent: 0, qty: '1', sn: '210001-' }
      ]);
    }

    // 3. Cross-Reference Aftermarket Samples
    const existingXref = get('SELECT COUNT(*) AS cnt FROM part_cross_refs');
    if (!existingXref || existingXref.cnt === 0) {
      const xrefs = [
        ['600-319-3841', 'Donaldson', 'P550881', 'aftermarket', 'Direct spin-on replacement'],
        ['600-319-3841', 'Fleetguard', 'FF5632', 'aftermarket', 'High efficiency 5 micron'],
        ['600-319-3841', 'Sakura', 'FC-5603', 'aftermarket', 'Standard fuel filter'],
        ['600-319-4540', 'Donaldson', 'P551052', 'aftermarket', 'Fuel water separator'],
        ['600-319-4540', 'Fleetguard', 'FS19763', 'aftermarket', 'Water separator cartridge'],
        ['VOE20976003', 'Donaldson', 'P550529', 'aftermarket', 'Volvo D13 fuel filter'],
        ['VOE20976003', 'Fleetguard', 'FF5507', 'aftermarket', 'Volvo D13 fuel filter'],
        ['721-98-03990', 'NOK / Corteco', 'SK-PC500-BM', 'aftermarket', 'Heavy duty boom cylinder seal kit']
      ];

      for (const [oem, brand, alt, rel, notes] of xrefs) {
        run(
          `INSERT INTO part_cross_refs (part_number_norm, oem_part_number, alt_brand, alt_part_number, alt_part_number_norm, relation_type, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [normalizePartNumber(oem), oem, brand, alt, normalizePartNumber(alt), rel, notes],
          { deferSave: true }
        );
      }
    }

    return { ok: true };
  });
}

function insertParts(bookId, figureId, rows) {
  rows.forEach((p, idx) => {
    run(
      `INSERT INTO figure_parts
        (figure_id, book_id, index_no, code, part_number, part_number_norm, description, indent_level, qty, serial_number_range, kit_ref, refer_to_page, bin_location, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        figureId,
        bookId,
        p.idx || '',
        p.code || '',
        p.pn || '',
        normalizePartNumber(p.pn),
        p.desc,
        p.indent || 0,
        p.qty || '',
        p.sn || '',
        p.kit || '',
        p.refer || '',
        p.bin || '',
        idx + 1
      ],
      { deferSave: true }
    );
  });
}

module.exports = { seedDemoData };
