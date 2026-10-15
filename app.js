/**
 * app.js - Glavna logika skladiščne PWA aplikacije
 */

// Globalno stanje
let currentFilter = 'all';
let cameraStream = null;
let barcodeDetector = null;
let scanInterval = null;

// Inicializacija ob nalaganju strani
document.addEventListener('DOMContentLoaded', async () => {
  // 1. Registracija Service Workerja za offline podporo
  registerServiceWorker();

  // 2. Spremljanje online/offline stanja
  setupNetworkListeners();

  // 3. Priprava navigacije med zavihki
  setupTabNavigation();

  // 4. Dogodki za iskalnik in filtre
  setupSearchAndFilters();

  // 5. Dogodki za modalna okna
  setupModals();

  // 6. Dogodki za uvoz/izvoz in nastavitve
  setupSettingsAndBackup();

  // 7. Priprava optičnega čitalnika škatel (OCR)
  setupBoxOCRScanner();

  // 8. Takojšnje prednalaganje nevronskega OCR pospeševalnika v ozadju
  initOCRWorker();

  // 9. Naloži podatke iz IndexedDB
  await refreshInventory();
});

/* =========================================================================
   1. SERVICE WORKER & ONLINE STATUS
   ========================================================================= */
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
      .then((reg) => {
        console.log('Service Worker uspešno registriran:', reg.scope);
      })
      .catch((err) => {
        console.warn('Registracija Service Workerja ni uspela:', err);
      });
  }
}

function setupNetworkListeners() {
  const statusEl = document.getElementById('connectionStatus');
  const textEl = document.getElementById('connectionText');

  function updateStatus() {
    if (navigator.onLine) {
      statusEl.className = 'offline-pill online';
      textEl.textContent = 'Povezano';
    } else {
      statusEl.className = 'offline-pill offline';
      textEl.textContent = 'Brez povezave (Offline)';
      showToast('Delate v načinu brez povezave. Vsi podatki se shranjujejo lokalno.');
    }
  }

  window.addEventListener('online', updateStatus);
  window.addEventListener('offline', updateStatus);
  updateStatus();
}

/* =========================================================================
   2. NAVIGACIJA MED ZAVIHKI
   ========================================================================= */
function setupTabNavigation() {
  const tabs = document.querySelectorAll('.nav-tab');
  const contents = document.querySelectorAll('.tab-content');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const targetId = tab.dataset.tab;

      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      contents.forEach(c => {
        c.style.display = 'none';
        c.classList.remove('active');
      });

      const targetEl = document.getElementById(targetId);
      if (targetEl) {
        targetEl.style.display = (targetId === 'tab-scanner') ? 'flex' : 'block';
        targetEl.classList.add('active');
      }

      // Če zapustimo čitalnik, ugasnemo kamero za varčevanje z baterijo
      if (targetId !== 'tab-scanner') {
        stopCamera();
      } else {
        startCamera();
      }

      // Osveži podatke za ustrezen zavihek
      if (targetId === 'tab-inventory') {
        refreshInventory();
      } else if (targetId === 'tab-history') {
        refreshLogs();
      }
    });
  });
}

/* =========================================================================
   3. ISKALNIK, FILTRI & PRIKAZ ZALOGE
   ========================================================================= */
function setupSearchAndFilters() {
  const searchInput = document.getElementById('searchInput');
  searchInput.addEventListener('input', () => {
    renderItemsList();
  });

  const chips = document.getElementById('categoryChips');
  chips.addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;

    chips.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.filter;
    renderItemsList();
  });
}

let cachedItems = [];

async function refreshInventory() {
  try {
    cachedItems = await DB.getAllItems();
    updateStatsBar();
    updateCategoryChips();
    renderItemsList();
  } catch (err) {
    console.error('Napaka pri branju zaloge:', err);
    showToast('Napaka pri branju podatkov.');
  }
}

function updateStatsBar() {
  const totalItems = cachedItems.length;
  const totalQty = cachedItems.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
  const lowCount = cachedItems.filter(item => (Number(item.quantity) || 0) <= (Number(item.minQuantity) || 0)).length;

  document.getElementById('statTotalItems').textContent = totalItems;
  document.getElementById('statTotalQty').textContent = Math.round(totalQty);
  document.getElementById('statLowStock').textContent = lowCount;
}

