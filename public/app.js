(() => {
  const CODE_TOOLTIPS = {
    A1: 'A1: Interchangeable (new & old parts can be used interchangeably)',
    A2: 'A2: One-way interchangeable (new part can replace old part)',
    A3: 'A3: Interchangeable as a set',
    A4: 'A4: Interchangeable with modification',
    B1: 'B1: Discontinued / Superseded',
    B2: 'B2: Non-reusable / Superseded by assembly',
    C1: 'C1: Not sold separately — supplied only as part of parent Assembly',
    C2: 'C2: Supplied only through authorized distributor',
    C3: 'C3: Semi-finished part (requires machining)'
  };

  const state = {
    brands: [],
    models: [],
    currentBookId: null,
    currentTree: null,
    currentFigure: null,
    currentParts: [],
    adminEditMode: false,
    cart: JSON.parse(localStorage.getItem('epc_cart') || '[]'),
    // Diagram zoom/pan state
    zoom: 1,
    panX: 0,
    panY: 0,
    isPanning: false,
    panStartX: 0,
    panStartY: 0,
    pdfDocCache: {} // bookId -> PDFDocumentProxy
  };

  const $ = (id) => document.getElementById(id);

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showToast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.classList.add('hidden'), 2600);
  }

  async function api(url, opts = {}) {
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // ==========================================================================
  // INITIALIZATION & CATALOG LOADING
  // ==========================================================================
  async function loadInitialData() {
    const [brands, models, stats] = await Promise.all([
      api('/api/brands'),
      api('/api/models'),
      api('/api/stats')
    ]);
    state.brands = brands;
    state.models = models;

    renderBrandSelectors();
    renderStats(stats);
    renderCartBadge();
    populateModelSelector();
  }

  function renderStats(stats) {
    $('statsGrid').innerHTML = `
      <div class="stat-card"><strong>${stats.brands}</strong><span>Merk Terdaftar</span></div>
      <div class="stat-card"><strong>${stats.models}</strong><span>Model Unit</span></div>
      <div class="stat-card"><strong>${stats.books}</strong><span>Part Books</span></div>
      <div class="stat-card"><strong>${stats.figures}</strong><span>Figures / Diagram</span></div>
      <div class="stat-card"><strong>${stats.parts}</strong><span>Baris Spare Part</span></div>
      <div class="stat-card"><strong>${stats.crossRefs}</strong><span>Cross-Ref Aftermarket</span></div>
    `;
  }

  function renderBrandSelectors() {
    const brandSel = $('brandSelect');
    const searchBrand = $('searchBrandFilter');
    const datalist = $('brandSuggestions');

    const prevBrand = brandSel.value;
    brandSel.innerHTML =
      `<option value="">— Semua Merk —</option>` +
      state.brands
        .map((b) => `<option value="${b.id}">${escapeHtml(b.name)} (${b.model_count})</option>`)
        .join('');
    if (prevBrand) brandSel.value = prevBrand;

    searchBrand.innerHTML =
      `<option value="">Semua Merk</option>` +
      state.brands.map((b) => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');

    datalist.innerHTML = state.brands
      .map((b) => `<option value="${escapeHtml(b.name)}"></option>`)
      .join('');
  }

  function populateModelSelector() {
    const brandId = $('brandSelect').value;
    const filtered = brandId
      ? state.models.filter((m) => String(m.brand_id) === String(brandId))
      : state.models;

    const modelSel = $('modelSelect');
    const options = [];
    for (const m of filtered) {
      if (m.part_books && m.part_books.length > 0) {
        for (const pb of m.part_books) {
          options.push(
            `<option value="${pb.id}">${escapeHtml(m.brand_name)} ${escapeHtml(m.model_name)} — ${escapeHtml(pb.title)}</option>`
          );
        }
      }
    }

    if (options.length === 0) {
      modelSel.innerHTML = `<option value="">Belum ada Part Book</option>`;
      $('sectionTree').innerHTML = `<div class="empty-hint">Belum ada katalog untuk merk ini. Klik "+ Upload Katalog" untuk menambahkan.</div>`;
      $('unitMetaCard').classList.add('hidden');
      return;
    }

    modelSel.innerHTML = options.join('');
    if (state.currentBookId && options.some((o) => o.includes(`value="${state.currentBookId}"`))) {
      modelSel.value = String(state.currentBookId);
    } else {
      loadBookTree(Number(modelSel.value));
    }
  }

  async function loadBookTree(bookId) {
    if (!bookId) return;
    state.currentBookId = bookId;
    const data = await api(`/api/books/${bookId}/tree`);
    state.currentTree = data;

    const b = data.book;
    const meta = $('unitMetaCard');
    meta.classList.remove('hidden');
    meta.innerHTML = `
      <div><strong>${escapeHtml(b.brand_name)} ${escapeHtml(b.model_name)}</strong> (${escapeHtml(b.category)})</div>
      ${b.engine_model ? `<div>Engine: ${escapeHtml(b.engine_model)}</div>` : ''}
      ${b.sn_range ? `<div>S/N: ${escapeHtml(b.sn_range)}</div>` : ''}
      ${b.form_no ? `<div>Form: <code>${escapeHtml(b.form_no)}</code> • ${b.total_pages || 0} hal.</div>` : ''}
    `;

    renderSectionTree($('treeFilterInput').value);
  }

  function renderSectionTree(filterText = '') {
    const treeEl = $('sectionTree');
    if (!state.currentTree) return;
    const q = filterText.trim().toLowerCase();

    const html = state.currentTree.sections
      .map((sec) => {
        const figs = sec.figures.filter(
          (f) =>
            !q ||
            f.fig_no.toLowerCase().includes(q) ||
            f.title.toLowerCase().includes(q) ||
            sec.name.toLowerCase().includes(q)
        );
        if (q && figs.length === 0) return '';

        const isOpen = true;
        return `
          <div class="tree-section">
            <button class="tree-section-btn" data-toggle-sec="${sec.id}">
              <span class="sec-code">${escapeHtml(sec.code)}</span>
              <span>${escapeHtml(sec.name)} (${figs.length})</span>
            </button>
            <div class="tree-figures ${isOpen ? '' : 'hidden'}" data-sec-body="${sec.id}">
              ${figs
                .map(
                  (f) => `
                <button class="tree-fig-btn ${state.currentFigure?.id === f.id ? 'active' : ''}" data-fig-id="${f.id}">
                  <span class="tree-fig-no">FIG. ${escapeHtml(f.fig_no)}</span>
                  <span>${escapeHtml(f.title)}</span>
                </button>`
                )
                .join('')}
            </div>
          </div>
        `;
      })
      .join('');

    treeEl.innerHTML = html || `<div class="empty-hint">Tidak ada figure yang cocok.</div>`;
  }

  // ==========================================================================
  // FIGURE VIEWER & PARTS TABLE
  // ==========================================================================
  async function openFigure(figureId) {
    const data = await api(`/api/figures/${figureId}`);
    state.currentFigure = data.figure;
    state.currentParts = data.parts;

    // Ensure sidebar points to the same book
    if (state.currentBookId !== data.figure.book_id) {
      $('brandSelect').value = '';
      populateModelSelector();
      $('modelSelect').value = String(data.figure.book_id);
      await loadBookTree(data.figure.book_id);
    }

    $('welcomeView').classList.add('hidden');
    $('figureView').classList.remove('hidden');
    $('sidebar').classList.remove('open');

    const f = data.figure;
    $('figBreadcrumbs').textContent = `${f.brand_name} › ${f.model_name} › ${f.section_code || ''} ${f.section_name || ''}`;
    $('figTitle').textContent = `FIG. ${f.fig_no} — ${f.title}${f.variant_note ? ` (${f.variant_note})` : ''}`;

    const pdfBtn = $('btnOpenOriginalPdf');
    if (f.has_pdf) {
      pdfBtn.href = `/api/books/${f.book_id}/pdf#page=${f.pdf_page_start || 1}`;
      pdfBtn.classList.remove('hidden');
    } else {
      pdfBtn.classList.add('hidden');
    }

    $('diagramDrawingCode').textContent = f.drawing_code ? `DWG: ${f.drawing_code}` : `FIG. ${f.fig_no}`;
    $('diagramPageChip').textContent = f.pdf_page_start
      ? `Hal. ${f.pdf_page_start}${f.pdf_page_end && f.pdf_page_end !== f.pdf_page_start ? `–${f.pdf_page_end}` : ''}`
      : '';

    $('figureFilterInput').value = '';
    renderSectionTree($('treeFilterInput').value);
    renderPartsTable();
    renderDiagram(f);
  }

  function renderPartsTable() {
    const q = $('figureFilterInput').value.trim().toLowerCase();
    const qNorm = q.replace(/[^a-z0-9]/g, '');

    const filtered = state.currentParts.filter((p) => {
      if (!q) return true;
      return (
        (p.index_no || '').toLowerCase().includes(q) ||
        (p.part_number || '').toLowerCase().includes(q) ||
        (p.part_number_norm || '').toLowerCase().includes(qNorm || q) ||
        (p.description || '').toLowerCase().includes(q) ||
        (p.kit_ref || '').toLowerCase().includes(q)
      );
    });

    $('partsCountLabel').textContent = `${filtered.length} / ${state.currentParts.length} items`;

    const tbody = $('partsTableBody');
    tbody.innerHTML = filtered
      .map((p) => {
        const dots = p.indent_level > 0 ? `<span class="bom-dots">${'• '.repeat(p.indent_level)}</span>` : '';
        const codeBadge = p.code
          ? `<span class="code-badge ${
              p.code === 'C1'
                ? 'code-c1'
                : p.code.startsWith('A')
                ? 'code-a'
                : p.code.startsWith('B')
                ? 'code-b'
                : 'code-other'
            }" title="${escapeHtml(CODE_TOOLTIPS[p.code] || p.code)}">${escapeHtml(p.code)}</span>`
          : '';

        const pnCell = p.part_number
          ? `<button class="pn-link" data-where-used="${escapeHtml(p.part_number_norm)}">${escapeHtml(p.part_number)}</button>
             ${p.cross_ref_count > 0 ? `<span class="xref-dot" title="${p.cross_ref_count} persamaan aftermarket">Alt:${p.cross_ref_count}</span>` : ''}`
          : `<span class="muted-label">—</span>`;

        const kitBadge = p.kit_ref
          ? `<button class="kit-pill" data-kit="${escapeHtml(p.kit_ref)}">Kit: ${escapeHtml(p.kit_ref)}</button>`
          : '';

        const referBadge = p.refer_to_page
          ? `<button class="refer-pill" data-refer-page="${escapeHtml(p.refer_to_page)}">→ Hal. ${escapeHtml(p.refer_to_page)}</button>`
          : '';

        const binBadge = p.bin_location
          ? `<span class="bin-pill" title="Lokasi Rak Gudang">${escapeHtml(p.bin_location)}</span>`
          : '';

        const adminBtns = state.adminEditMode
          ? `<button class="row-action-btn" data-edit-part="${p.id}" title="Edit baris">✏️</button>
             <button class="row-action-btn" data-del-part="${p.id}" title="Hapus baris">🗑</button>`
          : '';

        return `
          <tr>
            <td class="col-idx">${escapeHtml(p.index_no)}</td>
            <td class="col-code">${codeBadge}</td>
            <td class="col-pn">${pnCell}</td>
            <td class="col-desc">
              <div class="bom-cell" style="padding-left:${p.indent_level * 12}px">
                ${dots}
                <span>${escapeHtml(p.description)}</span>
                ${kitBadge}
                ${referBadge}
                ${binBadge}
              </div>
            </td>
            <td class="col-qty">${escapeHtml(p.qty)}</td>
            <td class="col-sn">${escapeHtml(p.serial_number_range)}</td>
            <td class="col-act">
              ${p.part_number ? `<button class="row-action-btn" data-copy-pn="${escapeHtml(p.part_number)}" title="Copy Part Number">📋</button>` : ''}
              ${p.part_number ? `<button class="row-action-btn" data-add-cart="${p.id}" title="Tambah ke Picking List">+🛒</button>` : ''}
              ${adminBtns}
            </td>
          </tr>
        `;
      })
      .join('');
  }

  // ==========================================================================
  // DIAGRAM VIEWER (Server WebP + Client-side PDF.js Cropped Fallback + Zoom/Pan)
  // ==========================================================================
  function resetDiagramTransform() {
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
    applyDiagramTransform();
  }

  function applyDiagramTransform() {
    $('diagramTransform').style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
    $('zoomPercent').textContent = `${Math.round(state.zoom * 100)}%`;
  }

  async function renderDiagram(figure) {
    resetDiagramTransform();
    const imgEl = $('diagramImage');
    const canvasEl = $('diagramCanvas');
    const placeholderEl = $('diagramPlaceholder');
    const loadingEl = $('diagramLoading');

    imgEl.classList.add('hidden');
    canvasEl.classList.add('hidden');
    placeholderEl.classList.add('hidden');
    loadingEl.classList.add('hidden');

    // Mode 1: Pre-cropped server WebP image exists
    if (figure.diagram_image_url) {
      imgEl.src = figure.diagram_image_url;
      imgEl.classList.remove('hidden');
      return;
    }

    // Mode 2: Render directly from original PDF using client-side PDF.js with smart region crop
    if (figure.has_pdf && figure.pdf_page_start && window.pdfjsLib) {
      loadingEl.classList.remove('hidden');
      try {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
          'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

        let pdfDoc = state.pdfDocCache[figure.book_id];
        if (!pdfDoc) {
          pdfDoc = await window.pdfjsLib.getDocument(`/api/books/${figure.book_id}/pdf`).promise;
          state.pdfDocCache[figure.book_id] = pdfDoc;
        }

        const page = await pdfDoc.getPage(figure.pdf_page_start);
        const scale = 2.0; // High-DPI crisp line drawings
        const viewport = page.getViewport({ scale });

        const offscreen = document.createElement('canvas');
        offscreen.width = viewport.width;
        offscreen.height = viewport.height;
        await page.render({ canvasContext: offscreen.getContext('2d'), viewport }).promise;

        // Crop diagram area based on layout type
        const isPortrait = figure.layout_type === 'portrait_css' || viewport.height > viewport.width;
        const cropW = isPortrait ? viewport.width : Math.floor(viewport.width * 0.49);
        const cropH = isPortrait ? Math.floor(viewport.height * 0.48) : viewport.height;

        canvasEl.width = cropW;
        canvasEl.height = cropH;
        const ctx = canvasEl.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, cropW, cropH);
        ctx.drawImage(offscreen, 0, 0, cropW, cropH, 0, 0, cropW, cropH);

        canvasEl.classList.remove('hidden');
      } catch (err) {
        $('diagramPlaceholderText').textContent = `Gagal merender diagram PDF: ${err.message}`;
        placeholderEl.classList.remove('hidden');
      } finally {
        loadingEl.classList.add('hidden');
      }
      return;
    }

    // Mode 3: Placeholder for CSV / Demo records without attached PDF
    $('diagramPlaceholderText').textContent = `FIG. ${figure.fig_no} — ${figure.title}`;
    placeholderEl.classList.remove('hidden');
  }

  // ==========================================================================
  // GLOBAL OMNISEARCH
  // ==========================================================================
  let searchDebounce = null;
  async function runGlobalSearch() {
    const q = $('globalSearchInput').value.trim();
    const brandId = $('searchBrandFilter').value;
    const dropdown = $('searchDropdown');

    if (q.length < 2) {
      dropdown.classList.add('hidden');
      return;
    }

    const params = new URLSearchParams({ q });
    if (brandId) params.set('brand_id', brandId);
    const data = await api(`/api/search?${params.toString()}`);

    let html = '';

    if (data.crossRefMatches && data.crossRefMatches.length > 0) {
      html += `<div class="search-section-header">Persamaan Aftermarket / Cross-Reference</div>`;
      html += data.crossRefMatches
        .map(
          (cr) => `
        <div class="search-item" data-search-wu="${escapeHtml(cr.part_number_norm)}">
          <div class="search-item-main">
            <span class="search-item-pn">${escapeHtml(cr.alt_brand)}: ${escapeHtml(cr.alt_part_number)} ⇄ OEM ${escapeHtml(cr.oem_part_number)}</span>
            <span class="search-item-meta">${escapeHtml(cr.relation_type)} ${cr.notes ? `• ${escapeHtml(cr.notes)}` : ''}</span>
          </div>
          <span class="xref-dot">Where-Used</span>
        </div>`
        )
        .join('');
    }

    html += `<div class="search-section-header">Hasil Katalog (${data.results.length})</div>`;
    if (data.results.length === 0) {
      html += `<div class="empty-hint">Tidak ditemukan part untuk "${escapeHtml(q)}".</div>`;
    } else {
      html += data.results
        .map(
          (r) => `
        <div class="search-item" data-search-fig="${r.figure_id}">
          <div class="search-item-main">
            <span class="search-item-pn">${escapeHtml(r.part_number || '(Assembly Item)')}</span>
            <span class="search-item-desc">${escapeHtml(r.description)}</span>
            <span class="search-item-meta">
              <strong>${escapeHtml(r.brand_name)} ${escapeHtml(r.model_name)}</strong> • FIG. ${escapeHtml(r.fig_no)} (${escapeHtml(r.fig_title)}) • Qty: ${escapeHtml(r.qty || '-')}
            </span>
          </div>
          <span class="sec-code">${escapeHtml(r.brand_name)}</span>
        </div>`
        )
        .join('');
    }

    dropdown.innerHTML = html;
    dropdown.classList.remove('hidden');
  }

  // ==========================================================================
  // MODALS: WHERE-USED & SERVICE KIT
  // ==========================================================================
  async function openWhereUsedModal(pnNorm) {
    const data = await api(`/api/parts/${encodeURIComponent(pnNorm)}/where-used`);
    $('wuTitle').textContent = `Part Number: ${data.display_part_number}`;
    $('wuSubtitle').textContent = `Dipakai di ${data.usages.length} lokasi • ${data.cross_refs.length} persamaan aftermarket`;

    const usagesHtml = data.usages.length
      ? `<table class="mini-table">
          <thead><tr><th>Merk & Model</th><th>Figure</th><th>Deskripsi</th><th>Qty</th><th>Rak</th><th></th></tr></thead>
          <tbody>
            ${data.usages
              .map(
                (u) => `
              <tr>
                <td><strong>${escapeHtml(u.brand_name)}</strong> ${escapeHtml(u.model_name)}</td>
                <td><code>${escapeHtml(u.fig_no)}</code></td>
                <td>${escapeHtml(u.description)}</td>
                <td>${escapeHtml(u.qty)}</td>
                <td>${escapeHtml(u.bin_location || '-')}</td>
                <td><button class="btn btn-secondary btn-sm" data-jump-fig="${u.figure_id}">Buka</button></td>
              </tr>`
              )
              .join('')}
          </tbody>
        </table>`
      : `<div class="muted-label">Belum ada pemakaian langsung di figure.</div>`;

    const xrefsHtml = data.cross_refs.length
      ? `<table class="mini-table">
          <thead><tr><th>Merk Alt.</th><th>Alt. Part Number</th><th>Relasi</th><th>Catatan</th></tr></thead>
          <tbody>
            ${data.cross_refs
              .map(
                (c) => `
              <tr>
                <td><strong>${escapeHtml(c.alt_brand)}</strong></td>
                <td><code>${escapeHtml(c.alt_part_number)}</code></td>
                <td>${escapeHtml(c.relation_type)}</td>
                <td>${escapeHtml(c.notes || '')}</td>
              </tr>`
              )
              .join('')}
          </tbody>
        </table>`
      : `<div class="muted-label">Belum ada data persamaan aftermarket.</div>`;

    $('wuBody').innerHTML = `
      <div class="detail-section">
        <h4>Where-Used (Dipakai di Unit & Figure)</h4>
        ${usagesHtml}
      </div>
      <div class="detail-section">
        <h4>Cross-Reference Aftermarket / Persamaan</h4>
        ${xrefsHtml}
      </div>
      <div class="detail-section">
        <h4>+ Tambah Persamaan Aftermarket</h4>
        <form id="addXrefForm" class="upload-form">
          <input type="hidden" name="oem_part_number" value="${escapeHtml(data.display_part_number)}" />
          <div class="form-row">
            <div class="field-group"><label>Merk (Donaldson/Sakura/dll)</label><input name="alt_brand" required /></div>
            <div class="field-group"><label>Alt. Part Number</label><input name="alt_part_number" required /></div>
            <div class="field-group"><label>Catatan</label><input name="notes" placeholder="Opsional" /></div>
          </div>
          <button type="submit" class="btn btn-primary btn-sm">Simpan Cross-Reference</button>
        </form>
      </div>
    `;

    $('whereUsedModal').classList.remove('hidden');

    $('addXrefForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(e.target).entries());
      await api('/api/cross-refs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fd)
      });
      showToast('Cross-reference tersimpan!');
      openWhereUsedModal(pnNorm);
    });
  }

  async function openKitModal(bookId, kitRef) {
    const data = await api(`/api/books/${bookId}/kits/${encodeURIComponent(kitRef)}`);
    $('kitTitle').textContent = `Service Kit ${data.kit_ref}`;
    $('kitSubtitle').textContent = data.kit_header
      ? `Kit Part Number: ${data.kit_header.part_number} — ${data.kit_header.description}`
      : `Komponen bertanda Kit ${data.kit_ref}`;

    const headerAction = data.kit_header
      ? `<div style="margin-bottom:14px;display:flex;gap:8px;align-items:center;justify-content:space-between;background:var(--bg);padding:10px;border-radius:6px;border:1px solid var(--border);">
           <div>
             <div style="font-family:var(--font-mono);font-weight:700;color:var(--accent);font-size:15px;">${escapeHtml(data.kit_header.part_number)}</div>
             <div class="muted-label">${escapeHtml(data.kit_header.description)}</div>
           </div>
           <button class="btn btn-primary btn-sm" id="btnAddKitToCart">+ Tambah Kit ke Picking List</button>
         </div>`
      : '';

    const rows = data.components
      .map(
        (c) => `
        <tr>
          <td>${escapeHtml(c.index_no)}</td>
          <td><code>${escapeHtml(c.part_number)}</code></td>
          <td>${escapeHtml(c.description)}</td>
          <td>${escapeHtml(c.qty)}</td>
          <td>${escapeHtml(c.fig_no)}</td>
        </tr>`
      )
      .join('');

    $('kitBody').innerHTML = `
      ${headerAction}
      <table class="mini-table">
        <thead><tr><th>Idx</th><th>Part Number</th><th>Komponen di Dalam Kit</th><th>Qty</th><th>Figure</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="muted-label">Detail komponen kit tidak ditemukan.</td></tr>'}</tbody>
      </table>
    `;

    $('kitModal').classList.remove('hidden');

    const btnKitCart = $('btnAddKitToCart');
    if (btnKitCart && data.kit_header) {
      btnKitCart.addEventListener('click', () => {
        addToCart({
          part_number: data.kit_header.part_number,
          description: data.kit_header.description,
          qty: 1,
          unit: `${state.currentFigure?.brand_name || ''} ${state.currentFigure?.model_name || ''}`.trim(),
          fig_no: 'KIT'
        });
      });
    }
  }

  // ==========================================================================
  // PICKING LIST / PART CART
  // ==========================================================================
  function saveCart() {
    localStorage.setItem('epc_cart', JSON.stringify(state.cart));
    renderCartBadge();
    renderCartDrawer();
  }

  function renderCartBadge() {
    $('cartBadge').textContent = state.cart.reduce((acc, i) => acc + (Number(i.qty) || 1), 0);
  }

  function addToCart(item) {
    const existing = state.cart.find((c) => c.part_number === item.part_number);
    if (existing) {
      existing.qty = (Number(existing.qty) || 1) + (Number(item.qty) || 1);
    } else {
      state.cart.push({ ...item, qty: Number(item.qty) || 1 });
    }
    saveCart();
    showToast(`Ditambahkan: ${item.part_number}`);
  }

  function renderCartDrawer() {
    const body = $('cartItemsList');
    if (state.cart.length === 0) {
      body.innerHTML = `<div class="empty-hint">Picking list masih kosong. Klik "+🛒" pada baris part untuk menambahkan.</div>`;
      return;
    }

    body.innerHTML = state.cart
      .map(
        (c, idx) => `
      <div class="cart-item">
        <div class="cart-item-top">
          <strong style="font-family:var(--font-mono);color:var(--accent)">${escapeHtml(c.part_number)}</strong>
          <button class="row-action-btn" data-cart-del="${idx}">✕</button>
        </div>
        <div style="font-size:12.5px">${escapeHtml(c.description)}</div>
        <div class="cart-item-top">
          <small class="muted-label">${escapeHtml(c.unit || '')} ${c.fig_no ? `• FIG. ${escapeHtml(c.fig_no)}` : ''}</small>
          <div class="cart-item-controls">
            <span class="muted-label">Qty:</span>
            <input class="cart-qty-input" type="number" min="1" value="${c.qty}" data-cart-qty="${idx}" />
          </div>
        </div>
      </div>`
      )
      .join('');
  }

  function copyCartAsWhatsApp() {
    if (state.cart.length === 0) return showToast('Picking list masih kosong.');
    const note = $('cartUnitNote').value.trim();
    const lines = ['*PERMINTAAN SPARE PART (PICKING LIST)*'];
    if (note) lines.push(`Unit / WO: ${note}`);
    lines.push('');
    state.cart.forEach((c, i) => {
      lines.push(`${i + 1}. *${c.part_number}* — ${c.description} (Qty: ${c.qty})`);
    });
    navigator.clipboard.writeText(lines.join('\n')).then(() => {
      showToast('Teks Picking List disalin! Siap paste ke WhatsApp.');
    });
  }

  function exportCartCsv() {
    if (state.cart.length === 0) return showToast('Picking list masih kosong.');
    const header = 'No,Part Number,Description,Qty,Unit,Figure,Note';
    const note = $('cartUnitNote').value.trim().replace(/"/g, '""');
    const rows = state.cart.map(
      (c, i) =>
        `${i + 1},"${c.part_number}","${(c.description || '').replace(/"/g, '""')}",${c.qty},"${c.unit || ''}","${c.fig_no || ''}","${note}"`
    );
    const blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `picking-list-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  }

  // ==========================================================================
  // EVENT LISTENERS
  // ==========================================================================
  function bindEvents() {
    // Theme toggle
    const savedTheme = localStorage.getItem('epc_theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    $('btnThemeToggle').addEventListener('click', () => {
      const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('epc_theme', next);
    });

    $('btnToggleSidebar').addEventListener('click', () => $('sidebar').classList.toggle('open'));
    $('logoHome').addEventListener('click', () => {
      $('figureView').classList.add('hidden');
      $('welcomeView').classList.remove('hidden');
    });

    $('brandSelect').addEventListener('change', populateModelSelector);
    $('modelSelect').addEventListener('change', () => loadBookTree(Number($('modelSelect').value)));
    $('treeFilterInput').addEventListener('input', (e) => renderSectionTree(e.target.value));
    $('figureFilterInput').addEventListener('input', renderPartsTable);

    // Tree clicks
    $('sectionTree').addEventListener('click', (e) => {
      const secBtn = e.target.closest('[data-toggle-sec]');
      if (secBtn) {
        const body = document.querySelector(`[data-sec-body="${secBtn.dataset.toggleSec}"]`);
        if (body) body.classList.toggle('hidden');
        return;
      }
      const figBtn = e.target.closest('[data-fig-id]');
      if (figBtn) openFigure(Number(figBtn.dataset.figId));
    });

    // Welcome hero buttons
    $('btnHeroUpload').addEventListener('click', () => $('uploadModal').classList.remove('hidden'));
    $('btnOpenUpload').addEventListener('click', () => $('uploadModal').classList.remove('hidden'));
    $('btnHeroExplore').addEventListener('click', () => {
      const firstFig = state.currentTree?.sections?.[0]?.figures?.[0];
      if (firstFig) openFigure(firstFig.id);
      else showToast('Silakan upload katalog PDF terlebih dahulu.');
    });

    // Global Omnisearch
    $('globalSearchInput').addEventListener('input', () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(runGlobalSearch, 180);
    });
    $('searchBrandFilter').addEventListener('change', runGlobalSearch);
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        $('globalSearchInput').focus();
      }
      if (e.key === 'Escape') {
        $('searchDropdown').classList.add('hidden');
        document.querySelectorAll('.modal-backdrop').forEach((m) => m.classList.add('hidden'));
      }
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.topbar-search')) $('searchDropdown').classList.add('hidden');
    });
    $('searchDropdown').addEventListener('click', (e) => {
      const figItem = e.target.closest('[data-search-fig]');
      if (figItem) {
        $('searchDropdown').classList.add('hidden');
        openFigure(Number(figItem.dataset.searchFig));
        return;
      }
      const wuItem = e.target.closest('[data-search-wu]');
      if (wuItem) {
        $('searchDropdown').classList.add('hidden');
        openWhereUsedModal(wuItem.dataset.searchWu);
      }
    });

    // Parts Table interactions
    $('partsTableBody').addEventListener('click', async (e) => {
      const wuBtn = e.target.closest('[data-where-used]');
      if (wuBtn) return openWhereUsedModal(wuBtn.dataset.whereUsed);

      const kitBtn = e.target.closest('[data-kit]');
      if (kitBtn) return openKitModal(state.currentFigure.book_id, kitBtn.dataset.kit);

      const referBtn = e.target.closest('[data-refer-page]');
      if (referBtn) {
        try {
          const target = await api(
            `/api/books/${state.currentFigure.book_id}/page/${encodeURIComponent(referBtn.dataset.referPage)}`
          );
          openFigure(target.id);
        } catch (err) {
          showToast(err.message);
        }
        return;
      }

      const copyBtn = e.target.closest('[data-copy-pn]');
      if (copyBtn) {
        navigator.clipboard.writeText(copyBtn.dataset.copyPn);
        showToast(`Disalin: ${copyBtn.dataset.copyPn}`);
        return;
      }

      const cartBtn = e.target.closest('[data-add-cart]');
      if (cartBtn) {
        const part = state.currentParts.find((p) => String(p.id) === cartBtn.dataset.addCart);
        if (part) {
          addToCart({
            part_number: part.part_number,
            description: part.description,
            qty: parseInt(part.qty, 10) || 1,
            unit: `${state.currentFigure.brand_name} ${state.currentFigure.model_name}`,
            fig_no: state.currentFigure.fig_no
          });
        }
        return;
      }

      const editBtn = e.target.closest('[data-edit-part]');
      if (editBtn) {
        const part = state.currentParts.find((p) => String(p.id) === editBtn.dataset.editPart);
        if (part) openEditPartModal(part);
        return;
      }

      const delBtn = e.target.closest('[data-del-part]');
      if (delBtn && confirm('Hapus baris part ini?')) {
        await api(`/api/parts/${delBtn.dataset.delPart}`, { method: 'DELETE' });
        showToast('Baris dihapus.');
        openFigure(state.currentFigure.id);
      }
    });

    // Where-Used jump button
    $('wuBody').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-jump-fig]');
      if (btn) {
        $('whereUsedModal').classList.add('hidden');
        openFigure(Number(btn.dataset.jumpFig));
      }
    });

    // Diagram Zoom & Pan
    $('btnZoomIn').addEventListener('click', () => {
      state.zoom = Math.min(5, state.zoom + 0.25);
      applyDiagramTransform();
    });
    $('btnZoomOut').addEventListener('click', () => {
      state.zoom = Math.max(0.5, state.zoom - 0.25);
      applyDiagramTransform();
    });
    $('btnZoomReset').addEventListener('click', resetDiagramTransform);
    $('btnFullscreen').addEventListener('click', () => {
      const pane = $('diagramPane');
      if (!document.fullscreenElement) pane.requestFullscreen?.();
      else document.exitFullscreen?.();
    });

    const stage = $('diagramStage');
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.15 : -0.15;
      state.zoom = Math.max(0.5, Math.min(5, state.zoom + delta));
      applyDiagramTransform();
    });
    stage.addEventListener('mousedown', (e) => {
      state.isPanning = true;
      state.panStartX = e.clientX - state.panX;
      state.panStartY = e.clientY - state.panY;
    });
    window.addEventListener('mousemove', (e) => {
      if (!state.isPanning) return;
      state.panX = e.clientX - state.panStartX;
      state.panY = e.clientY - state.panStartY;
      applyDiagramTransform();
    });
    window.addEventListener('mouseup', () => (state.isPanning = false));

    // Admin edit mode
    $('btnToggleAdminEdit').addEventListener('click', () => {
      state.adminEditMode = !state.adminEditMode;
      $('btnToggleAdminEdit').classList.toggle('btn-primary', state.adminEditMode);
      $('btnAddPartRow').classList.toggle('hidden', !state.adminEditMode);
      renderPartsTable();
    });

    $('btnAddPartRow').addEventListener('click', () => openEditPartModal(null));

    $('editPartForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(e.target).entries());
      if (fd.id) {
        await api(`/api/parts/${fd.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(fd)
        });
        showToast('Baris diperbarui.');
      } else {
        await api(`/api/figures/${state.currentFigure.id}/parts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(fd)
        });
        showToast('Baris baru ditambahkan.');
      }
      $('editPartModal').classList.add('hidden');
      openFigure(state.currentFigure.id);
    });

    // Cart Drawer
    const toggleCart = (open) => {
      $('cartDrawer').classList.toggle('hidden', !open);
      $('cartDrawerBackdrop').classList.toggle('hidden', !open);
      if (open) renderCartDrawer();
    };
    $('btnOpenCart').addEventListener('click', () => toggleCart(true));
    $('btnCloseCart').addEventListener('click', () => toggleCart(false));
    $('cartDrawerBackdrop').addEventListener('click', () => toggleCart(false));
    $('btnCopyWhatsApp').addEventListener('click', copyCartAsWhatsApp);
    $('btnExportCsv').addEventListener('click', exportCartCsv);
    $('btnClearCart').addEventListener('click', () => {
      state.cart = [];
      saveCart();
    });
    $('cartItemsList').addEventListener('click', (e) => {
      const del = e.target.closest('[data-cart-del]');
      if (del) {
        state.cart.splice(Number(del.dataset.cartDel), 1);
        saveCart();
      }
    });
    $('cartItemsList').addEventListener('change', (e) => {
      const inp = e.target.closest('[data-cart-qty]');
      if (inp) {
        state.cart[Number(inp.dataset.cartQty)].qty = Math.max(1, parseInt(inp.value, 10) || 1);
        saveCart();
      }
    });

    // Upload Modal Tabs & Submissions
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        $('pdfUploadForm').classList.toggle('hidden', btn.dataset.tab !== 'tabPdf');
        $('csvUploadForm').classList.toggle('hidden', btn.dataset.tab !== 'tabCsv');
      });
    });

    $('pdfUploadForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const formData = new FormData(e.target);
      const wrap = $('uploadProgressWrap');
      const fill = $('uploadProgressFill');
      const text = $('uploadProgressText');
      wrap.classList.remove('hidden');
      fill.style.width = '5%';
      text.textContent = 'Mengunggah file PDF ke server...';

      try {
        const res = await api('/api/upload/pdf', { method: 'POST', body: formData });
        const poll = setInterval(async () => {
          const st = await api(`/api/books/${res.book_id}/status`);
          fill.style.width = `${st.parse_progress || 10}%`;
          text.textContent = st.parse_message || 'Memproses...';
          if (st.parse_status === 'completed') {
            clearInterval(poll);
            showToast('PDF Part Book berhasil diekstrak!');
            $('uploadModal').classList.add('hidden');
            wrap.classList.add('hidden');
            e.target.reset();
            await loadInitialData();
            $('modelSelect').value = String(res.book_id);
            await loadBookTree(res.book_id);
          } else if (st.parse_status === 'failed') {
            clearInterval(poll);
            showToast(st.parse_message || 'Gagal mengekstrak PDF.');
          }
        }, 1000);
      } catch (err) {
        text.textContent = err.message;
        showToast(err.message);
      }
    });

    $('csvUploadForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const res = await api('/api/upload/csv', { method: 'POST', body: new FormData(e.target) });
        showToast(`CSV berhasil diimpor (${res.figuresCount} figure, ${res.partsCount} part)!`);
        $('uploadModal').classList.add('hidden');
        e.target.reset();
        await loadInitialData();
        $('modelSelect').value = String(res.book_id);
        await loadBookTree(res.book_id);
      } catch (err) {
        showToast(err.message);
      }
    });

    // Close modal buttons
    document.querySelectorAll('.modal-close').forEach((btn) => {
      btn.addEventListener('click', () => $(btn.dataset.close).classList.add('hidden'));
    });
  }

  function openEditPartModal(part) {
    const form = $('editPartForm');
    form.reset();
    $('editPartModalTitle').textContent = part ? 'Edit Baris Part' : 'Tambah Baris Part Baru';
    const fields = [
      'id',
      'index_no',
      'code',
      'part_number',
      'description',
      'indent_level',
      'qty',
      'serial_number_range',
      'kit_ref',
      'refer_to_page',
      'bin_location',
      'notes'
    ];
    for (const f of fields) {
      if (form.elements[f]) form.elements[f].value = part ? part[f] ?? '' : f === 'indent_level' ? 0 : '';
    }
    $('editPartModal').classList.remove('hidden');
  }

  bindEvents();
  loadInitialData().catch((err) => showToast(`Gagal memuat katalog: ${err.message}`));
})();
