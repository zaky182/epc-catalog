const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const {
  initDb,
  all,
  get,
  run,
  saveNow,
  normalizePartNumber
} = require('./db');
const { seedDemoData } = require('./db/seed-demo');
const {
  ingestPdfByAdapter,
  ingestCsvCatalog,
  CSV_TEMPLATE
} = require('./parsers');

const PORT = parseInt(process.env.PORT || '3000', 10);
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const DIAGRAMS_DIR = process.env.DIAGRAMS_DIR || path.join(__dirname, 'public', 'diagrams');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(DIAGRAMS_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Static assets (frontend + cropped diagrams)
app.use(express.static(path.join(__dirname, 'public')));
app.use('/diagrams', express.static(DIAGRAMS_DIR));

// Multer config for PDF & CSV uploads (up to 250 MB for large multi-hundred-page part books)
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^A-Za-z0-9._\- ]/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 250 * 1024 * 1024 }
});

// ============================================================================
// HEALTH & STATS
// ============================================================================
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'epc-catalog', timestamp: new Date().toISOString() });
});

app.get('/api/stats', (_req, res) => {
  const stats = {
    brands: get('SELECT COUNT(*) AS c FROM brands').c,
    models: get('SELECT COUNT(*) AS c FROM models').c,
    books: get('SELECT COUNT(*) AS c FROM part_books').c,
    figures: get('SELECT COUNT(*) AS c FROM figures').c,
    parts: get('SELECT COUNT(*) AS c FROM figure_parts').c,
    crossRefs: get('SELECT COUNT(*) AS c FROM part_cross_refs').c
  };
  res.json(stats);
});