function updateCategoryChips() {
  const chipsContainer = document.getElementById('categoryChips');
  const categories = [...new Set(cachedItems.map(i => i.category).filter(Boolean))];

  // Ohrani prva dva ("Vse" in "Nizka zaloga")
  let html = `
    <button class="chip ${currentFilter === 'all' ? 'active' : ''}" data-filter="all">Vse</button>
    <button class="chip ${currentFilter === 'low' ? 'active' : ''}" data-filter="low">⚠️ Nizka zaloga</button>
  `;

  categories.forEach(cat => {
    html += `<button class="chip ${currentFilter === cat ? 'active' : ''}" data-filter="${escapeHtml(cat)}">${escapeHtml(cat)}</button>`;
  });

  chipsContainer.innerHTML = html;
}

function renderItemsList() {
  const listEl = document.getElementById('itemsList');
  const search = (document.getElementById('searchInput').value || '').trim().toLowerCase();

  let filtered = cachedItems.filter(item => {
    // Iskalni filter
    const matchesSearch = !search ||
      (item.name && item.name.toLowerCase().includes(search)) ||
      (item.sku && item.sku.toLowerCase().includes(search)) ||
      (item.location && item.location.toLowerCase().includes(search));

    if (!matchesSearch) return false;

    // Filter po znački/kategoriji
    if (currentFilter === 'all') return true;
    if (currentFilter === 'low') {
      return (Number(item.quantity) || 0) <= (Number(item.minQuantity) || 0);
    }
    return item.category === currentFilter;
  });

  if (filtered.length === 0) {
    listEl.innerHTML = `
      <div class="empty-box">
        <div class="empty-icon">🔍</div>
        <p>Ni najdenih artiklov.</p>
        ${cachedItems.length === 0 ? '<button class="btn-secondary" onclick="loadDemoData()" style="max-width:220px;">Naloži testne artikle</button>' : ''}
      </div>
    `;
    return;
  }

  // Optimizacija za 10.000+ artiklov: ne izrišemo vseh naenkrat v DOM, ampak prvih 60 zadetkov
  const displayLimit = 60;
  const displayed = filtered.slice(0, displayLimit);

  let html = displayed.map(item => {
    const qty = Number(item.quantity) || 0;
    const minQty = Number(item.minQuantity) || 0;
    
    let statusClass = 'status-ok';
    let statusText = 'Na zalogi';
    if (qty <= 0) {
      statusClass = 'status-empty';
      statusText = 'Ni na zalogi';
    } else if (qty <= minQty) {
      statusClass = 'status-low';
      statusText = 'Nizka zaloga';
    }

    return `
      <div class="item-card" data-id="${item.id}">
        <div class="item-top" onclick="openEditModal(${item.id})">
          <div class="item-title-wrap">
            <div class="item-name">${escapeHtml(item.name)}</div>
            <div style="display:flex; flex-wrap:wrap; gap:6px; align-items:center;">
              <span class="item-sku-badge"># ${escapeHtml(item.sku)}</span>
              ${item.location ? `<span class="item-location">📍 ${escapeHtml(item.location)}</span>` : ''}
            </div>
          </div>
          <span class="stock-status-badge ${statusClass}">${statusText}</span>
        </div>

        <div class="item-bottom">
          <div class="item-qty-display" onclick="openEditModal(${item.id})">
            <span class="qty-number">${qty}</span>
            <span class="qty-unit">${escapeHtml(item.unit || 'kos')}</span>
          </div>
          <div class="quick-actions">
            <button class="btn-qty" onclick="openStockChangeModal(${item.id}, 'out')" title="Izdaj blago">-</button>
            <button class="btn-qty" onclick="openStockChangeModal(${item.id}, 'in')" title="Prevzemi blago">+</button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  if (filtered.length > displayLimit) {
    html += `
      <div style="text-align: center; padding: 12px; font-size: 0.85rem; color: var(--text-muted);">
        Prikazanih prvih ${displayLimit} od skupaj <strong>${filtered.length}</strong> ujemajočih se artiklov. Uporabite iskalnik zgoraj za ožji izbor.
      </div>
    `;
  }

  listEl.innerHTML = html;
}

/* =========================================================================
   4. MODALNA OKNA: DODAJ / UREDI & PREMIK
   ========================================================================= */
function setupModals() {
  // Modal za artikel
  const modalItem = document.getElementById('modalItem');
  const btnOpenAddModal = document.getElementById('btnOpenAddModal');
  const btnCloseItemModal = document.getElementById('btnCloseItemModal');
  const formItem = document.getElementById('formItem');
  const btnGenSku = document.getElementById('btnGenSku');
  const btnDeleteItem = document.getElementById('btnDeleteItem');

  btnOpenAddModal.addEventListener('click', () => {
    formItem.reset();
    document.getElementById('itemId').value = '';
    document.getElementById('modalItemTitle').textContent = 'Nov artikel';
    btnDeleteItem.style.display = 'none';
    modalItem.style.display = 'flex';
  });

  btnCloseItemModal.addEventListener('click', () => {
    modalItem.style.display = 'none';
  });

  btnGenSku.addEventListener('click', () => {
    // Generiraj kodo npr. ART-9482
    const rnd = Math.floor(1000 + Math.random() * 9000);
    document.getElementById('itemSku').value = 'ART-' + rnd;
  });

  formItem.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('itemId').value;
    const itemData = {
      sku: document.getElementById('itemSku').value,
      name: document.getElementById('itemName').value,
      boxInfo: document.getElementById('itemBoxInfo').value || 'Box 1/1',
      piecesPerBox: Number(document.getElementById('itemPiecesPerBox').value) || 1,
      category: document.getElementById('itemCategory').value,
      location: document.getElementById('itemLocation').value,
      quantity: Number(document.getElementById('itemQuantity').value),
      minQuantity: Number(document.getElementById('itemMinQuantity').value) || 0,
      unit: document.getElementById('itemUnit').value,
      notes: document.getElementById('itemNotes').value
    };

    try {
      if (id) {
        itemData.id = Number(id);
        await DB.updateItem(itemData);
        showToast('Artikel uspešno posodobljen.');
      } else {
        await DB.addItem(itemData);
        showToast('Nov artikel dodan v zalogo.');
      }
      modalItem.style.display = 'none';
      await refreshInventory();
    } catch (err) {
      console.error(err);
      showToast('Napaka pri shranjevanju artikla.');
    }
  });

  btnDeleteItem.addEventListener('click', async () => {
    const id = document.getElementById('itemId').value;
    if (!id) return;
    if (confirm('Ali ste prepričani, da želite izbrisati ta artikel?')) {
      await DB.deleteItem(id);
      modalItem.style.display = 'none';
      showToast('Artikel izbrisan.');
      await refreshInventory();
    }
  });

  // Modal za hitri prevzem / izdajo
  const modalStockChange = document.getElementById('modalStockChange');
  const btnCloseStockChange = document.getElementById('btnCloseStockChange');
  const formStockChange = document.getElementById('formStockChange');

  btnCloseStockChange.addEventListener('click', () => {
    modalStockChange.style.display = 'none';
  });

  formStockChange.addEventListener('submit', async (e) => {
    e.preventDefault();
    const itemId = document.getElementById('changeItemId').value;
    const direction = document.getElementById('changeDirection').value;
    const amount = Number(document.getElementById('changeAmount').value);
    const note = document.getElementById('changeNote').value;

    const delta = (direction === 'in') ? amount : -amount;

    try {
      await DB.adjustStock(itemId, delta, note, direction);
      if (navigator.vibrate) navigator.vibrate(60);
      modalStockChange.style.display = 'none';
      showToast(direction === 'in' ? `Prevzem +${amount} uspešno zabeležen` : `Izdaja -${amount} uspešno zabeležena`);
      await refreshInventory();
    } catch (err) {
      console.error(err);
      showToast('Napaka pri posodobitvi zaloge.');
    }
  });

  // Zapri modal ob kliku zunaj
  window.addEventListener('click', (e) => {
    if (e.target === modalItem) modalItem.style.display = 'none';
    if (e.target === modalStockChange) modalStockChange.style.display = 'none';
  });
}

window.openEditModal = async function(id) {
  const item = await DB.getItemById(id);
  if (!item) return;

  document.getElementById('itemId').value = item.id;
  document.getElementById('itemSku').value = item.sku || '';
  document.getElementById('itemName').value = item.name || '';
  document.getElementById('itemBoxInfo').value = item.boxInfo || 'Box 1/1';
  document.getElementById('itemPiecesPerBox').value = item.piecesPerBox || 1;
  document.getElementById('itemCategory').value = item.category || '';
  document.getElementById('itemLocation').value = item.location || '';
  document.getElementById('itemQuantity').value = item.quantity || 0;
  document.getElementById('itemMinQuantity').value = item.minQuantity || 0;
  document.getElementById('itemUnit').value = item.unit || 'kos';
  document.getElementById('itemNotes').value = item.notes || '';

  document.getElementById('modalItemTitle').textContent = 'Uredi artikel';
  document.getElementById('btnDeleteItem').style.display = 'block';
  document.getElementById('modalItem').style.display = 'flex';
};

window.openStockChangeModal = async function(id, direction) {
  const item = await DB.getItemById(id);
  if (!item) return;

  document.getElementById('changeItemId').value = item.id;
  document.getElementById('changeDirection').value = direction;
  document.getElementById('changeItemName').textContent = item.name;
  document.getElementById('changeItemCurrent').textContent = `Trenutno: ${item.quantity} ${item.unit || 'kos'} (${item.location || 'Brez lokacije'})`;
  document.getElementById('changeAmount').value = '1';
  document.getElementById('changeNote').value = '';

  const title = document.getElementById('stockChangeTitle');
  const label = document.getElementById('changeAmountLabel');
  const btn = document.getElementById('btnConfirmStockChange');

  if (direction === 'in') {
    title.textContent = '📥 Prevzem v skladišče';
    label.textContent = 'Količina prevzema (+)';
    btn.textContent = 'Potrdi prevzem';
  } else {
    title.textContent = '📤 Izdaja iz skladišča';
    label.textContent = 'Količina izdaje (-)';
    btn.textContent = 'Potrdi izdajo';
  }

  document.getElementById('modalStockChange').style.display = 'flex';
};

/* =========================================================================
   5. OPTIČNI ČITALNIK ŠKATEL (OCR & TPU POSPEŠEVANJE)
   ========================================================================= */
let ocrWorker = null;
let ocrWorkerPromise = null;
let currentScannedBox = null;
let currentMultiplier = 1;

/**
 * Predhodno ogrevanje OCR nevronske mreže v ozadju (TPU / WebAssembly SIMD)
 */
async function initOCRWorker() {
  if (ocrWorkerPromise) return ocrWorkerPromise;

  ocrWorkerPromise = (async () => {
    try {
      if (typeof Tesseract === 'undefined') {
        console.warn('Tesseract knjižnica še ni na voljo.');
        return null;
      }

      console.log('⚡ Zaganjam nevronski OCR pospeševalnik (LSTM/SIMD)...');
      const worker = await Tesseract.createWorker('eng', 1, {
        logger: (m) => {
          if (m.status === 'recognizing text') {
            const pct = Math.round((m.progress || 0) * 100);
            const textEl = document.getElementById('ocrLoadingText');
            if (textEl) textEl.textContent = `⚡ TPU analiza besedila: ${pct}%`;
          }
        }
      });

      // PSM 6: Predpostavka enovitega bloka besedila (3-5x hitreje od privzetega OSD!)
      await worker.setParameters({
        tessedit_pageseg_mode: '6'
      });

      ocrWorker = worker;
      console.log('✓ OCR nevronski model je pripravljen za takojšnje branje škatel.');
      return worker;
    } catch (err) {
      console.warn('Inicijalizacija OCR nevronskega modela:', err);
      return null;
    }
  })();

  return ocrWorkerPromise;
}

function setupBoxOCRScanner() {
  const btnCapture = document.getElementById('btnCaptureOCR');
  const btnToggle = document.getElementById('btnToggleCamera');
  const btnPhoto = document.getElementById('btnTriggerCameraPhoto');
  const fileInput = document.getElementById('ocrFileInput');
  const btnManual = document.getElementById('btnManualScan');
  const manualInput = document.getElementById('manualScanInput');

  // Gumb za takojšen zajem in OCR iz kamere
  btnCapture.addEventListener('click', async () => {
    const video = document.getElementById('cameraVideo');
    if (!cameraStream || video.readyState < video.HAVE_CURRENT_DATA) {
      showToast('Kamera se še zaganja...');
      await startCamera();
      return;
    }

    const croppedCanvas = getCroppedCanvasFromVideo(video);
    await processImageWithOCR(croppedCanvas);
  });

  // Vklop / Izklop kamere
  btnToggle.addEventListener('click', () => {
    if (cameraStream) {
      stopCamera();
    } else {
      startCamera();
    }
  });

  // Fotografija / Izbira slike
  btnPhoto.addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const img = new Image();
    img.onload = async () => {
      // Pripravi obdelan canvas za visoko ločljivostno sliko
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      // Omeji velikost na optimalno za OCR (cca 1200px širine)
      const scale = Math.min(1, 1400 / img.width);
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      preprocessCanvasForOCR(canvas, ctx);

      await processImageWithOCR(canvas);
    };
    img.src = URL.createObjectURL(file);
    fileInput.value = '';
  });

  // Ročno iskanje po 7 števkah
  btnManual.addEventListener('click', () => {
    const code = manualInput.value.trim();
    if (code) {
      handleManual7DigitLookup(code);
    }
  });

  manualInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnManual.click();
  });
}

async function startCamera() {
  const video = document.getElementById('cameraVideo');

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      }
    });

    cameraStream = stream;
    video.srcObject = stream;
  } catch (err) {
    console.warn('Kamere ni bilo mogoče zagnati:', err);
    showToast('Dostop do kamere ni na voljo. Uporabite gumb za fotografijo spodaj.');
  }
}

function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
    const video = document.getElementById('cameraVideo');
    if (video) video.srcObject = null;
  }
}

/**
 * Izreže zgolj območje vizirja za škatlo (cca 70% širine, 45% višine)
 * To zmanjša število slikovnih pik za 80% in omogoči bliskovit OCR!
 */
function getCroppedCanvasFromVideo(video) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  const vw = video.videoWidth || 1280;
  const vh = video.videoHeight || 720;

  const cropW = Math.round(vw * 0.70);
  const cropH = Math.round(vh * 0.45);
  const cropX = Math.round((vw - cropW) / 2);
  const cropY = Math.round((vh - cropH) / 2);

  canvas.width = cropW;
  canvas.height = cropH;
  ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

  // Povečaj kontrast za odstranitev odbojev prozorne folije in rjavega kartona
  preprocessCanvasForOCR(canvas, ctx);

  return canvas;
}

/**
 * Hitro predprocesiranje kontrasta z zvišanim pragom
 */
function preprocessCanvasForOCR(canvas, ctx) {
  try {
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
      // Sivina
      const gray = (d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114);
      // Povečaj kontrast in binariziraj za ostre črne črke na beli/rjavi podlagi
      const val = gray > 135 ? 255 : (gray < 90 ? 0 : (gray - 90) * (255 / 45));
      d[i] = val;
      d[i+1] = val;
      d[i+2] = val;
    }
    ctx.putImageData(imgData, 0, 0);
  } catch (e) {
    // Canvas security or memory fallback
  }
}

/**
 * Glavna funkcija za zagon OCR in razčlenitev podatkov o škatli
 */
async function processImageWithOCR(canvas) {
  const overlay = document.getElementById('ocrLoadingOverlay');
  const loadingText = document.getElementById('ocrLoadingText');
  overlay.style.display = 'flex';
  loadingText.textContent = '⚡ TPU obdelava slike škatle...';

  try {
    // Zagotovi pripravljen nevronski pospeševalnik
    let worker = ocrWorker;
    if (!worker) {
      loadingText.textContent = '⚡ Pripravljam nevronski model...';
      worker = await initOCRWorker();
    }

    if (!worker) {
      throw new Error('OCR model ni na voljo.');
    }

    const t0 = performance.now();
    const ret = await worker.recognize(canvas);
    const t1 = performance.now();
    console.log(`OCR zaključen v ${Math.round(t1 - t0)}ms. Besedilo:`, ret.data.text);

    // Razčleni etiketo s pomočjo WarehouseLabelParser
    const parsed = WarehouseLabelParser.parse(ret.data.text);
    await handleBoxScanResult(parsed);

  } catch (err) {
    console.error('Napaka pri OCR prepoznavi:', err);
    showToast('Napaka pri branju škatle. Poskusite ponovno.');
  } finally {
    overlay.style.display = 'none';
  }
}

/**
 * Prikaz in obdelava rezultatov prepoznane škatle
 */
async function handleBoxScanResult(parsed) {
  if (navigator.vibrate) navigator.vibrate([70, 40, 70]);

  currentScannedBox = parsed;
  currentMultiplier = 1;

  const resultCard = document.getElementById('scanResultCard');
  resultCard.style.display = 'flex';

  const sku = parsed.articleNumber;
  let existingItem = null;
  if (sku) {
    existingItem = await DB.getItemBySKU(sku);
  }

  renderBoxResultCard(existingItem);
}

function renderBoxResultCard(existingItem) {
  const resultCard = document.getElementById('scanResultCard');
  const parsed = currentScannedBox;
  if (!parsed) return;

  const sku = parsed.articleNumber || 'Ni zaznana';
  const name = (existingItem && existingItem.name) ? existingItem.name : (parsed.name || 'Neznan artikel');
  const boxInfo = `Box ${parsed.boxCurrent}/${parsed.boxTotal}`;
  const piecesPerBox = Number(parsed.quantityInBox) || 1;
  const totalPcs = piecesPerBox * currentMultiplier;

  let stockInfoHtml = '';
  if (existingItem) {
    stockInfoHtml = `
      <div style="background: rgba(16, 185, 129, 0.12); border: 1px solid rgba(16, 185, 129, 0.3); border-radius: var(--radius-sm); padding: 8px 12px; font-size: 0.85rem; color: var(--success); display:flex; justify-content:space-between; align-items:center;">
        <span>Trenutna zaloga v skladišču:</span>
        <strong style="font-size: 1.05rem;">${existingItem.quantity} ${existingItem.unit || 'kos'}</strong>
      </div>
      <div style="font-size: 0.78rem; color: var(--text-dim);">Lokacija: <strong>${existingItem.location || 'Brez lokacije'}</strong></div>
    `;
  } else {
    stockInfoHtml = `
      <div style="background: rgba(245, 158, 11, 0.12); border: 1px solid rgba(245, 158, 11, 0.3); border-radius: var(--radius-sm); padding: 8px 12px; font-size: 0.85rem; color: var(--warning);">
        ⚠️ Artikel s šifro <strong>${escapeHtml(sku)}</strong> še ni vpisan v zalogo.
      </div>
    `;
  }

  resultCard.innerHTML = `
    <div class="box-result-header">
      <div style="font-size: 0.8rem; color: var(--text-muted); font-weight: 600;">ŠIFRA ARTIKLA:</div>
      <div class="box-sku-highlight">${escapeHtml(sku)}</div>
    </div>

    <div style="font-size: 1.15rem; font-weight: 700; color: #fff;">${escapeHtml(name)}</div>

    <div class="box-badges">
      <span class="box-badge highlight">📦 ${escapeHtml(boxInfo)}</span>
      <span class="box-badge highlight">🔢 ${piecesPerBox} kos v škatli</span>
    </div>

    ${stockInfoHtml}

    <!-- Izbira števila škatel (množilnik) -->
    <div class="box-multiplier-row">
      <span style="font-size: 0.8rem; color: var(--text-muted); font-weight: 600;">Škatel:</span>
      <button type="button" class="mult-btn ${currentMultiplier === 1 ? 'active' : ''}" onclick="setBoxMultiplier(1)">1x</button>
      <button type="button" class="mult-btn ${currentMultiplier === 2 ? 'active' : ''}" onclick="setBoxMultiplier(2)">2x</button>
      <button type="button" class="mult-btn ${currentMultiplier === 5 ? 'active' : ''}" onclick="setBoxMultiplier(5)">5x</button>
      <button type="button" class="mult-btn ${currentMultiplier === 10 ? 'active' : ''}" onclick="setBoxMultiplier(10)">10x</button>
    </div>

    <!-- Hitra skladiščna dejanja za prevzem in izdajo -->
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 4px;">
      <button class="btn-primary" onclick="executeBoxStockChange('in')" style="margin-top:0; padding: 12px;">
        📥 PREVZEMI (+${totalPcs} kos)
      </button>
      <button class="btn-secondary" onclick="executeBoxStockChange('out')" style="margin-top:0; padding: 12px;">
        📤 IZDAJ (-${totalPcs} kos)
      </button>
    </div>

    ${!existingItem && sku ? `
      <button class="btn-secondary" onclick="openAddFromScannedBox()" style="margin-top: 4px; border-color: var(--primary); color: var(--primary);">
        ➕ Dodaj ta artikel v skladišče
      </button>
    ` : ''}
  `;
}

window.setBoxMultiplier = function(m) {
  currentMultiplier = Number(m) || 1;
  const sku = currentScannedBox?.articleNumber;
  if (sku) {
    DB.getItemBySKU(sku).then(item => renderBoxResultCard(item));
  } else {
    renderBoxResultCard(null);
  }
};

window.executeBoxStockChange = async function(direction) {
  if (!currentScannedBox) return;

  const sku = currentScannedBox.articleNumber;
  const piecesPerBox = Number(currentScannedBox.quantityInBox) || 1;
  const totalAmount = piecesPerBox * currentMultiplier;

  let item = await DB.getItemBySKU(sku);

  // Če artikel še ne obstaja, ga avtomatsko ustvari
  if (!item) {
    const newId = await DB.addItem({
      sku: sku || 'ART-' + Math.floor(1000 + Math.random() * 9000),
      name: currentScannedBox.name || `Artikel ${sku}`,
      quantity: 0,
      minQuantity: 4,
      boxInfo: `Box ${currentScannedBox.boxCurrent}/${currentScannedBox.boxTotal}`,
      piecesPerBox: piecesPerBox,
      unit: 'kos',
      category: 'Splošno',
      location: 'Prevzemno območje'
    });
    item = await DB.getItemById(newId);
  }

  const note = `${currentMultiplier}x škatla (${currentScannedBox.boxCurrent}/${currentScannedBox.boxTotal}), ${piecesPerBox} kos/škatlo`;
  const delta = (direction === 'in') ? totalAmount : -totalAmount;

  await DB.adjustStock(item.id, delta, note, direction);
  if (navigator.vibrate) navigator.vibrate([100, 50, 100]);

  showToast(direction === 'in' ? `📥 Prevzeto: +${totalAmount} kos` : `📤 Izdano: -${totalAmount} kos`);

  // Osveži prikaz
  const updatedItem = await DB.getItemById(item.id);
  renderBoxResultCard(updatedItem);
  await refreshInventory();
};

window.openAddFromScannedBox = function() {
  if (!currentScannedBox) return;

  const modalItem = document.getElementById('modalItem');
  const formItem = document.getElementById('formItem');
  formItem.reset();
  document.getElementById('itemId').value = '';
  document.getElementById('itemSku').value = currentScannedBox.articleNumber || '';
  document.getElementById('itemName').value = currentScannedBox.name || '';
  document.getElementById('itemBoxInfo').value = `Box ${currentScannedBox.boxCurrent}/${currentScannedBox.boxTotal}`;
  document.getElementById('itemPiecesPerBox').value = currentScannedBox.quantityInBox || 1;
  document.getElementById('itemQuantity').value = currentScannedBox.quantityInBox || 1;
  document.getElementById('modalItemTitle').textContent = 'Nov artikel iz škatle';
  document.getElementById('btnDeleteItem').style.display = 'none';
  modalItem.style.display = 'flex';
};

async function handleManual7DigitLookup(code) {
  const item = await DB.getItemBySKU(code);
  const parsed = {
    articleNumber: code,
    name: item ? item.name : `Artikel ${code}`,
    boxCurrent: 1,
    boxTotal: 1,
    quantityInBox: item ? (item.piecesPerBox || 1) : 1,
    rawText: code
  };
  await handleBoxScanResult(parsed);
}

/* =========================================================================
   6. DNEVNIK PREMIKOV (ZGODOVINA)
   ========================================================================= */
async function refreshLogs() {
  const listEl = document.getElementById('logsList');
  const logs = await DB.getAllLogs();

  if (logs.length === 0) {
    listEl.innerHTML = `
      <div class="empty-box">
        <p>Ni zabeleženih premikov zaloge.</p>
      </div>
    `;
    return;
  }

  listEl.innerHTML = logs.map(log => {
    let typeClass = 'log-adjust';
    let typeLabel = 'Popravek';
    let sign = (log.changeAmount > 0) ? '+' : '';

    if (log.changeType === 'in') {
      typeClass = 'log-in';
      typeLabel = 'Prevzem';
    } else if (log.changeType === 'out') {
      typeClass = 'log-out';
      typeLabel = 'Izdaja';
    } else if (log.changeType === 'create') {
      typeClass = 'log-in';
      typeLabel = 'Nov vnos';
    }

    const d = new Date(log.timestamp);
    const dateFormatted = d.toLocaleDateString('sl-SI') + ' ' + d.toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' });

    return `
      <div class="log-item">
        <div>
          <div style="display:flex; align-items:center; gap:6px; margin-bottom: 4px;">
            <span class="log-type-tag ${typeClass}">${typeLabel}</span>
            <span style="font-weight:600; font-size: 0.95rem;">${escapeHtml(log.itemName)}</span>
          </div>
          <div style="font-size: 0.78rem; color: var(--text-dim);">
            ${dateFormatted} &bull; ${escapeHtml(log.note || 'Brez opombe')}
          </div>
        </div>
        <div style="text-align: right;">
          <div style="font-weight: 800; font-size: 1.1rem; color: ${log.changeAmount >= 0 ? 'var(--success)' : 'var(--danger)'}">
            ${sign}${log.changeAmount}
          </div>
          <div style="font-size: 0.72rem; color: var(--text-muted);">Skupaj: ${log.resultingQty}</div>
        </div>
      </div>
    `;
  }).join('');
}

/* =========================================================================
   7. NASTAVITVE, IZVOZ & UVOZ PODATKOV
   ========================================================================= */
function setupSettingsAndBackup() {
  document.getElementById('btnClearLogs').addEventListener('click', async () => {
    if (confirm('Ali res želite počistiti zgodovino premikov?')) {
      await DB.clearLogs();
      await refreshLogs();
      showToast('Zgodovina očiščena.');
    }
  });

  // Izvoz v CSV
  document.getElementById('btnExportCSV').addEventListener('click', async () => {
    const items = await DB.getAllItems();
    if (items.length === 0) {
      showToast('Zaloga je prazna.');
      return;
    }

    let csv = '\uFEFF'; // UTF-8 BOM za pravilen prikaz č, š, ž v Excelu
    csv += 'Koda;Naziv;Kategorija;Lokacija;Kolicina;MinimalnaZaloga;Enota;Opombe;ZadnjaPosodobitev\n';

    items.forEach(i => {
      const line = [
        sanitizeCSV(i.sku),
        sanitizeCSV(i.name),
        sanitizeCSV(i.category),
        sanitizeCSV(i.location),
        i.quantity,
        i.minQuantity,
        sanitizeCSV(i.unit),
        sanitizeCSV(i.notes),
        i.lastUpdated
      ].join(';');
      csv += line + '\n';
    });

    downloadFile(csv, `skladisce-zaloga-${getDateStamp()}.csv`, 'text/csv;charset=utf-8;');
    showToast('CSV datoteka pripravljena za prenos.');
  });

  // Izvoz v JSON
  document.getElementById('btnExportJSON').addEventListener('click', async () => {
    const items = await DB.getAllItems();
    const logs = await DB.getAllLogs();
    const backup = {
      version: 1,
      createdAt: new Date().toISOString(),
      items,
      logs
    };

    downloadFile(JSON.stringify(backup, null, 2), `skladisce-backup-${getDateStamp()}.json`, 'application/json');
    showToast('Varnostna kopija shranjena.');
  });

  // Uvoz JSON
  const importInput = document.getElementById('importFileInput');
  document.getElementById('btnTriggerImport').addEventListener('click', () => {
    importInput.click();
  });

  importInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    try {
      const text = await file.text();
      const data = JSON.parse(text);

      if (data && Array.isArray(data.items)) {
        if (confirm(`Uvozil boš ${data.items.length} artiklov. Želiš nadaljevati?`)) {
          for (const item of data.items) {
            delete item.id;
            await DB.addItem(item);
          }
          showToast(`Uspešno uvoženih ${data.items.length} artiklov.`);
          await refreshInventory();
        }
      } else {
        alert('Neveljavna datoteka varnostne kopije.');
      }
    } catch (err) {
      alert('Napaka pri branju datoteke: ' + err.message);
    }
    importInput.value = '';
  });

  // Naloži Demo
  document.getElementById('btnLoadDemo').addEventListener('click', () => {
    loadDemoData();
  });
}

window.loadDemoData = async function() {
  await DB.seedDemoData();
  showToast('Testni skladiščni artikli uspešno naloženi!');
  await refreshInventory();
};

/* =========================================================================
   POMOŽNE FUNKCIJE
   ========================================================================= */
function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
  }, 2800);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function sanitizeCSV(str) {
  if (!str) return '""';
  const clean = String(str).replace(/"/g, '""');
  return `"${clean}"`;
}

function getDateStamp() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function downloadFile(content, fileName, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
