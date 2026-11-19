#!/usr/bin/env node
/**
 * CLI Batch Ingestion Tool for Local PDF Part Books
 * Usage:
 *   node scripts/ingest-pdf.js "D:\DATA\Downloads\Part Book PC500LC-10R + Arm 2900 mm.pdf" --brand Komatsu --model PC500LC-10R --form FEN04597-00
 */
const fs = require('fs');
const path = require('path');
const { initDb, get, run, saveNow } = require('../db');
const { ingestPdfByAdapter } = require('../parsers');

function parseArgs(argv) {
  const args = { pdfPath: null, brand: 'Komatsu', model: '', category: 'Excavator', form: '', parser: 'komatsu' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--brand' && argv[i + 1]) args.brand = argv[++i];
    else if (a === '--model' && argv[i + 1]) args.model = argv[++i];
    else if (a === '--category' && argv[i + 1]) args.category = argv[++i];
    else if (a === '--form' && argv[i + 1]) args.form = argv[++i];
    else if (a === '--parser' && argv[i + 1]) args.parser = argv[++i];
    else if (!a.startsWith('--') && !args.pdfPath) args.pdfPath = a;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.pdfPath) {
    console.error('Usage: node scripts/ingest-pdf.js <path-to-pdf> [--brand Komatsu] [--model PC500LC-10R] [--form FEN04597-00]');
    process.exit(1);
  }

  const absPath = path.resolve(args.pdfPath);
  if (!fs.existsSync(absPath)) {
    console.error(`File not found: ${absPath}`);
    process.exit(1);
  }

  await initDb();

  const slug = args.brand.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  let brand = get('SELECT * FROM brands WHERE slug = ?', [slug]);
  if (!brand) {
    const r = run('INSERT INTO brands (name, slug) VALUES (?, ?)', [args.brand, slug]);
    brand = get('SELECT * FROM brands WHERE id = ?', [r.lastInsertRowid]);
  }

  const modelName = args.model || path.basename(absPath, '.pdf');
  let model = get('SELECT * FROM models WHERE brand_id = ? AND LOWER(model_name) = LOWER(?)', [
    brand.id,
    modelName
  ]);
  if (!model) {
    const r = run('INSERT INTO models (brand_id, category, model_name) VALUES (?, ?, ?)', [
      brand.id,
      args.category,
      modelName
    ]);
    model = get('SELECT * FROM models WHERE id = ?', [r.lastInsertRowid]);
  }

  const bookTitle = path.basename(absPath, '.pdf');
  const bookId = run(
    `INSERT INTO part_books (model_id, form_no, title, pdf_filename, pdf_path, parser_type, parse_status)
     VALUES (?, ?, ?, ?, ?, ?, 'processing')`,
    [model.id, args.form, bookTitle, path.basename(absPath), absPath, args.parser]
  ).lastInsertRowid;

  console.log(`[Ingest] Starting "${bookTitle}" (Book ID: ${bookId}, Brand: ${brand.name}, Model: ${model.model_name})...`);
  const startTime = Date.now();

  const result = await ingestPdfByAdapter({
    parserType: args.parser,
    pdfPath: absPath,
    bookId,
    onProgress: (pct, page, total) => {
      process.stdout.write(`\r[Ingest] Progress: ${pct}% (Page ${page}/${total})`);
    }
  });

  saveNow();
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n[Ingest] Done in ${elapsed}s! Pages: ${result.totalPages}, Figures: ${result.figuresCount}, Parts: ${result.partsCount}`);
}

main().catch((err) => {
  console.error('\n[Ingest] Error:', err);
  process.exit(1);
});