app.post('/api/seed-demo', (_req, res) => {
  try {
    seedDemoData();
    res.json({ ok: true, message: 'Demo catalog (Komatsu PC500LC-10R + Volvo EC480D) loaded.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// BRANDS & MODELS
// ============================================================================
app.get('/api/brands', (_req, res) => {
  const rows = all(`
    SELECT b.*,
      (SELECT COUNT(*) FROM models m WHERE m.brand_id = b.id) AS model_count,
      (SELECT COUNT(*) FROM part_books pb JOIN models m ON m.id = pb.model_id WHERE m.brand_id = b.id) AS book_count
    FROM brands b
    ORDER BY b.name ASC
  `);
  res.json(rows);
});

app.post('/api/brands', (req, res) => {
  const { name, color } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Brand name is required' });
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
  try {
    const r = run('INSERT INTO brands (name, slug, color) VALUES (?, ?, ?)', [
      name.trim(),
      slug,
      color || '#f59e0b'
    ]);
    res.status(201).json(get('SELECT * FROM brands WHERE id = ?', [r.lastInsertRowid]));
  } catch (err) {
    res.status(409).json({ error: 'Brand already exists or invalid.' });
  }
});

app.get('/api/models', (req, res) => {
  const { brand_id, category } = req.query;
  const where = [];
  const params = [];
  if (brand_id) {
    where.push('m.brand_id = ?');
    params.push(Number(brand_id));
  }
  if (category) {
    where.push('m.category = ?');
    params.push(category);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = all(
    `SELECT m.*, b.name AS brand_name, b.color AS brand_color,
       (SELECT COUNT(*) FROM part_books pb WHERE pb.model_id = m.id) AS book_count
     FROM models m
     JOIN brands b ON b.id = m.brand_id
     ${whereSql}
     ORDER BY b.name ASC, m.model_name ASC`,
    params
  );

  // Attach part books list for each model
  const books = all('SELECT * FROM part_books ORDER BY id DESC');
  const booksByModel = new Map();
  for (const pb of books) {
    if (!booksByModel.has(pb.model_id)) booksByModel.set(pb.model_id, []);
    booksByModel.get(pb.model_id).push(pb);
  }

  for (const m of rows) {
    m.part_books = booksByModel.get(m.id) || [];
  }

  res.json(rows);
});

app.post('/api/models', (req, res) => {
  const { brand_id, category, model_name, engine_model, sn_range, notes } = req.body || {};
  if (!brand_id || !model_name) {
    return res.status(400).json({ error: 'brand_id and model_name are required' });
  }
  try {
    const r = run(
      `INSERT INTO models (brand_id, category, model_name, engine_model, sn_range, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        Number(brand_id),
        category || 'Excavator',
        model_name.trim(),
        engine_model || '',
        sn_range || '',
        notes || ''
      ]
    );
    res.status(201).json(get('SELECT * FROM models WHERE id = ?', [r.lastInsertRowid]));
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

// ============================================================================
// PART BOOKS, TREE NAVIGATION & PDF STREAMING
// ============================================================================
app.get('/api/books/:id/status', (req, res) => {
  const book = get('SELECT * FROM part_books WHERE id = ?', [Number(req.params.id)]);
  if (!book) return res.status(404).json({ error: 'Part book not found' });
  res.json(book);
});

app.get('/api/books/:id/tree', (req, res) => {
  const bookId = Number(req.params.id);
  const book = get(
    `SELECT pb.*, m.model_name, m.engine_model, m.sn_range, m.category, b.name AS brand_name, b.color AS brand_color
     FROM part_books pb
     JOIN models m ON m.id = pb.model_id
     JOIN brands b ON b.id = m.brand_id
     WHERE pb.id = ?`,
    [bookId]
  );
  if (!book) return res.status(404).json({ error: 'Part book not found' });

  const sections = all(
    'SELECT * FROM sections WHERE book_id = ? ORDER BY sort_order ASC, code ASC',
    [bookId]
  );
  const figures = all(
    `SELECT f.*,
       (SELECT COUNT(*) FROM figure_parts fp WHERE fp.figure_id = f.id) AS part_count
     FROM figures f
     WHERE f.book_id = ?
     ORDER BY f.sort_order ASC, f.id ASC`,
    [bookId]
  );

  const figsBySec = new Map();
  for (const fig of figures) {
    const key = fig.section_id || 0;
    if (!figsBySec.has(key)) figsBySec.set(key, []);
    figsBySec.get(key).push(fig);
  }

  const tree = sections.map((sec) => ({
    ...sec,
    figures: figsBySec.get(sec.id) || []
  }));

  res.json({
    book: {
      ...book,
      has_pdf: Boolean(book.pdf_path && fs.existsSync(book.pdf_path))
    },
    sections: tree
  });
});

app.get('/api/books/:id/pdf', (req, res) => {
  const book = get('SELECT pdf_path, pdf_filename FROM part_books WHERE id = ?', [
    Number(req.params.id)
  ]);
  if (!book || !book.pdf_path || !fs.existsSync(book.pdf_path)) {
    return res.status(404).json({ error: 'Original PDF file is not stored on server.' });
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `inline; filename="${(book.pdf_filename || 'partbook.pdf').replace(/"/g, '')}"`
  );
  fs.createReadStream(book.pdf_path).pipe(res);
});

app.delete('/api/books/:id', (req, res) => {
  const bookId = Number(req.params.id);
  const book = get('SELECT * FROM part_books WHERE id = ?', [bookId]);
  if (!book) return res.status(404).json({ error: 'Part book not found' });
  run('DELETE FROM part_books WHERE id = ?', [bookId]);
  saveNow();
  res.json({ ok: true });
});

// ============================================================================
// FIGURES, PARTS, KITS & CROSS-PAGE REFERENCES
// ============================================================================
app.get('/api/figures/:id', (req, res) => {
  const figId = Number(req.params.id);
  const figure = get(
    `SELECT f.*, s.code AS section_code, s.name AS section_name,
            pb.title AS book_title, pb.form_no, pb.pdf_path,
            m.model_name, m.engine_model, m.sn_range,
            b.name AS brand_name, b.color AS brand_color
     FROM figures f
     LEFT JOIN sections s ON s.id = f.section_id
     JOIN part_books pb ON pb.id = f.book_id
     JOIN models m ON m.id = pb.model_id
     JOIN brands b ON b.id = m.brand_id
     WHERE f.id = ?`,
    [figId]
  );
  if (!figure) return res.status(404).json({ error: 'Figure not found' });

  const parts = all(
    `SELECT fp.*,
       (SELECT COUNT(*) FROM part_cross_refs cr WHERE cr.part_number_norm = fp.part_number_norm AND fp.part_number_norm != '') AS cross_ref_count
     FROM figure_parts fp
     WHERE fp.figure_id = ?
     ORDER BY fp.sort_order ASC, fp.id ASC`,
    [figId]
  );

  const hasPdf = Boolean(figure.pdf_path && fs.existsSync(figure.pdf_path));
  delete figure.pdf_path;

  res.json({
    figure: { ...figure, has_pdf: hasPdf },
    parts
  });
});

// Jump target for "(Refer to Page 125)"
app.get('/api/books/:bookId/page/:pageLabel', (req, res) => {
  const bookId = Number(req.params.bookId);
  const label = String(req.params.pageLabel || '').trim();
  let fig = get(
    'SELECT id, fig_no, title FROM figures WHERE book_id = ? AND (book_page_label = ? OR CAST(pdf_page_start AS TEXT) = ?) LIMIT 1',
    [bookId, label, label]
  );
  if (!fig && /^\d+$/.test(label)) {
    const p = Number(label);
    fig = get(
      'SELECT id, fig_no, title FROM figures WHERE book_id = ? AND pdf_page_start <= ? AND pdf_page_end >= ? LIMIT 1',
      [bookId, p, p]
    );
  }
  if (!fig) return res.status(404).json({ error: `Page "${label}" not found in this part book.` });
  res.json(fig);
});

// Service Kit modal lookup: "(Kit : K26)"
app.get('/api/books/:bookId/kits/:kitRef', (req, res) => {
  const bookId = Number(req.params.bookId);
  const kitRef = String(req.params.kitRef || '').trim().toUpperCase();

  // Kit header row in FIG. KIT
  const kitHeader = get(
    `SELECT fp.*, f.fig_no, f.title AS fig_title
     FROM figure_parts fp
     JOIN figures f ON f.id = fp.figure_id
     WHERE fp.book_id = ? AND (UPPER(fp.index_no) = ? OR (UPPER(f.fig_no) = 'KIT' AND UPPER(fp.kit_ref) = ?))
     LIMIT 1`,
    [bookId, kitRef, kitRef]
  );

  // All component parts belonging to this kit across the book
  const components = all(
    `SELECT fp.*, f.fig_no, f.title AS fig_title
     FROM figure_parts fp
     JOIN figures f ON f.id = fp.figure_id
     WHERE fp.book_id = ? AND UPPER(fp.kit_ref) = ? AND UPPER(f.fig_no) != 'KIT'
     ORDER BY f.sort_order ASC, fp.sort_order ASC`,
    [bookId, kitRef]
  );

  res.json({
    kit_ref: kitRef,
    kit_header: kitHeader || null,
    components
  });
});

// ============================================================================
// GLOBAL OMNISEARCH & WHERE-USED & CROSS-REFERENCES
// ============================================================================
app.get('/api/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  const brandId = req.query.brand_id ? Number(req.query.brand_id) : null;
  const modelId = req.query.model_id ? Number(req.query.model_id) : null;
  const limit = Math.min(100, parseInt(req.query.limit || '50', 10));

  if (q.length < 2) {
    return res.json({ query: q, results: [], crossRefMatches: [] });
  }

  const qNorm = normalizePartNumber(q);
  const qLike = `%${q.toLowerCase()}%`;
  const qNormLike = `%${qNorm}%`;

  const extraFilters = [];
  const params = [qNormLike, qLike, qLike, qLike];

  if (brandId) {
    extraFilters.push('b.id = ?');
    params.push(brandId);
  }
  if (modelId) {
    extraFilters.push('m.id = ?');
    params.push(modelId);
  }

  const filterSql = extraFilters.length ? `AND ${extraFilters.join(' AND ')}` : '';
  params.push(limit);

  const results = all(
    `SELECT fp.id, fp.figure_id, fp.book_id, fp.index_no, fp.code, fp.part_number, fp.part_number_norm,
            fp.description, fp.qty, fp.serial_number_range, fp.kit_ref, fp.bin_location,
            f.fig_no, f.title AS fig_title,
            pb.title AS book_title,
            m.id AS model_id, m.model_name, m.category,
            b.id AS brand_id, b.name AS brand_name, b.color AS brand_color
     FROM figure_parts fp
     JOIN figures f ON f.id = fp.figure_id
     JOIN part_books pb ON pb.id = fp.book_id
     JOIN models m ON m.id = pb.model_id
     JOIN brands b ON b.id = m.brand_id
     WHERE (
       (fp.part_number_norm != '' AND fp.part_number_norm LIKE ?)
       OR LOWER(fp.description) LIKE ?
       OR LOWER(f.title) LIKE ?
       OR LOWER(f.fig_no) LIKE ?
     )
     ${filterSql}
     ORDER BY
       CASE WHEN fp.part_number_norm = '${qNorm.replace(/'/g, '')}' THEN 0
            WHEN fp.part_number_norm LIKE '${qNorm.replace(/'/g, '')}%' THEN 1
            ELSE 2 END,
       b.name ASC, m.model_name ASC
     LIMIT ?`,
    params
  );

  // Also search aftermarket cross-references (e.g. searching "P550881" finds Komatsu "600-319-3841")
  const crossRefMatches =
    qNorm.length >= 3
      ? all(
          `SELECT * FROM part_cross_refs
           WHERE alt_part_number_norm LIKE ? OR part_number_norm LIKE ?
           LIMIT 20`,
          [qNormLike, qNormLike]
        )
      : [];

  res.json({ query: q, results, crossRefMatches });
});

app.get('/api/parts/:pnNorm/where-used', (req, res) => {
  const pnNorm = normalizePartNumber(req.params.pnNorm);
  if (!pnNorm) return res.status(400).json({ error: 'Invalid part number' });

  const usages = all(
    `SELECT fp.id, fp.figure_id, fp.book_id, fp.index_no, fp.code, fp.part_number, fp.description,
            fp.qty, fp.serial_number_range, fp.kit_ref, fp.bin_location, fp.notes,
            f.fig_no, f.title AS fig_title,
            pb.title AS book_title,
            m.model_name, m.category,
            b.name AS brand_name, b.color AS brand_color
     FROM figure_parts fp
     JOIN figures f ON f.id = fp.figure_id
     JOIN part_books pb ON pb.id = fp.book_id
     JOIN models m ON m.id = pb.model_id
     JOIN brands b ON b.id = m.brand_id
     WHERE fp.part_number_norm = ?
     ORDER BY b.name ASC, m.model_name ASC, f.fig_no ASC`,
    [pnNorm]
  );

  const crossRefs = all(
    `SELECT * FROM part_cross_refs
     WHERE part_number_norm = ? OR alt_part_number_norm = ?
     ORDER BY alt_brand ASC`,
    [pnNorm, pnNorm]
  );

  res.json({
    part_number_norm: pnNorm,
    display_part_number: usages[0]?.part_number || crossRefs[0]?.oem_part_number || pnNorm,
    usages,
    cross_refs: crossRefs
  });
});

app.post('/api/cross-refs', (req, res) => {
  const { oem_part_number, alt_brand, alt_part_number, relation_type, notes } = req.body || {};
  if (!oem_part_number || !alt_brand || !alt_part_number) {
    return res.status(400).json({ error: 'oem_part_number, alt_brand, and alt_part_number are required' });
  }
  const r = run(
    `INSERT INTO part_cross_refs
      (part_number_norm, oem_part_number, alt_brand, alt_part_number, alt_part_number_norm, relation_type, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      normalizePartNumber(oem_part_number),
      oem_part_number.trim(),
      alt_brand.trim(),
      alt_part_number.trim(),
      normalizePartNumber(alt_part_number),
      relation_type || 'aftermarket',
      notes || ''
    ]
  );
  res.status(201).json(get('SELECT * FROM part_cross_refs WHERE id = ?', [r.lastInsertRowid]));
});

app.delete('/api/cross-refs/:id', (req, res) => {
  run('DELETE FROM part_cross_refs WHERE id = ?', [Number(req.params.id)]);
  res.json({ ok: true });
});

// ============================================================================
// ADMIN INLINE CORRECTION EDITOR
// ============================================================================
app.put('/api/parts/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = get('SELECT * FROM figure_parts WHERE id = ?', [id]);
  if (!existing) return res.status(404).json({ error: 'Part row not found' });

  const {
    index_no = existing.index_no,
    code = existing.code,
    part_number = existing.part_number,
    description = existing.description,
    indent_level = existing.indent_level,
    qty = existing.qty,
    serial_number_range = existing.serial_number_range,
    kit_ref = existing.kit_ref,
    refer_to_page = existing.refer_to_page,
    bin_location = existing.bin_location,
    notes = existing.notes
  } = req.body || {};

  run(
    `UPDATE figure_parts
     SET index_no = ?, code = ?, part_number = ?, part_number_norm = ?,
         description = ?, indent_level = ?, qty = ?, serial_number_range = ?,
         kit_ref = ?, refer_to_page = ?, bin_location = ?, notes = ?
     WHERE id = ?`,
    [
      index_no,
      String(code || '').toUpperCase(),
      part_number,
      normalizePartNumber(part_number),
      description,
      Number(indent_level) || 0,
      qty,
      serial_number_range,
      String(kit_ref || '').toUpperCase(),
      refer_to_page,
      bin_location,
      notes,
      id
    ]
  );

  res.json(get('SELECT * FROM figure_parts WHERE id = ?', [id]));
});

app.post('/api/figures/:id/parts', (req, res) => {
  const figId = Number(req.params.id);
  const fig = get('SELECT id, book_id FROM figures WHERE id = ?', [figId]);
  if (!fig) return res.status(404).json({ error: 'Figure not found' });

  const {
    index_no = '',
    code = '',
    part_number = '',
    description = '',
    indent_level = 0,
    qty = '1',
    serial_number_range = '',
    kit_ref = '',
    refer_to_page = '',
    bin_location = '',
    notes = ''
  } = req.body || {};

  if (!description && !part_number) {
    return res.status(400).json({ error: 'part_number or description is required' });
  }

  const maxOrder = get('SELECT COALESCE(MAX(sort_order), 0) AS m FROM figure_parts WHERE figure_id = ?', [
    figId
  ]).m;

  const r = run(
    `INSERT INTO figure_parts
      (figure_id, book_id, index_no, code, part_number, part_number_norm, description, indent_level, qty, serial_number_range, kit_ref, refer_to_page, bin_location, notes, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      figId,
      fig.book_id,
      index_no,
      String(code).toUpperCase(),
      part_number,
      normalizePartNumber(part_number),
      description || part_number,
      Number(indent_level) || 0,
      qty,
      serial_number_range,
      String(kit_ref).toUpperCase(),
      refer_to_page,
      bin_location,
      notes,
      maxOrder + 1
    ]
  );
  res.status(201).json(get('SELECT * FROM figure_parts WHERE id = ?', [r.lastInsertRowid]));
});

app.delete('/api/parts/:id', (req, res) => {
  run('DELETE FROM figure_parts WHERE id = ?', [Number(req.params.id)]);
  res.json({ ok: true });
});

// ============================================================================
// UPLOAD & INGESTION (PDF & CSV)
// ============================================================================
function resolveOrCreateBrandAndModel({ brand_name, model_name, category, engine_model, sn_range }) {
  const bName = (brand_name || 'Komatsu').trim();
  const slug = bName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  let brand = get('SELECT * FROM brands WHERE slug = ? OR LOWER(name) = LOWER(?)', [slug, bName]);
  if (!brand) {
    const r = run('INSERT INTO brands (name, slug) VALUES (?, ?)', [bName, slug]);
    brand = get('SELECT * FROM brands WHERE id = ?', [r.lastInsertRowid]);
  }

  const mName = (model_name || 'Unknown Model').trim();
  let model = get('SELECT * FROM models WHERE brand_id = ? AND LOWER(model_name) = LOWER(?)', [
    brand.id,
    mName
  ]);
  if (!model) {
    const r = run(
      'INSERT INTO models (brand_id, category, model_name, engine_model, sn_range) VALUES (?, ?, ?, ?, ?)',
      [brand.id, category || 'Excavator', mName, engine_model || '', sn_range || '']
    );
    model = get('SELECT * FROM models WHERE id = ?', [r.lastInsertRowid]);
  }

  return { brand, model };
}

app.post('/api/upload/pdf', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'PDF file is required' });

  const {
    brand_name,
    model_name,
    category,
    engine_model,
    sn_range,
    form_no,
    title,
    parser_type = 'komatsu'
  } = req.body || {};

  const { model } = resolveOrCreateBrandAndModel({
    brand_name,
    model_name: model_name || path.basename(req.file.originalname, '.pdf'),
    category,
    engine_model,
    sn_range
  });

  const bookTitle = (title || path.basename(req.file.originalname, '.pdf')).trim();
  const bookId = run(
    `INSERT INTO part_books (model_id, form_no, title, pdf_filename, pdf_path, parser_type, parse_status, parse_progress, parse_message)
     VALUES (?, ?, ?, ?, ?, ?, 'processing', 0, 'Queued for ingestion...')`,
    [model.id, form_no || '', bookTitle, req.file.originalname, req.file.path, parser_type]
  ).lastInsertRowid;

  saveNow();

  // Trigger async background ingestion so HTTP returns immediately & UI polls progress
  setImmediate(async () => {
    try {
      await ingestPdfByAdapter({
        parserType: parser_type,
        pdfPath: req.file.path,
        bookId
      });
    } catch (err) {
      run(
        'UPDATE part_books SET parse_status = ?, parse_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        ['failed', `Parse error: ${err.message}`, bookId]
      );
      saveNow();
    }
  });

  res.status(202).json({
    ok: true,
    book_id: bookId,
    status_url: `/api/books/${bookId}/status`
  });
});

app.post('/api/upload/csv', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'CSV file is required' });

  try {
    const { brand_name, model_name, category, engine_model, sn_range, form_no, title } = req.body || {};
    const { model } = resolveOrCreateBrandAndModel({
      brand_name,
      model_name: model_name || path.basename(req.file.originalname, '.csv'),
      category,
      engine_model,
      sn_range
    });

    const bookId = run(
      `INSERT INTO part_books (model_id, form_no, title, pdf_filename, parser_type, parse_status, parse_progress)
       VALUES (?, ?, ?, ?, 'csv', 'processing', 10)`,
      [model.id, form_no || '', (title || req.file.originalname).trim(), req.file.originalname]
    ).lastInsertRowid;

    const csvText = fs.readFileSync(req.file.path, 'utf8');
    const summary = ingestCsvCatalog({ csvText, bookId });
    fs.unlinkSync(req.file.path);

    res.status(201).json({ ok: true, book_id: bookId, ...summary });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/templates/csv', (_req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="epc-catalog-template.csv"');
  res.send(CSV_TEMPLATE);
});

// Fallback SPA route
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================================
// BOOTSTRAP
// ============================================================================
async function start() {
  await initDb();

  // Auto-seed demo data on very first launch when database has no models yet
  const modelCount = get('SELECT COUNT(*) AS c FROM models').c;
  if (modelCount === 0) {
    seedDemoData();
    console.log('[EPC] Initialized with demo sample catalog (Komatsu PC500LC-10R & Volvo EC480D).');
  }

  app.listen(PORT, () => {
    console.log(`[EPC] Multi-Brand Spare Parts Catalog running at http://localhost:${PORT}`);
  });
}

if (require.main === module) {
  start().catch((err) => {
    console.error('[EPC] Fatal startup error:', err);
    process.exit(1);
  });
}

module.exports = { app, start };
