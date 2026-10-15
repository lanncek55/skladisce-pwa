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

  // 7. Priprava čitalnika črtnih kod
  setupBarcodeScanner();

  // 8. Naloži podatke iz IndexedDB
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
   5. ČITALNIK ČRTNIH KOD (KAMERA & BARCODE DETECTION)
   ========================================================================= */
function setupBarcodeScanner() {
  const btnToggle = document.getElementById('btnToggleCamera');
  const btnManual = document.getElementById('btnManualScan');
  const manualInput = document.getElementById('manualScanInput');

  btnToggle.addEventListener('click', () => {
    if (cameraStream) {
      stopCamera();
    } else {
      startCamera();
    }
  });

  btnManual.addEventListener('click', () => {
    const code = manualInput.value.trim();
    if (code) {
      handleDetectedCode(code);
    }
  });

  manualInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      btnManual.click();
    }
  });
}

async function startCamera() {
  const video = document.getElementById('cameraVideo');
  const statusEl = document.getElementById('scannerStatus');

  try {
    if ('BarcodeDetector' in window) {
      barcodeDetector = new BarcodeDetector({
        formats: ['qr_code', 'ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e']
      });
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } }
    });

    cameraStream = stream;
    video.srcObject = stream;
    statusEl.textContent = 'Usmerite kamero v črtno kodo ali QR kodo...';

    // Zaženi zanko za prepoznavo kode
    scanInterval = setInterval(async () => {
      if (barcodeDetector && video.readyState === video.HAVE_ENOUGH_DATA) {
        try {
          const barcodes = await barcodeDetector.detect(video);
          if (barcodes.length > 0) {
            const rawValue = barcodes[0].rawValue;
            handleDetectedCode(rawValue);
          }
        } catch (e) {
          // ignore detection tick frame error
        }
      }
    }, 400);

  } catch (err) {
    console.warn('Kamere ni bilo mogoče zagnati:', err);
    statusEl.textContent = 'Kamera ni na voljo ali nimate dovoljenja. Uporabite ročni vnos kode spodaj.';
  }
}

function stopCamera() {
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
  }
  if (cameraStream) {
    cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
    const video = document.getElementById('cameraVideo');
    if (video) video.srcObject = null;
  }
  const statusEl = document.getElementById('scannerStatus');
  if (statusEl) statusEl.textContent = 'Kamera je izklopljena.';
}

async function handleDetectedCode(code) {
  if (navigator.vibrate) navigator.vibrate([80, 50, 80]);
  const resultCard = document.getElementById('scanResultCard');

  const item = await DB.getItemBySKU(code);
  resultCard.style.display = 'block';

  if (item) {
    resultCard.innerHTML = `
      <div style="color: var(--success); font-weight: bold; margin-bottom: 4px;">✓ Artikel prepoznan!</div>
      <div class="item-name">${escapeHtml(item.name)}</div>
      <div style="font-size: 0.85rem; color: var(--text-muted); margin: 4px 0;">Koda: <strong>${escapeHtml(item.sku)}</strong> &bull; Lokacija: <strong>${escapeHtml(item.location || 'Brez')}</strong></div>
      <div style="font-size: 1.2rem; font-weight: bold; margin: 8px 0;">Zaloga: ${item.quantity} ${escapeHtml(item.unit || 'kos')}</div>
      <div style="display: flex; gap: 8px; margin-top: 10px;">
        <button class="btn-primary" onclick="openStockChangeModal(${item.id}, 'in')">+ Prevzemi</button>
        <button class="btn-secondary" onclick="openStockChangeModal(${item.id}, 'out')">- Izdaj</button>
      </div>
    `;
    showToast(`Najden artikel: ${item.name}`);
  } else {
    resultCard.innerHTML = `
      <div style="color: var(--warning); font-weight: bold; margin-bottom: 4px;">⚠️ Artikel še ne obstaja v bazi</div>
      <div style="font-size: 0.9rem; color: var(--text-muted); margin-bottom: 10px;">Prebrana koda: <code>${escapeHtml(code)}</code></div>
      <button class="btn-primary" onclick="openAddWithSku('${escapeHtml(code)}')">+ Dodaj ta artikel v zalogo</button>
    `;
    showToast(`Neznana koda: ${code}`);
  }
}

window.openAddWithSku = function(sku) {
  const modalItem = document.getElementById('modalItem');
  const formItem = document.getElementById('formItem');
  formItem.reset();
  document.getElementById('itemId').value = '';
  document.getElementById('itemSku').value = sku;
  document.getElementById('modalItemTitle').textContent = 'Nov artikel s kodo';
  document.getElementById('btnDeleteItem').style.display = 'none';
  modalItem.style.display = 'flex';
};

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
