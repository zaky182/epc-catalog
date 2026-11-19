-- Multi-Brand Heavy Equipment Electronic Parts Catalog (EPC) Schema
-- Compatible with SQLite (default local) and PostgreSQL (via schema adapter)

CREATE TABLE IF NOT EXISTS brands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  logo_url TEXT,
  color TEXT DEFAULT '#f59e0b',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  category TEXT NOT NULL DEFAULT 'Excavator',
  model_name TEXT NOT NULL,
  engine_model TEXT,
  sn_range TEXT,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(brand_id, model_name)
);

CREATE TABLE IF NOT EXISTS part_books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  form_no TEXT,
  title TEXT NOT NULL,
  pdf_filename TEXT,
  pdf_path TEXT,
  total_pages INTEGER DEFAULT 0,
  parser_type TEXT DEFAULT 'komatsu',
  parse_status TEXT DEFAULT 'pending', -- pending | processing | completed | failed
  parse_progress INTEGER DEFAULT 0,
  parse_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES part_books(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  UNIQUE(book_id, code, name)
);

CREATE TABLE IF NOT EXISTS figures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES part_books(id) ON DELETE CASCADE,
  section_id INTEGER REFERENCES sections(id) ON DELETE SET NULL,
  fig_no TEXT NOT NULL,
  title TEXT NOT NULL,
  variant_note TEXT,
  diagram_image_url TEXT,
  pdf_page_start INTEGER,
  pdf_page_end INTEGER,
  book_page_label TEXT,
  drawing_code TEXT,
  layout_type TEXT DEFAULT 'landscape', -- landscape | portrait_css | generic
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS figure_parts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  figure_id INTEGER NOT NULL REFERENCES figures(id) ON DELETE CASCADE,
  book_id INTEGER NOT NULL REFERENCES part_books(id) ON DELETE CASCADE,
  index_no TEXT,
  code TEXT, -- A1, A2, A3, A4, B1, B2, C1, C2, C3
  part_number TEXT,
  part_number_norm TEXT, -- Stripped uppercase alphanumeric for fast search
  description TEXT NOT NULL,
  indent_level INTEGER DEFAULT 0, -- 0, 1, 2, 3 from bullet dots
  qty TEXT,
  serial_number_range TEXT,
  kit_ref TEXT, -- e.g. K26
  refer_to_page TEXT, -- e.g. 125 or T018004
  notes TEXT,
  bin_location TEXT,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS part_cross_refs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  part_number_norm TEXT NOT NULL,
  oem_part_number TEXT NOT NULL,
  alt_brand TEXT NOT NULL, -- Donaldson, Fleetguard, Sakura, ITR, OEM Superseded
  alt_part_number TEXT NOT NULL,
  alt_part_number_norm TEXT NOT NULL,
  relation_type TEXT DEFAULT 'aftermarket', -- aftermarket | interchangeable | supersedes
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Performance indexes for instant search across brands/models
CREATE INDEX IF NOT EXISTS idx_models_brand ON models(brand_id);
CREATE INDEX IF NOT EXISTS idx_books_model ON part_books(model_id);
CREATE INDEX IF NOT EXISTS idx_sections_book ON sections(book_id);
CREATE INDEX IF NOT EXISTS idx_figures_book ON figures(book_id);
CREATE INDEX IF NOT EXISTS idx_figures_section ON figures(section_id);
CREATE INDEX IF NOT EXISTS idx_figures_figno ON figures(fig_no);
CREATE INDEX IF NOT EXISTS idx_figures_page ON figures(book_id, book_page_label);
CREATE INDEX IF NOT EXISTS idx_parts_figure ON figure_parts(figure_id);
CREATE INDEX IF NOT EXISTS idx_parts_book ON figure_parts(book_id);
CREATE INDEX IF NOT EXISTS idx_parts_pn_norm ON figure_parts(part_number_norm);
CREATE INDEX IF NOT EXISTS idx_parts_desc ON figure_parts(description);
CREATE INDEX IF NOT EXISTS idx_parts_kit ON figure_parts(book_id, kit_ref);
CREATE INDEX IF NOT EXISTS idx_cross_pn ON part_cross_refs(part_number_norm);
CREATE INDEX IF NOT EXISTS idx_cross_alt ON part_cross_refs(alt_part_number_norm);
