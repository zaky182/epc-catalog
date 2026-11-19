# HeavyEPC — Katalog Spare Part Alat Berat Multi-Merk

Aplikasi web **Electronic Parts Catalog (EPC)** terpusat untuk mengelola, mencari, dan menampilkan katalog spare part alat berat multi-merk (**Komatsu, Volvo, Caterpillar, Hitachi, Kobelco, Scania**, dll.) yang bersumber dari file **PDF Part Book** maupun **CSV**.

## Fitur Utama
- **Multi-Merk & Multi-Model:** Navigasi hierarki `Merk → Model & Part Book → Section → Figure`.
- **Smart Komatsu PDF Ingestion (`parsers/komatsu.js`):**
  - Mendukung otomatis **2 layout dalam 1 file PDF**:
    1. **Standard Komatsu Landscape** (Kiri = *Exploded Diagram*, Kanan = *Parts Table*, otomatis menggabungkan halaman lanjutan untuk `FIG.` yang sama).
    2. **Komatsu CSS Portrait Supplement** (misal lampiran `+ Arm 2900 mm` dengan `Reference:` dan `Page:`).
  - Otomatis melewati `FOREWORD` multibahasa & `NUMERICAL INDEX`.
  - Mendeteksi hierarki BOM (`•`, `• •`, `• • •`), kode khusus (`A1–A4`, `B1–B2`, `C1–C3`), `(Kit : Kxx)`, dan `(Refer to Page xxx)`.
- **Dual-Mode Exploded Diagram Viewer:**
  - Jika `pdftoppm` (Poppler) tersedia (otomatis di Docker), diagram diekstrak ke WebP super cepat.
  - Jika berjalan lokal tanpa Poppler, browser merender & meng-crop langsung halaman PDF asli dengan PDF.js (vektor tajam + **Zoom, Pan, Reset, Fullscreen**).
- **Global Omnisearch (`Ctrl+K`):** Cari Part Number dengan atau tanpa strip (`6251-11-5440` atau `6251115440`), deskripsi, atau nomor filter aftermarket (`P550881`).
- **Where-Used & Aftermarket Cross-Reference:** Klik Part Number untuk melihat semua unit/figure pemakai serta persamaan merk aftermarket (Donaldson, Fleetguard, Sakura, dll.).
- **Service Kit Modal & Cross-Page Link:** Klik badge `Kit: K26` untuk melihat isi Seal Kit lengkap, atau klik `→ Hal. 125` untuk langsung melompat ke figure terkait.
- **Picking List / Part Cart:** Kumpulkan daftar permintaan part, lalu copy format **WhatsApp** atau **Export CSV (Excel)**.
- **Admin Inline Editor & Universal CSV Import:** Koreksi baris tabel langsung di UI atau impor katalog merk lain lewat CSV.

## Cara Menjalankan

### Opsi 1: Node.js Lokal (Windows / Linux / macOS)
Pastikan [Node.js](https://nodejs.org/) (v18+) sudah terpasang:
```bash
npm install
npm start
```
Buka browser ke `http://localhost:3000`.

Untuk langsung mengimpor file PDF Part Book lokal lewat CLI:
```bash
node scripts/ingest-pdf.js "D:\DATA\Downloads\Part Book PC500LC-10R + Arm 2900 mm.pdf" --brand Komatsu --model PC500LC-10R --form FEN04597-00
```

### Opsi 2: Docker / EasyPanel (Direkomendasikan untuk Produksi)
```bash
docker compose up -d --build
```
Container sudah menyertakan `poppler-utils` (`pdftoppm`) sehingga cropping diagram WebP berjalan otomatis di server.

## Menjalankan Tes Parser
```bash
npm run test:parser
```
