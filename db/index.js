const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'epc.sqlite');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

let db = null;
let saveTimer = null;

function normalizePartNumber(pn) {
  if (!pn) return '';
  return String(pn)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

async function initDb() {
  if (db) return db;

  fs.mkdirSync(DATA_DIR, { recursive: true });

  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA foreign_keys = ON;');
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schema);

  seedDefaultBrands();
  saveNow();
  return db;
}

function seedDefaultBrands() {
  const defaults = [
    { name: 'Komatsu', slug: 'komatsu', color: '#f59e0b' },
    { name: 'Volvo', slug: 'volvo', color: '#3b82f6' },
    { name: 'Caterpillar', slug: 'caterpillar', color: '#eab308' },
    { name: 'Hitachi', slug: 'hitachi', color: '#f97316' },
    { name: 'Kobelco', slug: 'kobelco', color: '#06b6d4' },
    { name: 'Scania', slug: 'scania', color: '#ef4444' }
  ];

  const stmt = db.prepare(
    'INSERT OR IGNORE INTO brands (name, slug, color) VALUES (?, ?, ?)'
  );
  for (const b of defaults) {
    stmt.run([b.name, b.slug, b.color]);
  }
  stmt.free();
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveNow();
  }, 400);
}

function saveNow() {
  if (!db) return;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const data = db.export();
  const tempPath = DB_PATH + '.tmp';
  fs.writeFileSync(tempPath, Buffer.from(data));
  fs.renameSync(tempPath, DB_PATH);
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function get(sql, params = []) {
  const rows = all(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

function run(sql, params = [], { deferSave = false } = {}) {
  const stmt = db.prepare(sql);
  stmt.run(params);
  stmt.free();

  const lastIdRow = get('SELECT last_insert_rowid() AS id');
  const changesRow = get('SELECT changes() AS changes');

  if (!deferSave) {
    scheduleSave();
  }

  return {
    lastInsertRowid: lastIdRow ? lastIdRow.id : null,
    changes: changesRow ? changesRow.changes : 0
  };
}

function transaction(fn) {
  db.run('BEGIN TRANSACTION;');
  try {
    const result = fn();
    db.run('COMMIT;');
    saveNow();
    return result;
  } catch (err) {
    try {
      db.run('ROLLBACK;');
    } catch (_) {
      // ignore rollback errors
    }
    throw err;
  }
}

module.exports = {
  initDb,
  all,
  get,
  run,
  transaction,
  saveNow,
  normalizePartNumber,
  DB_PATH,
  DATA_DIR
};
