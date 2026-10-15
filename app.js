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

  // 6b. Priprava modula za inventuro
  setupAuditModule();

  // 6c. Priprava brezžične BLE sinhronizacije
  setupBLESync();

  // 7. Priprava optičnega čitalnika škatel (OCR)
  setupBoxOCRScanner();

  // 8. Takojšnje prednalaganje nevronskega OCR pospeševalnika v ozadju
  initOCRWorker();

  // 9. Naloži podatke iz IndexedDB (le če je čisto prvi zagon in še ni bilo inicializirano ali izbrisano)
  const isDemoSeeded = localStorage.getItem('skladisce_demo_seeded');
  const initialItems = await DB.getAllItems();
  if ((!initialItems || initialItems.length === 0) && !isDemoSeeded) {
    await DB.seedDemoData();
    localStorage.setItem('skladisce_demo_seeded', 'true');
  }
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
      } else if (targetId === 'tab-audit') {
        loadAuditSession();
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
    updateReceivingBannerUI();
    if (typeof updateConsolidationBadge === 'function') updateConsolidationBadge();
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
    <button class="chip ${currentFilter === 'low' ? 'active' : ''}" data-filter="low">Nizka zaloga</button>
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
    const stats = DB.getBoxStats(item);
    const qty = stats.completeSets;
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

    let boxBreakdownHtml = '';
    if (stats.boxTotal > 1) {
      boxBreakdownHtml = `
        <div class="box-breakdown-container" onclick="openEditModal('${escapeHtml(item.sku)}')">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 2px;">
            <span style="font-size:0.75rem; color:var(--text-muted); font-weight:600;">${stats.boxTotal} škatle na garnituro:</span>
            ${stats.hasIncomplete 
              ? `<span class="badge-incomplete">${escapeHtml(stats.missingSummary)}</span>` 
              : `<span class="badge-complete">Celi kompleti (${stats.completeSets})</span>`}
          </div>
          ${stats.breakdown.map(b => `
            <div class="box-breakdown-row">
              <span>Škatla ${b.boxNum}/${stats.boxTotal}: <span class="box-breakdown-loc">${escapeHtml(b.location)}</span></span>
              <span class="box-breakdown-count">${b.count} kos</span>
            </div>
          `).join('')}
        </div>
      `;
    }

    return `
      <div class="item-card" data-sku="${escapeHtml(item.sku)}">
        <div class="item-top" onclick="openEditModal('${escapeHtml(item.sku)}')">
          <div class="item-title-wrap">
            <div class="item-name">${escapeHtml(item.name)}</div>
            <div style="display:flex; flex-wrap:wrap; gap:6px; align-items:center;">
              <span class="item-sku-badge"># ${escapeHtml(item.sku)}</span>
              ${item.location ? `<span class="item-location">${escapeHtml(item.location)}</span>` : ''}
              ${stats.boxTotal > 1 ? `<span class="item-location" style="color:var(--primary); font-weight:600;">${stats.boxTotal}-delni komplet</span>` : ''}
            </div>
          </div>
          <span class="stock-status-badge ${statusClass}">${statusText}</span>
        </div>

        ${boxBreakdownHtml}

        <div class="item-bottom">
          <div class="item-qty-display" onclick="openEditModal('${escapeHtml(item.sku)}')">
            <span class="qty-number">${qty}</span>
            <span class="qty-unit">${escapeHtml(item.unit || (stats.boxTotal > 1 ? 'kompletov' : 'kos'))}</span>
          </div>
          <div class="quick-actions">
            <button class="btn-qty btn-move" onclick="event.stopPropagation(); openMoveModal('${escapeHtml(item.sku)}')" title="Premakni med regali" style="font-size: 0.72rem; padding: 0 8px; width: auto;">Regal</button>
            <button class="btn-qty" onclick="openStockChangeModal('${escapeHtml(item.sku)}', 'out')" title="Izdaj blago">-</button>
            <button class="btn-qty" onclick="openStockChangeModal('${escapeHtml(item.sku)}', 'in')" title="Prevzemi blago">+</button>
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

function renderModalBoxInputs(item) {
  const container = document.getElementById('modalBoxLocationsContainer');
  const rowsEl = document.getElementById('modalBoxRows');
  if (!container || !rowsEl) return;

  const boxInfoVal = document.getElementById('itemBoxInfo').value;
  const parsed = DB.parseBoxInfo(boxInfoVal);
  const boxTotal = (item && item.boxTotal) ? item.boxTotal : parsed.boxTotal;

  if (boxTotal <= 1) {
    container.style.display = 'none';
    rowsEl.innerHTML = '';
    return;
  }

  container.style.display = 'block';
  let html = '';
  const currentBoxes = (item && item.boxes) ? item.boxes : {};

  for (let b = 1; b <= boxTotal; b++) {
    const rawBox = currentBoxes[b] || { count: 0, location: document.getElementById('itemLocation').value || '' };
    const bData = DB.normalizeBoxLocations(rawBox, document.getElementById('itemLocation').value || 'Brez lokacije');
    const locs = (bData.locations && bData.locations.length > 0) ? bData.locations : [{ name: bData.location || '', count: bData.count || 0, isPrimary: true }];

    html += `
      <div class="modal-box-group" data-box="${b}" style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: var(--radius-sm); padding: 8px 10px; display:flex; flex-direction:column; gap:6px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <span style="font-size: 0.82rem; font-weight: 700; color: var(--primary);">
            Škatla ${b}/${boxTotal}
          </span>
          <button type="button" onclick="addModalShelfRow(${b})" style="background: rgba(56, 189, 248, 0.12); border: 1px solid rgba(56, 189, 248, 0.3); color: #38bdf8; font-size: 0.72rem; padding: 3px 8px; border-radius: 4px; cursor: pointer; font-weight: 700;">
            + Dodaj drug regal (preliv)
          </button>
        </div>
        <div class="modal-box-shelves-container" id="modalBoxShelves_${b}" style="display:flex; flex-direction:column; gap:5px;">
          ${locs.map((loc, lIdx) => `
            <div class="modal-shelf-row" style="display:flex; gap:6px; align-items:center;">
              <span style="font-size:0.75rem; color:${lIdx === 0 ? 'var(--text-muted)' : '#fbbf24'}; width: 62px; font-weight:600;">
                ${lIdx === 0 ? 'Glavni:' : 'Rezerva:'}
              </span>
              <input type="text" class="form-control modal-shelf-name" placeholder="Regal (npr. Regal P-04)" value="${escapeHtml(loc.name)}" style="flex:2; padding:5px 8px; font-size:0.85rem;">
              <div style="display:flex; align-items:center; gap:3px;">
                <input type="number" min="0" class="form-control modal-shelf-count" placeholder="Kosov" value="${loc.count}" style="width:65px; text-align:center; padding:5px 6px; font-size:0.85rem;">
                <span style="font-size:0.72rem; color:var(--text-muted);">kos</span>
              </div>
              ${lIdx > 0 ? `
                <button type="button" onclick="removeModalShelfRow(this)" style="background:none; border:none; color:#ef4444; cursor:pointer; font-size:1.1rem; padding:0 4px;" title="Odstrani ta regal">✕</button>
              ` : '<div style="width:20px;"></div>'}
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }
  rowsEl.innerHTML = html;
}

window.addModalShelfRow = function(boxNum) {
  const container = document.getElementById(`modalBoxShelves_${boxNum}`);
  if (!container) return;
  const div = document.createElement('div');
  div.className = 'modal-shelf-row';
  div.style.cssText = 'display:flex; gap:6px; align-items:center;';
  div.innerHTML = `
    <span style="font-size:0.75rem; color:#fbbf24; width: 62px; font-weight:600;">Rezerva:</span>
    <input type="text" class="form-control modal-shelf-name" placeholder="Rezervni regal (npr. Regal P-09)" value="" style="flex:2; padding:5px 8px; font-size:0.85rem;">
    <div style="display:flex; align-items:center; gap:3px;">
      <input type="number" min="0" class="form-control modal-shelf-count" placeholder="Kosov" value="0" style="width:65px; text-align:center; padding:5px 6px; font-size:0.85rem;">
      <span style="font-size:0.72rem; color:var(--text-muted);">kos</span>
    </div>
    <button type="button" onclick="removeModalShelfRow(this)" style="background:none; border:none; color:#ef4444; cursor:pointer; font-size:1.1rem; padding:0 4px;" title="Odstrani ta regal">✕</button>
  `;
  container.appendChild(div);
};

window.removeModalShelfRow = function(btn) {
  btn.closest('.modal-shelf-row')?.remove();
};

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
  const itemBoxInfoInput = document.getElementById('itemBoxInfo');

  itemBoxInfoInput.addEventListener('input', () => {
    const id = document.getElementById('itemId').value;
    if (id) {
      DB.getItemById(id).then(it => renderModalBoxInputs(it));
    } else {
      renderModalBoxInputs(null);
    }
  });

  btnOpenAddModal.addEventListener('click', () => {
    formItem.reset();
    document.getElementById('itemId').value = '';
    document.getElementById('modalItemTitle').textContent = 'Nov artikel';
    btnDeleteItem.style.display = 'none';
    renderModalBoxInputs(null);
    modalItem.style.display = 'flex';
  });

  btnCloseItemModal.addEventListener('click', () => {
    modalItem.style.display = 'none';
  });

  btnGenSku.addEventListener('click', () => {
    const rnd = Math.floor(1000 + Math.random() * 9000);
    document.getElementById('itemSku').value = 'ART-' + rnd;
  });

  formItem.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('itemId').value;
    const boxInfoStr = document.getElementById('itemBoxInfo').value || 'Box 1/1';
    const parsedBox = DB.parseBoxInfo(boxInfoStr);
    const boxTotal = parsedBox.boxTotal;

    const locInputs = document.querySelectorAll('.modal-box-loc');
    const countInputs = document.querySelectorAll('.modal-box-count');

    let boxes = {};
    let counts = [];

    if (boxTotal > 1) {
      for (let b = 1; b <= boxTotal; b++) {
        const shelfRows = document.querySelectorAll(`#modalBoxShelves_${b} .modal-shelf-row`);
        const locations = [];
        if (shelfRows.length > 0) {
          shelfRows.forEach((row, idx) => {
            const nameInput = row.querySelector('.modal-shelf-name');
            const countInput = row.querySelector('.modal-shelf-count');
            const name = nameInput?.value?.trim() || `Regal ${b}`;
            const count = Number(countInput?.value) || 0;
            locations.push({
              name: name,
              count: count,
              isPrimary: (idx === 0)
            });
          });
        } else {
          locations.push({
            name: document.getElementById('itemLocation').value || 'Brez lokacije',
            count: 0,
            isPrimary: true
          });
        }
        const bData = DB.normalizeBoxLocations({ locations }, document.getElementById('itemLocation').value || 'Brez lokacije');
        boxes[b] = bData;
        counts.push(bData.count);
      }
    } else {
      const singleQty = Number(document.getElementById('itemQuantity').value) || 0;
      const singleLoc = document.getElementById('itemLocation').value || 'Brez lokacije';
      boxes[1] = DB.normalizeBoxLocations({ count: singleQty, location: singleLoc }, singleLoc);
      counts.push(singleQty);
    }

    const calculatedCompleteSets = (boxTotal > 1) ? Math.min(...counts) : Number(document.getElementById('itemQuantity').value);

    const itemData = {
      sku: document.getElementById('itemSku').value,
      name: document.getElementById('itemName').value,
      boxInfo: boxInfoStr,
      boxTotal: boxTotal,
      boxes: boxes,
      category: document.getElementById('itemCategory').value,
      location: document.getElementById('itemLocation').value,
      quantity: calculatedCompleteSets,
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
        const res = await DB.addItem(itemData);
        if (res && res.wasMerged) {
          showToast('Artikel s to šifro že obstaja – zaloga in lokacije so bile združene.');
        } else {
          showToast('Nov artikel dodan v zalogo.');
        }
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

  if (btnCloseStockChange) {
    btnCloseStockChange.addEventListener('click', () => {
      modalStockChange.style.display = 'none';
    });
  }

  if (formStockChange) {
    formStockChange.addEventListener('submit', async (e) => {
      e.preventDefault();
      const itemId = document.getElementById('changeItemId').value;
      const direction = document.getElementById('changeDirection').value;
      const amount = Number(document.getElementById('changeAmount').value);
      const note = document.getElementById('changeNote').value;

      const delta = (direction === 'in') ? amount : -amount;

      try {
        if (direction === 'in') {
          const item = await DB.getItemById(itemId);
          if (item) {
            await recordReceivingEntry(item.sku, item.name, 1, item.boxTotal || 1, item.location || 'Glavni regal', amount);
          }
        }
        await DB.adjustStock(itemId, delta, note, direction);
        if (navigator.vibrate) navigator.vibrate(60);
        modalStockChange.style.display = 'none';
        showToast(direction === 'in' ? `Prevzem +${amount} zabeležen` : `Izdaja -${amount} zabeležena`);
        await refreshInventory();
      } catch (err) {
        console.error(err);
        showToast('Napaka pri posodobitvi zaloge.');
      }
    });
  }

  // Modal za premestitev med regali
  const modalMoveStock = document.getElementById('modalMoveStock');
  const btnCloseMoveStockModal = document.getElementById('btnCloseMoveStockModal');
  const btnCancelMoveStock = document.getElementById('btnCancelMoveStock');
  const formMoveStock = document.getElementById('formMoveStock');

  if (btnCloseMoveStockModal) {
    btnCloseMoveStockModal.addEventListener('click', () => {
      modalMoveStock.style.display = 'none';
    });
  }
  if (btnCancelMoveStock) {
    btnCancelMoveStock.addEventListener('click', () => {
      modalMoveStock.style.display = 'none';
    });
  }
  if (formMoveStock) {
    formMoveStock.addEventListener('submit', async (e) => {
      e.preventDefault();
      const sku = document.getElementById('moveItemSku').value;
      const boxNum = parseInt(document.getElementById('moveBoxNum').value, 10) || 1;
      const fromShelf = document.getElementById('moveFromShelf').value;
      const toShelf = document.getElementById('moveToShelf').value.trim();
      const amount = parseInt(document.getElementById('moveAmount').value, 10) || 1;
      const note = document.getElementById('moveNote').value.trim();

      try {
        await DB.moveStock(sku, boxNum, fromShelf, toShelf, amount, note);
        if (navigator.vibrate) navigator.vibrate(60);
        modalMoveStock.style.display = 'none';
        showToast(`Premaknjeno ${amount} škatel (${fromShelf} -> ${toShelf})`);
        await refreshInventory();
        if (typeof renderConsolidationList === 'function' && document.getElementById('modalConsolidation')?.style.display === 'flex') {
          await renderConsolidationList();
        }
      } catch (err) {
        console.error(err);
        showToast(err.message || 'Napaka pri premestitvi med regali.');
      }
    });
  }

  // Modal za prevzemno pošiljko
  const modalReceivingBatch = document.getElementById('modalReceivingBatch');
  const btnCloseReceivingModal = document.getElementById('btnCloseReceivingModal');
  const btnKeepReceiving = document.getElementById('btnKeepReceiving');
  const btnFinishReceivingSession = document.getElementById('btnFinishReceivingSession');
  const btnExportReceivingPDF = document.getElementById('btnExportReceivingPDF');
  const btnOpenReceivingModal = document.getElementById('btnOpenReceivingModal');

  if (btnCloseReceivingModal) {
    btnCloseReceivingModal.addEventListener('click', () => {
      modalReceivingBatch.style.display = 'none';
    });
  }
  if (btnKeepReceiving) {
    btnKeepReceiving.addEventListener('click', () => {
      modalReceivingBatch.style.display = 'none';
    });
  }
  if (btnFinishReceivingSession) {
    btnFinishReceivingSession.addEventListener('click', () => {
      finishReceivingSession();
    });
  }
  if (btnExportReceivingPDF) {
    btnExportReceivingPDF.addEventListener('click', () => {
      exportReceivingPDF();
    });
  }
  if (btnOpenReceivingModal) {
    btnOpenReceivingModal.addEventListener('click', () => {
      const session = getActiveReceivingSession();
      if (session && session.active) {
        openReceivingModal();
      } else {
        const name = prompt('Vnesite naziv ali številko prevzemne pošiljke:', `Pošiljka ${new Date().toLocaleDateString('sl-SI')}`);
        if (name !== null) {
          startReceivingSession(name.trim());
        }
      }
    });
  }

  // Zapri modal ob kliku zunaj
  window.addEventListener('click', (e) => {
    if (e.target === modalItem) modalItem.style.display = 'none';
    if (e.target === modalStockChange) modalStockChange.style.display = 'none';
    if (e.target === modalMoveStock) modalMoveStock.style.display = 'none';
    if (e.target === modalReceivingBatch) modalReceivingBatch.style.display = 'none';
    const modalCons = document.getElementById('modalConsolidation');
    if (modalCons && e.target === modalCons) modalCons.style.display = 'none';
    const modalArch = document.getElementById('modalReceivingArchive');
    if (modalArch && e.target === modalArch) modalArch.style.display = 'none';
  });

  updateReceivingBannerUI();
}

window.openEditModal = async function(id) {
  const item = await DB.getItemById(id);
  if (!item) return;

  document.getElementById('itemId').value = item.id;
  document.getElementById('itemSku').value = item.sku || '';
  document.getElementById('itemName').value = item.name || '';
  document.getElementById('itemBoxInfo').value = item.boxInfo || 'Box 1/1';
  const boxTotalEl = document.getElementById('itemBoxTotal');
  if (boxTotalEl) boxTotalEl.value = item.boxTotal || 1;
  document.getElementById('itemCategory').value = item.category || '';
  document.getElementById('itemLocation').value = item.location || '';
  document.getElementById('itemQuantity').value = item.quantity || 0;
  document.getElementById('itemMinQuantity').value = item.minQuantity || 0;
  document.getElementById('itemUnit').value = item.unit || 'kos';
  document.getElementById('itemNotes').value = item.notes || '';

  renderModalBoxInputs(item);

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
    title.textContent = 'Prevzem v skladišče';
    label.textContent = 'Količina prevzema (+)';
    btn.textContent = 'Potrdi prevzem';
  } else {
    title.textContent = 'Izdaja iz skladišča';
    label.textContent = 'Količina izdaje (-)';
    btn.textContent = 'Potrdi izdajo';
  }

  document.getElementById('modalStockChange').style.display = 'flex';
};

/* =========================================================================
   4b. PREMESTITEV MED REGALI (HITRI PREMIK)
   ========================================================================= */
window.openMoveModal = async function(sku, prefillBoxNum = null, prefillFromShelf = null, prefillToShelf = null, prefillAmount = null) {
  const item = await DB.getItemBySKU(sku);
  if (!item) return;

  const modalMove = document.getElementById('modalMoveStock');
  document.getElementById('moveItemSku').value = item.sku;
  document.getElementById('moveItemName').textContent = item.name;
  document.getElementById('moveItemSkuDisplay').textContent = `# ${item.sku}`;
  document.getElementById('moveToShelf').value = prefillToShelf || '';
  document.getElementById('moveNote').value = prefillToShelf ? 'Konsolidacija zaloge' : '';

  // Napolni predloge regalov za ciljni regal (vsi regali v skladišču)
  const datalist = document.getElementById('shelfSuggestions');
  if (datalist) {
    const allShelves = new Set();
    cachedItems.forEach(it => {
      if (it.boxes) {
        Object.values(it.boxes).forEach(bx => {
          (bx.locations || []).forEach(l => {
            if (l.name && l.name !== 'Brez lokacije') allShelves.add(l.name);
          });
        });
      }
    });
    datalist.innerHTML = Array.from(allShelves).sort().map(s => `<option value="${escapeHtml(s)}">`).join('');
  }

  const boxSelectGroup = document.getElementById('moveBoxSelectGroup');
  const boxSelect = document.getElementById('moveBoxNum');
  const fromSelect = document.getElementById('moveFromShelf');
  const amountInput = document.getElementById('moveAmount');

  const updateFromShelves = () => {
    const selectedBox = parseInt(boxSelect.value, 10) || 1;
    const bData = item.boxes && item.boxes[selectedBox];
    fromSelect.innerHTML = '';
    
    const locsWithStock = (bData?.locations || []).filter(l => (Number(l.count) || 0) > 0);
    if (locsWithStock.length === 0) {
      fromSelect.innerHTML = `<option value="">(Ni zaloge na nobenem regalu)</option>`;
      amountInput.value = 0;
      amountInput.max = 0;
    } else {
      locsWithStock.forEach(l => {
        const opt = document.createElement('option');
        opt.value = l.name;
        opt.textContent = `${l.name} (${l.count} kos na voljo)`;
        fromSelect.appendChild(opt);
      });
      amountInput.max = locsWithStock[0].count;
      amountInput.value = Math.min(1, locsWithStock[0].count);
    }
  };

  if (item.boxTotal > 1) {
    boxSelectGroup.style.display = 'block';
    boxSelect.innerHTML = '';
    for (let b = 1; b <= item.boxTotal; b++) {
      const opt = document.createElement('option');
      opt.value = b;
      opt.textContent = `Škatla ${b}/${item.boxTotal}`;
      boxSelect.appendChild(opt);
    }
    if (prefillBoxNum) {
      boxSelect.value = prefillBoxNum;
    }
  } else {
    boxSelectGroup.style.display = 'none';
    boxSelect.innerHTML = '<option value="1">Škatla 1/1</option>';
  }

  boxSelect.onchange = updateFromShelves;
  fromSelect.onchange = () => {
    const selectedBox = parseInt(boxSelect.value, 10) || 1;
    const bData = item.boxes && item.boxes[selectedBox];
    const curLoc = (bData?.locations || []).find(l => l.name === fromSelect.value);
    if (curLoc) {
      amountInput.max = curLoc.count;
      amountInput.value = Math.min(1, curLoc.count);
    }
  };

  updateFromShelves();

  if (prefillFromShelf) {
    fromSelect.value = prefillFromShelf;
    const selectedBox = parseInt(boxSelect.value, 10) || 1;
    const bData = item.boxes && item.boxes[selectedBox];
    const curLoc = (bData?.locations || []).find(l => l.name === prefillFromShelf);
    if (curLoc) {
      amountInput.max = curLoc.count;
      amountInput.value = prefillAmount ? Math.min(prefillAmount, curLoc.count) : curLoc.count;
    }
  }

  modalMove.style.display = 'flex';
};

/* =========================================================================
   4c. PREVZEMNA POŠILJKA & ANALIZA KOMPLETIRANJA TER PRIMANJKLJAJEV
   ========================================================================= */
const RECEIVING_SESSION_KEY = 'skladisce_active_receiving_session';

function getActiveReceivingSession() {
  try {
    const raw = localStorage.getItem(RECEIVING_SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    if (!session || typeof session !== 'object') return null;
    if (!session.initialStock || typeof session.initialStock !== 'object') {
      session.initialStock = {};
    }
    if (!Array.isArray(session.entries)) {
      session.entries = [];
    }
    return session;
  } catch (e) {
    return null;
  }
}

function saveActiveReceivingSession(session) {
  if (!session) {
    localStorage.removeItem(RECEIVING_SESSION_KEY);
  } else {
    localStorage.setItem(RECEIVING_SESSION_KEY, JSON.stringify(session));
  }
  updateReceivingBannerUI();
}

function startReceivingSession(customName = '') {
  const dateStr = new Date().toLocaleDateString('sl-SI');
  const session = {
    id: 'rec_' + Date.now(),
    name: customName || `Prevzem ${dateStr}`,
    startedAt: new Date().toISOString(),
    active: true,
    initialStock: {}, // { [sku]: { [boxNum]: number } }
    entries: [] // Array<{ id, timestamp, sku, name, boxNum, boxTotal, shelf, count }>
  };
  saveActiveReceivingSession(session);
  showToast(`Prevzem pošiljke "${session.name}" je zagnan.`);
  return session;
}

async function recordReceivingEntry(sku, name, boxNum, boxTotal, shelf, count) {
  const session = getActiveReceivingSession();
  if (!session || !session.active) return;

  const cleanSku = String(sku).trim();
  const bNum = Math.max(1, parseInt(boxNum, 10) || 1);
  const bTotal = Math.max(1, parseInt(boxTotal, 10) || 1);
  const qty = Math.max(1, parseInt(count, 10) || 1);

  if (!session.initialStock) session.initialStock = {};

  // Če za ta SKU še nimamo posnetega začetnega stanja pred pošiljko, ga preberemo iz DB
  if (!session.initialStock[cleanSku]) {
    session.initialStock[cleanSku] = {};
    const item = await DB.getItemBySKU(cleanSku);
    if (item && item.boxes) {
      for (let b = 1; b <= item.boxTotal; b++) {
        session.initialStock[cleanSku][b] = Number(item.boxes[b]?.count) || 0;
      }
    } else {
      for (let b = 1; b <= bTotal; b++) {
        session.initialStock[cleanSku][b] = 0;
      }
    }
  }

  // Preverimo stanje novo kompletiranih garnitur PRED tem vnosom
  const prevCompleted = calculateSkuCompletion(cleanSku, bTotal, session.initialStock[cleanSku], session.entries).completedFromOld;

  // Dodamo nov vnos
  session.entries.push({
    id: 'entry_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
    timestamp: new Date().toISOString(),
    sku: cleanSku,
    name: name || `Artikel ${cleanSku}`,
    boxNum: bNum,
    boxTotal: bTotal,
    shelf: shelf || 'Glavni regal',
    count: qty
  });

  // Preverimo stanje novo kompletiranih garnitur PO tem vnosu
  const newCompleted = calculateSkuCompletion(cleanSku, bTotal, session.initialStock[cleanSku], session.entries).completedFromOld;

  saveActiveReceivingSession(session);

  if (newCompleted > prevCompleted) {
    const diff = newCompleted - prevCompleted;
    showToast(`Kompletirano: +${diff} komplet artikla "${name}" (dopolnjeno s predhodno zalogo).`);
  }
}

/**
 * Izračuna kompletiranje garnitur po točnem pravilu:
 * - Če na paleti prideta 1/2 in 2/2 in imamo v skladišču že 2/2, se NE izpiše kompletirano.
 * - Le tiste škatle, ki so v tej pošiljki dejansko dopolnile manjkajoče škatle iz predhodne zaloge, štejejo.
 * - Vse vmesne izdaje iz skladišča se NE štejejo v prevzemno pošiljko in ne zmanjšujejo prevzetih škatel.
 */
function calculateSkuCompletion(sku, boxTotal, initialBoxCounts = {}, entries = []) {
  const bTotal = Math.max(1, parseInt(boxTotal, 10) || 1);
  const skuEntries = (Array.isArray(entries) ? entries : []).filter(e => e && String(e.sku).trim() === String(sku).trim());
  const initBoxCounts = (initialBoxCounts && typeof initialBoxCounts === 'object') ? initialBoxCounts : {};

  // Seštevek prejetih škatel v tej pošiljki po boxNum
  const batchCounts = {};
  for (let b = 1; b <= bTotal; b++) {
    batchCounts[b] = 0;
  }
  for (const entry of skuEntries) {
    const b = entry.boxNum || 1;
    batchCounts[b] = (batchCounts[b] || 0) + (Number(entry.count) || 0);
  }

  // Začetna zaloga pred pošiljko
  const initCounts = {};
  for (let b = 1; b <= bTotal; b++) {
    initCounts[b] = Number(initBoxCounts[b]) || 0;
  }

  // Število kompletov pred začetkom pošiljke
  const initMin = Math.min(...Object.values(initCounts));

  // Število celih kompletov znotraj same pošiljke (prišli na paleti skupaj)
  const batchMin = Math.min(...Object.values(batchCounts));

  // Skupno stanje po prejemu te pošiljke
  const currentCounts = {};
  for (let b = 1; b <= bTotal; b++) {
    currentCounts[b] = initCounts[b] + batchCounts[b];
  }
  const currentMin = Math.min(...Object.values(currentCounts));

  // Celotno povečanje celih garnitur
  const totalNewSets = Math.max(0, currentMin - initMin);

  // Kompletirano izključno iz predhodne zaloge (stara zaloga dopolnjena z novimi škatlami)
  // Če sta prišli 1/2 in 2/2 skupaj, se pobotata sami med seboj in ne štejeta kot dopolnitev stare zaloge
  const completedFromOld = (bTotal > 1) ? Math.max(0, totalNewSets - batchMin) : 0;

  // Primanjkljaji v pošiljki (če je prišlo več ene škatle kot druge)
  const batchMax = Math.max(...Object.values(batchCounts));
  const missingInBatch = [];
  if (bTotal > 1 && batchMax > 0) {
    for (let b = 1; b <= bTotal; b++) {
      if (batchCounts[b] < batchMax) {
        missingInBatch.push({
          boxNum: b,
          boxTotal: bTotal,
          missingCount: batchMax - batchCounts[b],
          receivedCount: batchCounts[b]
        });
      }
    }
  }

  return {
    sku,
    boxTotal: bTotal,
    initCounts,
    batchCounts,
    currentCounts,
    initMin,
    currentMin,
    batchMin,
    totalNewSets,
    completedFromOld,
    missingInBatch
  };
}

window.handleReceivingBannerClick = function() {
  const session = getActiveReceivingSession();
  if (session && session.active) {
    openReceivingModal();
  } else {
    const name = prompt('Vnesite naziv ali številko prevzemne pošiljke:', `Pošiljka ${new Date().toLocaleDateString('sl-SI')}`);
    if (name !== null) {
      startReceivingSession(name.trim());
    }
  }
};

function updateReceivingBannerUI() {
  try {
    const banner = document.getElementById('receivingBanner');
    const title = document.getElementById('receivingBannerTitle');
    const sub = document.getElementById('receivingBannerSub');
    const btn = document.getElementById('btnOpenReceivingModal');
    if (!banner || !title || !sub || !btn) return;

    const session = getActiveReceivingSession();
    if (session && session.active) {
      banner.style.display = 'flex';
      banner.style.background = 'rgba(16, 185, 129, 0.12)';
      banner.style.borderColor = 'rgba(16, 185, 129, 0.35)';

      const entries = Array.isArray(session.entries) ? session.entries : [];
      const totalBoxes = entries.reduce((sum, e) => sum + (Number(e.count) || 0), 0);
      
      let totalCompleted = 0;
      const skus = [...new Set(entries.map(e => e.sku).filter(Boolean))];
      for (const sku of skus) {
        const entry = entries.find(e => e.sku === sku);
        if (!entry) continue;
        const initMap = (session.initialStock && session.initialStock[sku]) ? session.initialStock[sku] : {};
        const res = calculateSkuCompletion(sku, entry.boxTotal || 1, initMap, entries);
        totalCompleted += res.completedFromOld;
      }

      title.innerHTML = `Prevzem: <strong>${escapeHtml(session.name)}</strong> <span style="font-size:0.75rem; color:#10b981; font-weight:normal;">(v teku)</span>`;
      sub.innerHTML = `Prevzeto: <strong>${totalBoxes}</strong> škatel &bull; Kompletirano: <strong style="color:#10b981;">${totalCompleted}</strong>`;
      btn.textContent = 'Pregled in zaključek';
      btn.style.background = '#10b981';
    } else {
      banner.style.display = 'flex';
      banner.style.background = 'rgba(255, 255, 255, 0.03)';
      banner.style.borderColor = 'var(--border)';
      title.innerHTML = `Prevzemna pošiljka <span style="font-size:0.75rem; color:var(--text-muted); font-weight:normal;">(ni aktivna)</span>`;
      sub.innerHTML = `Spremljanje prevzema blaga, kompletiranja in primanjkljajev.`;
      btn.textContent = 'Začni nov prevzem';
      btn.style.background = 'var(--primary)';
    }
  } catch (err) {
    console.error('Napaka v updateReceivingBannerUI:', err);
  }
}

window.openReceivingModal = function() {
  try {
    const session = getActiveReceivingSession();
    if (!session) {
      showToast('Ni aktivne prevzemne pošiljke.');
      return;
    }

    const modal = document.getElementById('modalReceivingBatch');
    if (!modal) {
      console.error('modalReceivingBatch ni najden v DOM!');
      return;
    }

    const titleEl = document.getElementById('receivingModalTitle');
    if (titleEl) titleEl.textContent = session.name || 'Prevzem pošiljke';
    
    const dateEl = document.getElementById('receivingModalDate');
    if (dateEl) {
      const startDate = session.startedAt 
        ? (new Date(session.startedAt).toLocaleDateString('sl-SI') + ' ob ' + new Date(session.startedAt).toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' }))
        : 'danes';
      dateEl.textContent = `Začetek prevzema: ${startDate}`;
    }

    const entries = Array.isArray(session.entries) ? session.entries : [];
    const initialStockMap = (session.initialStock && typeof session.initialStock === 'object') ? session.initialStock : {};

    const totalBoxes = entries.reduce((sum, e) => sum + (Number(e.count) || 0), 0);
    const totalEl = document.getElementById('recStatTotalBoxes');
    if (totalEl) totalEl.textContent = totalBoxes;

    // Analiza po artiklih
    const skus = [...new Set(entries.map(e => e.sku).filter(Boolean))];
    let totalCompletedSets = 0;
    let totalMissingBoxes = 0;

    const completedItems = [];
    const missingItems = [];

    for (const sku of skus) {
      const entry = entries.find(e => e.sku === sku);
      if (!entry) continue;
      const boxTotal = Math.max(1, parseInt(entry.boxTotal, 10) || 1);
      const initBoxStock = initialStockMap[sku] || {};
      const res = calculateSkuCompletion(sku, boxTotal, initBoxStock, entries);

      if (res.completedFromOld > 0) {
        totalCompletedSets += res.completedFromOld;
        completedItems.push({
          sku,
          name: entry.name,
          boxTotal,
          completedCount: res.completedFromOld,
          currentMin: res.currentMin
        });
      }

      if (res.missingInBatch && res.missingInBatch.length > 0) {
        const missCount = res.missingInBatch.reduce((sum, m) => sum + m.missingCount, 0);
        totalMissingBoxes += missCount;
        missingItems.push({
          sku,
          name: entry.name,
          boxTotal,
          missing: res.missingInBatch
        });
      }
    }

    const compEl = document.getElementById('recStatCompleted');
    if (compEl) compEl.textContent = totalCompletedSets;

    const missEl = document.getElementById('recStatMissing');
    if (missEl) missEl.textContent = totalMissingBoxes;

    // Izpis kompletiranih
    const compListEl = document.getElementById('recCompletedList');
    if (compListEl) {
      if (completedItems.length === 0) {
        compListEl.innerHTML = `<div style="font-size:0.8rem; color:var(--text-muted); padding:6px 0;">Ni dopolnjenih garnitur iz predhodne zaloge.</div>`;
      } else {
        compListEl.innerHTML = completedItems.map(c => `
          <div style="background: rgba(16, 185, 129, 0.08); border: 1px solid rgba(16, 185, 129, 0.25); border-radius: var(--radius-sm); padding: 8px 10px; display: flex; justify-content: space-between; align-items: center;">
            <div>
              <div style="font-weight: 700; font-size: 0.88rem; color: #fff;">${escapeHtml(c.name)}</div>
              <div style="font-size: 0.75rem; color: var(--text-muted);"># ${escapeHtml(c.sku)} &bull; ${c.boxTotal}-delna garnitura &bull; Skupaj na zalogi: ${c.currentMin} kpl</div>
            </div>
            <div style="background: #10b981; color: #fff; font-weight: 800; font-size: 0.85rem; border-radius: 6px; padding: 4px 8px; white-space: nowrap;">
              +${c.completedCount} kpl
            </div>
          </div>
        `).join('');
      }
    }

    // Izpis primanjkljajev
    const missListEl = document.getElementById('recMissingList');
    if (missListEl) {
      if (missingItems.length === 0) {
        missListEl.innerHTML = `<div style="font-size:0.8rem; color:var(--text-muted); padding:6px 0;">Brez primanjkljajev v tej pošiljki.</div>`;
      } else {
        missListEl.innerHTML = missingItems.map(m => `
          <div style="background: rgba(245, 158, 11, 0.08); border: 1px solid rgba(245, 158, 11, 0.25); border-radius: var(--radius-sm); padding: 8px 10px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
              <div style="font-weight: 700; font-size: 0.88rem; color: #fff;">${escapeHtml(m.name)}</div>
              <span style="font-size: 0.72rem; color: #fbbf24; font-weight: 700;"># ${escapeHtml(m.sku)}</span>
            </div>
            <div style="font-size: 0.76rem; color: #fbbf24;">
              ${m.missing.map(x => `Manjka ${x.missingCount}x Škatla ${x.boxNum}/${x.boxTotal} (prevzeto: ${x.receivedCount} kos)`).join('<br>')}
            </div>
          </div>
        `).join('');
      }
    }

    // Seznam vseh prevzetih postavk
    const allListEl = document.getElementById('recAllReceivedList');
    if (allListEl) {
      if (entries.length === 0) {
        allListEl.innerHTML = `<div style="font-size:0.8rem; color:var(--text-muted); padding:6px 0;">Ni prevzetih postavk.</div>`;
      } else {
        allListEl.innerHTML = entries.slice().reverse().map(e => `
          <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(255,255,255,0.02); border: 1px solid var(--border); border-radius: 4px; padding: 6px 8px; font-size: 0.78rem;">
            <div>
              <strong style="color: #fff;">${escapeHtml(e.name)}</strong>
              <span style="color: var(--text-muted); font-size: 0.72rem;">(#${escapeHtml(e.sku)} &bull; Šk.${e.boxNum}/${e.boxTotal} &bull; ${escapeHtml(e.shelf)})</span>
            </div>
            <div style="font-weight: 700; color: #10b981;">+${e.count} kos</div>
          </div>
        `).join('');
      }
    }

    modal.style.display = 'flex';
  } catch (err) {
    console.error('Napaka v openReceivingModal:', err);
    showToast('Napaka pri odpiranju prevzema: ' + err.message);
  }
};

window.finishReceivingSession = function() {
  const session = getActiveReceivingSession();
  if (!session) return;

  if (confirm(`Ali želite zaključiti prevzem pošiljke "${session.name}"?`)) {
    try {
      const historyKey = 'skladisce_receiving_history';
      const hist = JSON.parse(localStorage.getItem(historyKey) || '[]');
      session.finishedAt = new Date().toISOString();
      session.active = false;

      // Izračunaj statistični povzetek pred arhiviranjem
      const entries = Array.isArray(session.entries) ? session.entries : [];
      const totalBoxes = entries.reduce((sum, e) => sum + (Number(e.count) || 0), 0);
      const skus = [...new Set(entries.map(e => e.sku).filter(Boolean))];

      let totalCompleted = 0;
      let missingCount = 0;
      for (const sku of skus) {
        const entry = entries.find(e => e.sku === sku);
        if (!entry) continue;
        const initMap = (session.initialStock && session.initialStock[sku]) ? session.initialStock[sku] : {};
        const res = calculateSkuCompletion(sku, entry.boxTotal || 1, initMap, entries);
        totalCompleted += res.totalNewSets;
        if (res.missingInBatch.length > 0) missingCount++;
      }

      session.stats = {
        totalBoxes,
        uniqueSkusCount: skus.length,
        totalCompletedSets: totalCompleted,
        incompleteItemsCount: missingCount
      };

      hist.unshift(session);
      if (hist.length > 50) hist.pop();
      localStorage.setItem(historyKey, JSON.stringify(hist));
    } catch (e) {
      console.warn('Napaka pri shranjevanju v zgodovino prevzemov:', e);
    }

    localStorage.removeItem(RECEIVING_SESSION_KEY);
    document.getElementById('modalReceivingBatch').style.display = 'none';
    updateReceivingBannerUI();
    showToast(`Prevzem pošiljke "${session.name}" je zaključen in arhiviran.`);
  }
};

window.exportReceivingPDF = function(customSession = null) {
  const session = customSession || getActiveReceivingSession();
  if (!session) {
    showToast('Ni prevzemne pošiljke za izvoz.');
    return;
  }

  if (typeof window.jspdf === 'undefined' || !window.jspdf.jsPDF) {
    showToast('jsPDF knjižnica ni naložena.');
    return;
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4'
  });

  const pageWidth = 210;
  const pageHeight = 297;
  const margin = 12;
  const contentWidth = pageWidth - (margin * 2); // 186mm

  let currentPage = 1;
  let y = 14;

  function stripSlo(str) {
    if (!str) return '';
    return String(str)
      .replace(/[čČ]/g, c => c === 'č' ? 'c' : 'C')
      .replace(/[šŠ]/g, c => c === 'š' ? 's' : 'S')
      .replace(/[žŽ]/g, c => c === 'ž' ? 'z' : 'Z')
      .replace(/[ćĆ]/g, c => c === 'ć' ? 'c' : 'C')
      .replace(/[đĐ]/g, c => c === 'đ' ? 'dj' : 'Dj');
  }

  // Izračun analitike
  const skus = [...new Set((session.entries || []).map(e => e.sku))];
  const totalBoxes = (session.entries || []).reduce((sum, e) => sum + (Number(e.count) || 0), 0);
  let totalCompletedSets = 0;
  let totalMissingBoxes = 0;

  const completedItems = [];
  const missingItems = [];

  for (const sku of skus) {
    const entry = session.entries.find(e => e.sku === sku);
    const boxTotal = entry.boxTotal || 1;
    const res = calculateSkuCompletion(sku, boxTotal, session.initialStock[sku], session.entries);

    if (res.completedFromOld > 0) {
      totalCompletedSets += res.completedFromOld;
      completedItems.push({
        sku,
        name: entry.name,
        boxTotal,
        completedCount: res.completedFromOld,
        currentMin: res.currentMin
      });
    }

    if (res.missingInBatch.length > 0) {
      const missCount = res.missingInBatch.reduce((sum, m) => sum + m.missingCount, 0);
      totalMissingBoxes += missCount;
      missingItems.push({
        sku,
        name: entry.name,
        boxTotal,
        missing: res.missingInBatch
      });
    }
  }

  function drawHeader() {
    doc.setFillColor(5, 150, 105);
    doc.rect(margin, y, contentWidth, 22, 'F');

    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.text('ZAPISNIK PREVZEMA POSILJKE BLAGA', margin + 6, y + 8.5);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.2);
    doc.setTextColor(209, 250, 229);
    const startStr = new Date(session.startedAt).toLocaleDateString('sl-SI') + ' ob ' + new Date(session.startedAt).toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' });
    const printStr = new Date().toLocaleDateString('sl-SI') + ' ob ' + new Date().toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' });
    doc.text(stripSlo(`Posiljka: "${session.name}" | Zacetek: ${startStr} | Natisnjeno: ${printStr}`), margin + 6, y + 16);

    y += 26;

    doc.setFillColor(240, 253, 244);
    doc.rect(margin, y, contentWidth, 12, 'F');
    doc.setDrawColor(167, 243, 208);
    doc.rect(margin, y, contentWidth, 12, 'S');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.2);
    doc.setTextColor(15, 23, 42);

    const colW = contentWidth / 3;
    doc.text(`SKUPAJ PREVZETIH SKATEL: ${totalBoxes}`, margin + 5, y + 7.5);

    doc.setTextColor(5, 150, 105);
    doc.text(`NOVO KOMPLETIRANO: +${totalCompletedSets} kpl`, margin + colW + 5, y + 7.5);

    if (totalMissingBoxes > 0) {
      doc.setTextColor(217, 119, 6);
      doc.text(`PRIMANKLJAJI: ${totalMissingBoxes} skatel`, margin + (colW * 2) + 5, y + 7.5);
    } else {
      doc.setTextColor(100, 116, 139);
      doc.text(`PRIMANKLJAJI: 0 skatel (Vsi pari)`, margin + (colW * 2) + 5, y + 7.5);
    }

    y += 16;
  }

  function drawFooter(pageNo) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(148, 163, 184);
    doc.text(`Skladisce - Zapisnik prevzema posiljke - Stran ${pageNo}`, margin, pageHeight - 6);
  }

  function checkPageBreak(neededHeight) {
    if (y + neededHeight > pageHeight - 20) {
      drawFooter(currentPage);
      doc.addPage();
      currentPage++;
      y = 14;
      return true;
    }
    return false;
  }

  drawHeader();

  // RAZDELEK 1: NOVO KOMPLETIRANE GARNITURE
  doc.setFillColor(16, 185, 129);
  doc.rect(margin, y, contentWidth, 7, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.text('1. NOVO KOMPLETIRANE GARNITURE (Dopolnjeno s predhodno zalogo)', margin + 4, y + 4.8);
  y += 9;

  if (completedItems.length === 0) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    doc.text('V tej posiljki nobena garnitura ni bila na novo kompletirana iz predhodno manjkajoce zaloge.', margin + 4, y + 4);
    y += 8;
  } else {
    doc.setFillColor(241, 245, 249);
    doc.rect(margin, y, contentWidth, 6, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(51, 65, 85);
    doc.text('SIFRA ARTIKLA', margin + 3, y + 4.2);
    doc.text('NAZIV ARTIKLA', margin + 40, y + 4.2);
    doc.text('GARNITURA', margin + 115, y + 4.2);
    doc.text('NOVO KOMPLETIRANO', margin + 145, y + 4.2);
    y += 7;

    for (const c of completedItems) {
      checkPageBreak(8);
      doc.setFillColor(255, 255, 255);
      doc.rect(margin, y, contentWidth, 7, 'F');
      doc.setDrawColor(226, 232, 240);
      doc.line(margin, y + 7, margin + contentWidth, y + 7);

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.setTextColor(15, 23, 42);
      doc.text(stripSlo(c.sku), margin + 3, y + 4.8);

      doc.setFont('helvetica', 'normal');
      const cleanName = stripSlo(c.name);
      doc.text(cleanName.length > 40 ? cleanName.substring(0, 38) + '...' : cleanName, margin + 40, y + 4.8);

      doc.text(`${c.boxTotal}-delni kpl`, margin + 115, y + 4.8);

      doc.setFont('helvetica', 'bold');
      doc.setTextColor(5, 150, 105);
      doc.text(`+${c.completedCount} kpl (skupaj: ${c.currentMin})`, margin + 145, y + 4.8);

      y += 7.5;
    }
  }

  y += 5;
  checkPageBreak(25);

  // RAZDELEK 2: PRIMANJKLJAJI V TEJ POŠILJKI
  doc.setFillColor(217, 119, 6);
  doc.rect(margin, y, contentWidth, 7, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.text('2. PRIMANKLJAJI IN NEPOPOLNE SKATLE V TEJ POSILJKI', margin + 4, y + 4.8);
  y += 9;

  if (missingItems.length === 0) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    doc.text('Vsi vecskatelni artikli so prispeli v ustreznem stevilu skatel (ni zaznanih primankljajev).', margin + 4, y + 4);
    y += 8;
  } else {
    for (const m of missingItems) {
      const missText = m.missing.map(x => `Manjka ${x.missingCount}x Skatla ${x.boxNum}/${x.boxTotal} (prejeto: ${x.receivedCount} kos)`).join(', ');
      checkPageBreak(8);

      doc.setFillColor(254, 243, 199);
      doc.rect(margin, y, contentWidth, 7, 'F');
      doc.setDrawColor(251, 191, 36);
      doc.rect(margin, y, contentWidth, 7, 'S');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.setTextColor(180, 83, 9);
      doc.text(stripSlo(m.sku), margin + 3, y + 4.8);

      doc.setTextColor(30, 41, 59);
      const cleanName = stripSlo(m.name);
      doc.text(cleanName.length > 30 ? cleanName.substring(0, 28) + '...' : cleanName, margin + 35, y + 4.8);

      doc.setTextColor(180, 83, 9);
      doc.text(stripSlo(missText), margin + 95, y + 4.8);

      y += 8.5;
    }
  }

  y += 5;
  checkPageBreak(25);

  // RAZDELEK 3: SEZNAM VSEH PREVZETIH POSTAVK
  doc.setFillColor(30, 41, 59);
  doc.rect(margin, y, contentWidth, 7, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.text('3. SEZNAM VSEH PREVZETIH SKATEL PO REGALIH', margin + 4, y + 4.8);
  y += 8;

  doc.setFillColor(241, 245, 249);
  doc.rect(margin, y, contentWidth, 6, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.2);
  doc.setTextColor(71, 85, 105);
  doc.text('DATUM & CAS', margin + 3, y + 4.2);
  doc.text('SIFRA', margin + 32, y + 4.2);
  doc.text('NAZIV ARTIKLA', margin + 62, y + 4.2);
  doc.text('SKATLA', margin + 125, y + 4.2);
  doc.text('REGAL', margin + 145, y + 4.2);
  doc.text('KOLICINA', margin + 172, y + 4.2);
  y += 7;

  let rowCount = 0;
  for (const entry of (session.entries || [])) {
    checkPageBreak(7);
    rowCount++;
    const isEven = rowCount % 2 === 0;
    if (isEven) {
      doc.setFillColor(248, 250, 252);
      doc.rect(margin, y, contentWidth, 6.5, 'F');
    }
    doc.setDrawColor(226, 232, 240);
    doc.line(margin, y + 6.5, margin + contentWidth, y + 6.5);

    const timeStr = new Date(entry.timestamp).toLocaleDateString('sl-SI') + ' ' + new Date(entry.timestamp).toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.2);
    doc.setTextColor(100, 116, 139);
    doc.text(timeStr, margin + 3, y + 4.4);

    doc.setFont('helvetica', 'bold');
    doc.setTextColor(15, 23, 42);
    doc.text(stripSlo(entry.sku), margin + 32, y + 4.4);

    doc.setFont('helvetica', 'normal');
    const cleanName = stripSlo(entry.name);
    doc.text(cleanName.length > 32 ? cleanName.substring(0, 30) + '...' : cleanName, margin + 62, y + 4.4);

    doc.text(`${entry.boxNum}/${entry.boxTotal}`, margin + 125, y + 4.4);
    doc.text(stripSlo(entry.shelf || 'Glavni regal'), margin + 145, y + 4.4);

    doc.setFont('helvetica', 'bold');
    doc.setTextColor(5, 150, 105);
    doc.text(`+${entry.count} kos`, margin + 172, y + 4.4);

    y += 6.5;
  }

  // Podpisno polje na dnu
  checkPageBreak(25);
  y += 8;
  doc.setDrawColor(203, 213, 225);
  doc.line(margin, y, margin + 65, y);
  doc.line(margin + 115, y, margin + contentWidth, y);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(100, 116, 139);
  doc.text('Podpis skladiscnika / prevzemnika', margin, y + 4.5);
  doc.text('Podpis in zig vodje skladisca', margin + 115, y + 4.5);

  drawFooter(currentPage);

  const cleanFileTitle = stripSlo(session.name).replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeFilename = `Prevzem_${cleanFileTitle}_${new Date().toISOString().slice(0, 10)}.pdf`;
  downloadFile(doc.output('blob'), safeFilename, 'application/pdf');
  showToast(`PDF poročilo "${safeFilename}" je shranjeno.`);
};

/* =========================================================================
   4c. KONSOLIDACIJA ZALOGE (ZDRUŽEVANJE RAZPRŠENIH ŠKATEL)
   ========================================================================= */
window.updateConsolidationBadge = async function() {
  try {
    const badge = document.getElementById('consolidationBadge');
    if (!badge) return;
    const scattered = await DB.getScatteredItems();
    badge.textContent = scattered.length;
    const btn = document.getElementById('btnOpenConsolidation');
    if (btn) {
      if (scattered.length > 0) {
        btn.style.borderColor = 'rgba(168, 85, 247, 0.7)';
        btn.style.boxShadow = '0 0 10px rgba(168, 85, 247, 0.25)';
      } else {
        btn.style.borderColor = 'rgba(168, 85, 247, 0.35)';
        btn.style.boxShadow = 'none';
      }
    }
  } catch (e) {
    console.warn('Napaka pri osveževanju značke konsolidacije:', e);
  }
};

window.openConsolidationModal = async function() {
  const modal = document.getElementById('modalConsolidation');
  if (!modal) return;
  modal.style.display = 'flex';
  await renderConsolidationList();
};

window.closeConsolidationModal = function() {
  const modal = document.getElementById('modalConsolidation');
  if (modal) modal.style.display = 'none';
};

window.renderConsolidationList = async function() {
  const listEl = document.getElementById('consolidationItemsList');
  if (!listEl) return;

  listEl.innerHTML = '<div style="color: var(--text-muted); text-align: center; padding: 20px;">Iščem razpršene artikle in škatle...</div>';

  try {
    const scattered = await DB.getScatteredItems();
    await updateConsolidationBadge();

    if (scattered.length === 0) {
      listEl.innerHTML = `
        <div style="background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.3); border-radius: var(--radius-md); padding: 20px 16px; text-align: center;">
          <h4 style="font-size: 1rem; color: #10b981; margin-bottom: 4px;">Zaloga je usklajena</h4>
          <p style="font-size: 0.82rem; color: var(--text-muted); margin: 0;">
            Vsi kompleti imajo škatle zbrane na enotnih regalih.
          </p>
        </div>
      `;
      return;
    }

    listEl.innerHTML = scattered.map(item => {
      return `
        <div style="background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 12px; display: flex; flex-direction: column; gap: 8px;">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 8px;">
            <div>
              <div style="font-weight: 700; font-size: 0.95rem; color: #fff;">${escapeHtml(item.name)}</div>
              <div style="font-size: 0.76rem; color: var(--primary); font-family: monospace;"># ${escapeHtml(item.sku)} &bull; ${item.boxTotal > 1 ? `${item.boxTotal}-delni komplet` : 'Enojni artikel'}</div>
            </div>
            <span class="badge" style="background: rgba(168, 85, 247, 0.2); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.4); font-size: 0.72rem; padding: 4px 8px; border-radius: 4px; white-space: nowrap;">
              Cilj: ${escapeHtml(item.targetShelf)}
            </span>
          </div>

          <!-- Prikaz trenutne razpršenosti -->
          <div style="background: rgba(0,0,0,0.25); border-radius: var(--radius-sm); padding: 8px 10px; font-size: 0.78rem; display: flex; flex-direction: column; gap: 4px;">
            <div style="font-size: 0.7rem; color: var(--text-muted); text-transform: uppercase; font-weight: 700;">Trenutne lokacije škatel:</div>
            ${item.locations.map(loc => `
              <div style="display: flex; justify-content: space-between; align-items: center; padding: 2px 0;">
                <span style="color: ${loc.shelf === item.targetShelf ? '#34d399' : '#f59e0b'};">
                  Škatla ${loc.boxNum}/${loc.boxTotal}: <strong>${escapeHtml(loc.shelf)}</strong>
                </span>
                <span style="font-weight: 700; color: #fff;">${loc.count} kos</span>
              </div>
            `).join('')}
          </div>

          <!-- Nalog za premik za vsako škatlo, ki ni na cilju -->
          ${item.boxesToMove.map(bm => `
            <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(245, 158, 11, 0.08); border: 1px solid rgba(245, 158, 11, 0.3); border-radius: var(--radius-sm); padding: 8px 10px;">
              <div style="font-size: 0.78rem;">
                <span style="color: #fbbf24; font-weight: 700;">Premakni Škatlo ${bm.boxNum}/${bm.boxTotal}:</span>
                <div style="color: var(--text-muted); font-size: 0.74rem;">
                  Iz <strong>${escapeHtml(bm.shelf)}</strong> -> Na <strong>${escapeHtml(item.targetShelf)}</strong> (${bm.count} kos)
                </div>
              </div>
              <button type="button" class="btn-sm" onclick="quickConsolidateMove('${escapeHtml(item.sku)}', ${bm.boxNum}, '${escapeHtml(bm.shelf)}', '${escapeHtml(item.targetShelf)}', ${bm.count})" style="background: #a855f7; color: #fff; border: none; border-radius: 6px; padding: 7px 12px; font-weight: 700; font-size: 0.76rem; cursor: pointer; white-space: nowrap;">
                Združi
              </button>
            </div>
          `).join('')}
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Napaka v renderConsolidationList:', err);
    listEl.innerHTML = `<div style="color: #ef4444; padding: 12px;">Napaka pri branju konsolidacije: ${err.message}</div>`;
  }
};

window.quickConsolidateMove = function(sku, boxNum, fromShelf, toShelf, amount) {
  openMoveModal(sku, boxNum, fromShelf, toShelf, amount);
};

window.exportConsolidationPDF = async function() {
  try {
    showToast('Pripravljam nalog za konsolidacijo zaloge...');
    const scattered = await DB.getScatteredItems();

    if (typeof window.jspdf === 'undefined' || !window.jspdf.jsPDF) {
      showToast('jsPDF knjižnica ni na voljo.');
      return;
    }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: 'a4'
    });

    const pageWidth = 210;
    const pageHeight = 297;
    const margin = 12;
    const contentWidth = pageWidth - (margin * 2);

    let currentPage = 1;
    let y = 14;

    function stripSlo(str) {
      if (!str) return '';
      return String(str)
        .replace(/[čČ]/g, c => c === 'č' ? 'c' : 'C')
        .replace(/[šŠ]/g, c => c === 'š' ? 's' : 'S')
        .replace(/[žŽ]/g, c => c === 'ž' ? 'z' : 'Z')
        .replace(/[ćĆ]/g, c => c === 'ć' ? 'c' : 'C')
        .replace(/[đĐ]/g, c => c === 'đ' ? 'dj' : 'Dj');
    }

    function drawHeader() {
      doc.setFillColor(126, 34, 206); // Vijolična #7e22ce
      doc.rect(margin, y, contentWidth, 22, 'F');

      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(13);
      doc.text('DELOVNI NALOG: KONSOLIDACIJA IN ZDRUZEVANJE ZALOGE', margin + 6, y + 8.5);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.2);
      doc.setTextColor(243, 232, 255);
      const nowStr = new Date().toLocaleDateString('sl-SI') + ' ob ' + new Date().toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' });
      doc.text(`Seznam nalog za premik razprsenih skatel na enotne regale | Datum: ${nowStr}`, margin + 6, y + 16);

      y += 26;

      doc.setFillColor(243, 232, 255);
      doc.rect(margin, y, contentWidth, 8, 'F');
      doc.setDrawColor(168, 85, 247);
      doc.rect(margin, y, contentWidth, 8, 'S');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(88, 28, 135);

      doc.text('SIFRA / ARTIKEL', margin + 3, y + 5.5);
      doc.text('SKATLA & TRENUTNI REGAL (VIR)', margin + 70, y + 5.5);
      doc.text('CILJNI REGAL (KAM PREMAKNITI)', margin + 130, y + 5.5);
      doc.text('OPRAVLJENO', margin + 168, y + 5.5);

      y += 8.5;
    }

    function drawFooter(pageNo) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(148, 163, 184);
      doc.text(`Skladisce - Nalog za konsolidacijo - Stran ${pageNo}`, margin, pageHeight - 6);
    }

    drawHeader();

    if (scattered.length === 0) {
      y += 8;
      doc.setFillColor(240, 253, 244);
      doc.rect(margin, y, contentWidth, 24, 'F');
      doc.setDrawColor(34, 197, 94);
      doc.rect(margin, y, contentWidth, 24, 'S');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(22, 101, 52);
      doc.text('VSE SKATLE SO ZE KONSOLIDIRANE', margin + 8, y + 10);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(21, 128, 61);
      doc.text('Noben artikel nima razprsenih skatel po razlicnih regalih.', margin + 8, y + 18);

      drawFooter(currentPage);
      const fileName = `skladisce-konsolidacija-${getDateStamp()}.pdf`;
      await downloadFile(doc.output('blob'), fileName, 'application/pdf');
      showToast('PDF nalog konsolidacije prenesen.');
      return;
    }

    let rowIndex = 0;
    for (const item of scattered) {
      for (const box of item.boxesToMove) {
        if (y > pageHeight - 20) {
          drawFooter(currentPage);
          doc.addPage();
          currentPage++;
          y = 14;
          drawHeader();
        }

        const bg = (rowIndex % 2 === 0) ? 255 : 250;
        doc.setFillColor(bg, bg, bg);
        doc.rect(margin, y, contentWidth, 12, 'F');
        doc.setDrawColor(226, 232, 240);
        doc.line(margin, y + 12, margin + contentWidth, y + 12);

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8.5);
        doc.setTextColor(15, 23, 42);
        doc.text(stripSlo(item.sku), margin + 3, y + 5);

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.5);
        doc.setTextColor(71, 85, 105);
        const nameTrunc = stripSlo(item.name || '').slice(0, 30);
        doc.text(nameTrunc, margin + 3, y + 9.5);

        // Vir
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8);
        doc.setTextColor(180, 83, 9);
        const boxLabel = item.boxTotal > 1 ? `Skatla ${box.boxNum}/${box.boxTotal}` : `Artikel`;
        doc.text(`${boxLabel} (${box.count} kos)`, margin + 70, y + 5);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(71, 85, 105);
        doc.text(`Iz: ${stripSlo(box.shelf)}`, margin + 70, y + 9.5);

        // Cilj
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8.5);
        doc.setTextColor(22, 101, 52);
        doc.text(`Na: ${stripSlo(item.targetShelf)}`, margin + 130, y + 7);

        // Kvadratek za kljukico
        doc.setDrawColor(100, 116, 139);
        doc.rect(margin + 172, y + 3.5, 5, 5, 'S');

        y += 12;
        rowIndex++;
      }
    }

    drawFooter(currentPage);
    const fileName = `skladisce-konsolidacija-${getDateStamp()}.pdf`;
    await downloadFile(doc.output('blob'), fileName, 'application/pdf');
    showToast('PDF delovni nalog konsolidacije shranjen.');
  } catch (err) {
    console.error('Napaka pri PDF konsolidacije:', err);
    showToast('Napaka pri PDF konsolidacije: ' + err.message);
  }
};

/* =========================================================================
   4d. ARHIV PRETEKLIH PREVZEMNIH POŠILJK
   ========================================================================= */
window.openReceivingArchiveModal = function() {
  const modal = document.getElementById('modalReceivingArchive');
  if (!modal) return;
  modal.style.display = 'flex';
  renderReceivingArchiveList();
};

window.closeReceivingArchiveModal = function() {
  const modal = document.getElementById('modalReceivingArchive');
  if (modal) modal.style.display = 'none';
};

window.renderReceivingArchiveList = function() {
  const listEl = document.getElementById('receivingArchiveList');
  if (!listEl) return;

  try {
    const historyKey = 'skladisce_receiving_history';
    const hist = JSON.parse(localStorage.getItem(historyKey) || '[]');

    if (!Array.isArray(hist) || hist.length === 0) {
      listEl.innerHTML = `
        <div style="background: rgba(255, 255, 255, 0.02); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 20px 16px; text-align: center;">
          <h4 style="font-size: 1rem; color: #fff; margin-bottom: 4px;">Arhiv je prazen</h4>
          <p style="font-size: 0.82rem; color: var(--text-muted); margin: 0;">
            Zaključene prevzemne pošiljke se samodejno shranijo v arhiv.
          </p>
        </div>
      `;
      return;
    }

    listEl.innerHTML = hist.map((session, index) => {
      const started = session.startedAt ? new Date(session.startedAt).toLocaleString('sl-SI', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Neznano';
      const finished = session.finishedAt ? new Date(session.finishedAt).toLocaleString('sl-SI', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Neznano';

      const entries = Array.isArray(session.entries) ? session.entries : [];
      const totalBoxes = session.stats?.totalBoxes || entries.reduce((sum, e) => sum + (Number(e.count) || 0), 0);
      const uniqueSkus = session.stats?.uniqueSkusCount || new Set(entries.map(e => e.sku)).size;
      const completedSets = session.stats?.totalCompletedSets || 0;
      const incompleteCount = session.stats?.incompleteItemsCount || 0;

      return `
        <div style="background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 12px; display: flex; flex-direction: column; gap: 8px;">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 8px;">
            <div>
              <div style="font-weight: 700; font-size: 1rem; color: #fff;">${escapeHtml(session.name || 'Neimenovana pošiljka')}</div>
              <div style="font-size: 0.73rem; color: var(--text-muted); margin-top: 2px;">
                Začetek: ${started} &bull; Zaključek: ${finished}
              </div>
            </div>
            <button type="button" class="btn-sm" onclick="deleteHistoricalReceivingSession(${index})" style="background: none; border: 1px solid rgba(239, 68, 68, 0.3); color: #f87171; border-radius: 6px; padding: 4px 8px; font-size: 0.72rem; cursor: pointer;" title="Izbriši iz arhiva">
              Izbriši
            </button>
          </div>

          <!-- Značke statistike -->
          <div style="display: flex; flex-wrap: wrap; gap: 6px; font-size: 0.75rem;">
            <span class="badge" style="background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); padding: 3px 8px; border-radius: 4px;">
              ${totalBoxes} škatel (${uniqueSkus} artiklov)
            </span>
            <span class="badge" style="background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.3); padding: 3px 8px; border-radius: 4px;">
              ${completedSets} celih kompletov
            </span>
            ${incompleteCount > 0 ? `
              <span class="badge" style="background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3); padding: 3px 8px; border-radius: 4px;">
                ${incompleteCount} primanjkljajev
              </span>
            ` : `
              <span class="badge" style="background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3); padding: 3px 8px; border-radius: 4px;">
                Brez primanjkljajev
              </span>
            `}
          </div>

          <!-- Gumbi za dejanja -->
          <div style="display: flex; gap: 8px; margin-top: 4px;">
            <button type="button" class="btn-primary" onclick="exportHistoricalReceivingPDF(${index})" style="margin: 0; flex: 2; background: linear-gradient(135deg, #38bdf8, #0284c7); padding: 9px 12px; font-size: 0.8rem;">
              Prenesi PDF zapisnik
            </button>
            <button type="button" class="btn-secondary" onclick="toggleHistoricalDetails(${index})" style="margin: 0; flex: 1; padding: 9px 10px; font-size: 0.8rem;">
              Podrobnosti
            </button>
          </div>

          <!-- Podrobnosti seznama (privzeto skrito) -->
          <div id="histDetails_${index}" style="display: none; margin-top: 6px; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 8px; max-height: 180px; overflow-y: auto; font-size: 0.76rem; flex-direction: column; gap: 4px;">
            <div style="font-weight: 700; color: var(--text-muted); margin-bottom: 2px;">Vse prevzete škatle v tej pošiljki:</div>
            ${entries.slice().reverse().map(e => `
              <div style="display:flex; justify-content:space-between; background: rgba(0,0,0,0.2); padding: 4px 6px; border-radius: 4px;">
                <span>${escapeHtml(e.name)} (#${escapeHtml(e.sku)} &bull; Šk.${e.boxNum}/${e.boxTotal} &bull; ${escapeHtml(e.shelf)})</span>
                <span style="color:#10b981; font-weight:700;">+${e.count}</span>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Napaka v renderReceivingArchiveList:', err);
    listEl.innerHTML = `<div style="color: #ef4444; padding: 12px;">Napaka pri branju arhiva: ${err.message}</div>`;
  }
};

window.toggleHistoricalDetails = function(index) {
  const el = document.getElementById(`histDetails_${index}`);
  if (el) {
    el.style.display = (el.style.display === 'none' || !el.style.display) ? 'flex' : 'none';
  }
};

window.exportHistoricalReceivingPDF = function(index) {
  const historyKey = 'skladisce_receiving_history';
  const hist = JSON.parse(localStorage.getItem(historyKey) || '[]');
  const session = hist[index];
  if (!session) {
    showToast('Pošiljka ni najdena v arhivu.');
    return;
  }
  showToast(`Pripravljam PDF za arhivsko pošiljko "${session.name}"...`);
  exportReceivingPDF(session);
};

window.deleteHistoricalReceivingSession = function(index) {
  const historyKey = 'skladisce_receiving_history';
  const hist = JSON.parse(localStorage.getItem(historyKey) || '[]');
  const session = hist[index];
  if (!session) return;

  if (confirm(`Ali res želite izbrisati arhivski zapis prevzema "${session.name}"?`)) {
    hist.splice(index, 1);
    localStorage.setItem(historyKey, JSON.stringify(hist));
    renderReceivingArchiveList();
    showToast('Zapis izbrisan iz arhiva.');
  }
};

/* =========================================================================
   5. OPTIČNI ČITALNIK ŠKATEL (OCR)
   ========================================================================= */
let ocrWorker = null;
let ocrWorkerPromise = null;
let currentScannedBox = null;
let currentMultiplier = 1;

// Nastavitve za samodejno branje v realnem času
let isAutoScanEnabled = true;
let isScanLoopRunning = false;
let isProcessingFrame = false;
let lastDetectedSKU = null;
let lastDetectedTime = 0;
let autoScanAngleCycle = 0; // Izmenično 0° in 180° za narobe obrnjene škatle

// Strojni TextDetector
let nativeTextDetector = null;
if (typeof window !== 'undefined' && 'TextDetector' in window) {
  try {
    nativeTextDetector = new window.TextDetector();
  } catch (e) {
    console.warn('TextDetector ni bilo mogoče inicializirati:', e);
  }
}

/**
 * Predhodno nalaganje lokalnega OCR modela
 */
async function initOCRWorker() {
  if (ocrWorkerPromise) return ocrWorkerPromise;

  ocrWorkerPromise = (async () => {
    try {
      if (typeof Tesseract === 'undefined') {
        console.warn('Tesseract knjižnica še ni na voljo.');
        return null;
      }

      const worker = await Tesseract.createWorker('eng', 1, {
        workerPath: './worker.min.js',
        corePath: './tesseract-core-simd-lstm.wasm.js',
        langPath: './',
        gzip: true,
        logger: (m) => {
          if (m.status === 'recognizing text') {
            const pct = Math.round((m.progress || 0) * 100);
            const textEl = document.getElementById('ocrLoadingText');
            if (textEl) textEl.textContent = `Obdelava slike: ${pct}%`;
          }
        }
      });

      await worker.setParameters({
        tessedit_pageseg_mode: '6', // SINGLE_BLOCK (območje vizirja)
        load_system_dawg: '0',
        load_freq_dawg: '0',
        load_unambig_dawg: '0',
        load_punc_dawg: '0',
        load_number_dawg: '0',
        load_bigram_dawg: '0',
        bidi_debug: '0',
        tessedit_enable_doc_dict: '0',
        tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz/:.-xX,()# '
      });

      ocrWorker = worker;
      return worker;
    } catch (err) {
      console.warn('Inicializacija OCR modela:', err);
      return null;
    }
  })();

  return ocrWorkerPromise;
}

/**
 * Zvočni pisk ob uspešnem zaznavanju škatle
 */
function playSuccessBeep() {
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1750, audioCtx.currentTime);
    osc.frequency.setValueAtTime(2400, audioCtx.currentTime + 0.05);
    gain.gain.setValueAtTime(0.25, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.12);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.13);
  } catch (e) {
    // AudioContext blocked or not supported
  }
}

/**
 * Vizualni utrip vizirja ob prepoznavi škatle
 */
function triggerDetectionFlash() {
  const frame = document.getElementById('scanFrameBox');
  const label = document.getElementById('frameLabelText');
  if (frame) {
    frame.classList.add('detected');
    if (label) label.textContent = 'Prepoznano';
    setTimeout(() => {
      frame.classList.remove('detected');
      if (label) label.textContent = 'Usmeri kamero v etiketo';
    }, 1500);
  }
}

/**
 * Obračanje platna za zaznavo narobe obrnjenih (180°) in ležečih (90°) škatel
 */
function rotateCanvas(sourceCanvas, degrees) {
  const rotated = document.createElement('canvas');
  const ctx = rotated.getContext('2d', { willReadFrequently: true });
  if (degrees === 180) {
    rotated.width = sourceCanvas.width;
    rotated.height = sourceCanvas.height;
    ctx.translate(sourceCanvas.width, sourceCanvas.height);
    ctx.rotate(Math.PI);
    ctx.drawImage(sourceCanvas, 0, 0);
  } else if (degrees === 90) {
    rotated.width = sourceCanvas.height;
    rotated.height = sourceCanvas.width;
    ctx.translate(sourceCanvas.height, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(sourceCanvas, 0, 0);
  } else if (degrees === 270) {
    rotated.width = sourceCanvas.height;
    rotated.height = sourceCanvas.width;
    ctx.translate(0, sourceCanvas.width);
    ctx.rotate((3 * Math.PI) / 2);
    ctx.drawImage(sourceCanvas, 0, 0);
  } else {
    rotated.width = sourceCanvas.width;
    rotated.height = sourceCanvas.height;
    ctx.drawImage(sourceCanvas, 0, 0);
  }
  return rotated;
}

function isCapacitorNative() {
  return typeof window !== 'undefined' &&
         window.Capacitor &&
         typeof window.Capacitor.isNativePlatform === 'function' &&
         window.Capacitor.isNativePlatform();
}

async function triggerNativeMLKitScan() {
  try {
    const plugins = window.Capacitor?.Plugins;
    if (!plugins || !plugins.Camera || !plugins.TextRecognition) {
      showToast('Vtičnik za kamero ni na voljo.');
      return;
    }

    const photo = await plugins.Camera.getPhoto({
      quality: 95,
      allowEditing: false,
      resultType: 'uri',
      source: 'CAMERA'
    });

    if (!photo || !photo.path) return;

    const overlay = document.getElementById('ocrLoadingOverlay');
    const loadingText = document.getElementById('ocrLoadingText');
    if (overlay) overlay.style.display = 'flex';
    if (loadingText) loadingText.textContent = 'Obdelava slike...';

    const result = await plugins.TextRecognition.processImage({
      path: photo.path
    });

    if (overlay) overlay.style.display = 'none';

    const parsed = WarehouseLabelParser.parse(result.text || '');
    playSuccessBeep();
    triggerDetectionFlash();
    await handleBoxScanResult(parsed);

  } catch (err) {
    const overlay = document.getElementById('ocrLoadingOverlay');
    if (overlay) overlay.style.display = 'none';
    if (err && err.message && (err.message.includes('cancel') || err.message.includes('User cancelled'))) {
      return;
    }
    console.error('OCR napaka:', err);
    showToast('Napaka pri branju kamere: ' + (err.message || err));
  }
}

async function triggerNativeMLKitGallery() {
  try {
    const plugins = window.Capacitor?.Plugins;
    if (!plugins || !plugins.Camera || !plugins.TextRecognition) {
      document.getElementById('ocrFileInput').click();
      return;
    }

    const photo = await plugins.Camera.getPhoto({
      quality: 95,
      allowEditing: false,
      resultType: 'uri',
      source: 'PHOTOS'
    });

    if (!photo || !photo.path) return;

    const overlay = document.getElementById('ocrLoadingOverlay');
    const loadingText = document.getElementById('ocrLoadingText');
    if (overlay) overlay.style.display = 'flex';
    if (loadingText) loadingText.textContent = 'Obdelava slike...';

    const result = await plugins.TextRecognition.processImage({
      path: photo.path
    });

    if (overlay) overlay.style.display = 'none';

    const parsed = WarehouseLabelParser.parse(result.text || '');
    playSuccessBeep();
    triggerDetectionFlash();
    await handleBoxScanResult(parsed);

  } catch (err) {
    const overlay = document.getElementById('ocrLoadingOverlay');
    if (overlay) overlay.style.display = 'none';
  }
}

function setupBoxOCRScanner() {
  const btnCapture = document.getElementById('btnCaptureOCR');
  const btnToggle = document.getElementById('btnToggleCamera');
  const btnPhoto = document.getElementById('btnTriggerCameraPhoto');
  const fileInput = document.getElementById('ocrFileInput');
  const btnManual = document.getElementById('btnManualScan');
  const manualInput = document.getElementById('manualScanInput');
  const btnToggleAuto = document.getElementById('btnToggleAutoScan');
  const autoText = document.getElementById('autoScanStatusText');

  const isNative = isCapacitorNative();
  if (isNative) {
    btnCapture.textContent = 'Zajemi fotografijo';
    btnCapture.style.background = 'linear-gradient(135deg, #10b981, #059669)';
    btnCapture.style.color = '#fff';
    btnCapture.style.borderColor = '#10b981';
    btnCapture.style.fontSize = '0.95rem';
    btnCapture.style.fontWeight = '700';
    btnCapture.style.padding = '12px';
    btnCapture.addEventListener('click', triggerNativeMLKitScan);
    btnPhoto.addEventListener('click', triggerNativeMLKitGallery);

    const scanFrame = document.getElementById('scanFrameBox');
    if (scanFrame) {
      scanFrame.style.cursor = 'pointer';
      scanFrame.title = 'Klikni za zajem s kamero';
      scanFrame.addEventListener('click', triggerNativeMLKitScan);
    }
  } else {
    // Spletni način (PWA v brskalniku)
    btnCapture.addEventListener('click', async () => {
      const video = document.getElementById('cameraVideo');
      if (!cameraStream || video.readyState < video.HAVE_CURRENT_DATA) {
        showToast('Kamera se še zaganja...');
        await startCamera();
        return;
      }

      const { canvas } = getCroppedCanvasFromVideo(video, 1000);
      await processImageWithOCR(canvas);
    });

    btnPhoto.addEventListener('click', () => {
      fileInput.click();
    });
  }

  // Preklop samodejnega branja (ON / OFF)
  if (btnToggleAuto) {
    btnToggleAuto.addEventListener('click', () => {
      isAutoScanEnabled = !isAutoScanEnabled;
      if (isAutoScanEnabled) {
        btnToggleAuto.classList.remove('disabled');
        btnToggleAuto.classList.add('active');
        if (autoText) autoText.textContent = 'SAMODEJNO BRANJE: VKLOP';
        showToast('Samodejno branje vklopljeno');
      } else {
        btnToggleAuto.classList.remove('active');
        btnToggleAuto.classList.add('disabled');
        if (autoText) autoText.textContent = 'SAMODEJNO BRANJE: PAVZA';
        showToast('Samodejno branje začasno ustavljeno');
      }
    });
  }

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const img = new Image();
    img.onload = async () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      // Visoka ločljivost do 1400px za natančno prepoznavo malih podrobnosti
      const scale = Math.min(1, 1400 / img.width);
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      preprocessAndCheckContrast(canvas, ctx);

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

  // Gumbi za pomoč pri izdaji po računu
  const btnReceiptTrigger = document.getElementById('btnReceiptDispatchTrigger');
  if (btnReceiptTrigger) {
    btnReceiptTrigger.addEventListener('click', showReceiptDispatchPicker);
  }

  const btnQuickDispatch = document.getElementById('btnQuickDispatch');
  if (btnQuickDispatch) {
    btnQuickDispatch.addEventListener('click', showReceiptDispatchPicker);
  }

  const btnCloseDispatch = document.getElementById('btnCloseReceiptDispatch');
  if (btnCloseDispatch) {
    btnCloseDispatch.addEventListener('click', closeReceiptDispatchModal);
  }

  const btnCancelDispatch = document.getElementById('btnCancelDispatch');
  if (btnCancelDispatch) {
    btnCancelDispatch.addEventListener('click', closeReceiptDispatchModal);
  }

  const btnFinishDispatch = document.getElementById('btnFinishDispatch');
  if (btnFinishDispatch) {
    btnFinishDispatch.addEventListener('click', finishReceiptDispatch);
  }

  const receiptFileInput = document.getElementById('receiptFileInput');
  if (receiptFileInput) {
    receiptFileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const img = new Image();
      img.onload = async () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const scale = Math.min(1, 1400 / img.width);
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        preprocessAndCheckContrast(canvas, ctx);

        await processImageWithOCR(canvas);
      };
      img.src = URL.createObjectURL(file);
      receiptFileInput.value = '';
    });
  }
}

/**
 * Zagon in ustavitev zanke samodejnega prepoznavanja
 */
function startAutoScanLoop() {
  if (isScanLoopRunning) return;
  isScanLoopRunning = true;
  runAutoScanTick();
}

function stopAutoScanLoop() {
  isScanLoopRunning = false;
}

/**
 * Ena ponovitev v zanki samodejnega branja
 */
async function runAutoScanTick() {
  if (!isScanLoopRunning) return;

  const video = document.getElementById('cameraVideo');
  const resultCard = document.getElementById('scanResultCard');
  const scannerTab = document.getElementById('tab-scanner');

  const isScannerVisible = scannerTab && scannerTab.style.display !== 'none';
  const isVideoReady = video && video.readyState >= 2 && !video.paused;
  const isResultOpen = resultCard && resultCard.style.display === 'flex';

  if (isAutoScanEnabled && isScannerVisible && isVideoReady && !isResultOpen && !isProcessingFrame) {
    const now = performance.now();
    // 1.2s premor po prepoznavi
    if (now - lastDetectedTime > 1200) {
      await processAutoScanFrame(video);
    }
  }

  // Preveri naslednji frame
  if (isScanLoopRunning) {
    setTimeout(runAutoScanTick, 150);
  }
}

/**
 * Analiza sličice v realnem času
 */
async function processAutoScanFrame(video) {
  if (isProcessingFrame) return;
  isProcessingFrame = true;

  let parsed = null;
  window.parsed = null;

  const liveBadge = document.getElementById('scanLiveIndicator');

  try {
    // 1. Zajemimo sličico z visoko ločljivostjo (1000px za nič napak)
    const { canvas: frameCanvas, hasContent } = getCroppedCanvasFromVideo(video, 1000);

    // Če ni dovolj kontrasta (premikanje telefona, prazna tla ali lepenka brez črk), takoj preskoči!
    if (!hasContent) {
      isProcessingFrame = false;
      return;
    }

    if (liveBadge) liveBadge.classList.add('analyzing');

    // 2. Izmenično testiramo 0° in 180° (nikoli obeh v isti sličici!)
    let canvasToTest = frameCanvas;
    if (autoScanAngleCycle === 1) {
      canvasToTest = rotateCanvas(frameCanvas, 180);
    }
    autoScanAngleCycle = (autoScanAngleCycle + 1) % 2;

    // A. Če tečemo v Capacitor nativni Android aplikaciji: uporabi Google ML Kit (15-20ms!)
    if (isCapacitorNative() && window.Capacitor?.Plugins?.MLKitDirect) {
      try {
        const base64 = canvasToTest.toDataURL('image/jpeg', 0.82);
        const res = await window.Capacitor.Plugins.MLKitDirect.recognizeBase64({ base64 });
        if (res && res.text) {
          const p = WarehouseLabelParser.parse(res.text);
          if (p && p.articleNumber) {
            parsed = p;
          }
        }
      } catch (e) {
        console.warn('MLKitDirect auto-scan napaka:', e);
      }
    }

    // B. Strojni TextDetector v brskalniku
    if (!parsed && nativeTextDetector) {
      try {
        const blocks = await nativeTextDetector.detect(canvasToTest);
        if (blocks && blocks.length > 0) {
          const fullText = blocks.map(b => b.rawValue).join('\n');
          const p = WarehouseLabelParser.parse(fullText);
          if (p && p.articleNumber) {
            parsed = p;
          }
        }
      } catch (e) {}
    }

    // C. Lokalni WASM-SIMD model (zagnan samo v brskalniku, ko ni native aplikacije)
    if (!parsed && !isCapacitorNative()) {
      let worker = ocrWorker;
      if (!worker) {
        worker = await initOCRWorker();
      }
      if (worker) {
        const ret = await worker.recognize(canvasToTest, {}, { text: true, blocks: false, hocr: false, tsv: false });
        const text = ret?.data?.text || '';
        parsed = WarehouseLabelParser.parse(text);
      }
    }

    // 3. Če je artikel najden, sproži prepoznavo!
    if (parsed && parsed.articleNumber) {
      const now = performance.now();
      // Prepreči takojšnje podvajanje iste škatle (za isti SKU 5s premor, za nov artikel pa takoj!)
      if (parsed.articleNumber === lastDetectedSKU && (now - lastDetectedTime) < 5000) {
        isProcessingFrame = false;
        return;
      }

      lastDetectedSKU = parsed.articleNumber;
      lastDetectedTime = now;

      // Zvočni in haptični signal
      playSuccessBeep();
      triggerDetectionFlash();

      // Prikaz kartice za potrditev
      await handleBoxScanResult(parsed);
    }

  } catch (err) {
    console.debug('Napaka pri analizi sličice:', err);
  } finally {
    isProcessingFrame = false;
    if (liveBadge) liveBadge.classList.remove('analyzing');
  }
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

    video.onloadedmetadata = () => {
      video.play().catch(() => {});
      startAutoScanLoop();
    };
  } catch (err) {
    console.warn('Kamere ni bilo mogoče zagnati:', err);
    showToast('Dostop do kamere ni na voljo. Uporabite gumb za fotografijo spodaj.');
  }
}

function stopCamera() {
  stopAutoScanLoop();
  if (cameraStream) {
    cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
    const video = document.getElementById('cameraVideo');
    if (video) video.srcObject = null;
  }
}

/**
 * Izreže območje vizirja za škatlo (cca 72% širine, 44% višine)
 * In ohrani visoko ločljivost (1000px) za popolno ostrino malih napisov (Box 1/1, 2 pcs ipd.)
 */
function getCroppedCanvasFromVideo(video, targetWidth = 1000) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const vw = video.videoWidth || 1920;
  const vh = video.videoHeight || 1080;

  const cropW = Math.round(vw * 0.72);
  const cropH = Math.round(vh * 0.44);
  const cropX = Math.round((vw - cropW) / 2);
  const cropY = Math.round((vh - cropH) / 2);

  // Visoka ločljivost do 1000px za jasnost
  const targetW = Math.min(cropW, targetWidth);
  const scale = targetW / cropW;
  const targetH = Math.round(cropH * scale);

  canvas.width = targetW;
  canvas.height = targetH;
  ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, targetW, targetH);

  const hasContent = preprocessAndCheckContrast(canvas, ctx);

  return { canvas, hasContent };
}

/**
 * Zvezna izravnava svetlosti (Auto-Levels) z ohranjanjem zglajenih robov:
 * - V 0.2ms preveri, ali je v kadru besedilo
 * - Raztegne kontrast in poudari temen tisk proti lepenki brez uničenja oblike znakov!
 */
function preprocessAndCheckContrast(canvas, ctx) {
  try {
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = imgData.data;

    let minLum = 255;
    let maxLum = 0;

    for (let i = 0; i < d.length; i += 16) {
      const gray = d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114;
      if (gray < minLum) minLum = gray;
      if (gray > maxLum) maxLum = gray;
    }

    const contrast = maxLum - minLum;
    // Če je kontrast premajhen (enoličen prazen karton ali tema), preskoči OCR
    if (contrast < 35) {
      return false;
    }

    const range = contrast || 1;

    // Zvezna izravnava svetlobnih nivojev (Auto-Levels)
    for (let i = 0; i < d.length; i += 4) {
      const gray = d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114;
      const normalized = Math.min(255, Math.max(0, ((gray - minLum) / range) * 255));
      
      // Rahlo nelinearno poudarjanje temnega tiska (črnila) proti ozadju kartona
      const enhanced = (normalized < 130)
        ? Math.pow(normalized / 130, 1.2) * 130
        : normalized;

      d[i] = enhanced;
      d[i+1] = enhanced;
      d[i+2] = enhanced;
    }

    ctx.putImageData(imgData, 0, 0);
    return true;
  } catch (e) {
    return true;
  }
}

/**
 * Ročna funkcija za zagon OCR in razčlenitev podatkov o škatli
 */
async function processImageWithOCR(canvas) {
  const overlay = document.getElementById('ocrLoadingOverlay');
  const loadingText = document.getElementById('ocrLoadingText');
  overlay.style.display = 'flex';
  loadingText.textContent = 'Obdelava slike...';

  try {
    let parsed = null;

    // A. Če tečemo v Capacitor z native OCR
    if (isCapacitorNative() && window.Capacitor?.Plugins?.MLKitDirect) {
      try {
        loadingText.textContent = 'Obdelava slike...';
        const base64 = canvas.toDataURL('image/jpeg', 0.90);
        const res = await window.Capacitor.Plugins.MLKitDirect.recognizeBase64({ base64 });
        if (res && res.text) {
          parsed = WarehouseLabelParser.parse(res.text);
        }
        if (!parsed || (!parsed.articleNumber && !parsed.isReceipt)) {
          const rot180 = rotateCanvas(canvas, 180);
          const base64_180 = rot180.toDataURL('image/jpeg', 0.90);
          const res180 = await window.Capacitor.Plugins.MLKitDirect.recognizeBase64({ base64: base64_180 });
          if (res180 && res180.text) {
            const p180 = WarehouseLabelParser.parse(res180.text);
            if (p180 && (p180.articleNumber || p180.isReceipt)) {
              parsed = p180;
            }
          }
        }
      } catch (e) {
        console.warn('MLKitDirect napaka:', e);
      }
    }

    // B. Poskusi s strojnim TextDetector v brskalniku
    if (!parsed && nativeTextDetector) {
      try {
        const blocks = await nativeTextDetector.detect(canvas);
        if (blocks && blocks.length > 0) {
          const fullText = blocks.map(b => b.rawValue).join('\n');
          const p = WarehouseLabelParser.parse(fullText);
          if (p && (p.articleNumber || p.isReceipt)) {
            parsed = p;
          }
        }
      } catch (e) {}
    }

    // C. Poskusi z lokalnim OCR modelom
    if (!parsed) {
      let worker = ocrWorker;
      if (!worker) {
        loadingText.textContent = 'Priprava čitalnika...';
        worker = await initOCRWorker();
      }

      if (!worker) {
        throw new Error('OCR model ni na voljo.');
      }

      const ret = await worker.recognize(canvas, {}, { text: true, blocks: false, hocr: false, tsv: false });
      parsed = WarehouseLabelParser.parse(ret.data.text || '');

      // Če ne najde šifre ali računa na 0°, preveri še 180°
      if (!parsed.articleNumber && !parsed.isReceipt) {
        loadingText.textContent = 'Preverjanje obrnjene slike...';
        const rotated180 = rotateCanvas(canvas, 180);
        const ret180 = await worker.recognize(rotated180, {}, { text: true, blocks: false, hocr: false, tsv: false });
        const parsed180 = WarehouseLabelParser.parse(ret180.data.text || '');
        if (parsed180.articleNumber || parsed180.isReceipt) {
          parsed = parsed180;
        }
      }
    }

    playSuccessBeep();
    triggerDetectionFlash();
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

  // 1. Če je prepoznan račun kupca, zaženi asistenta za vodenje po regalih
  if (parsed && parsed.isReceipt) {
    await openReceiptDispatchModal(parsed);
    return;
  }

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

/* =========================================================================
   POMOČ PRI IZDAJI BLAGA PO RAČUNU (VODENJE PO REGALIH)
   ========================================================================= */

let currentDispatchData = null;
let currentDispatchItems = [];

window.showReceiptDispatchPicker = async function showReceiptDispatchPicker() {
  if (DB.ensureReceiptDemoItems) {
    await DB.ensureReceiptDemoItems();
  }

  const sampleReceiptData = {
    isReceipt: true,
    receiptNo: '0519-101-264866',
    receiptDate: '09.10.26 11:04',
    barcode: '00105190910261010370',
    items: [
      { sku: '3618930', name: 'Predalnik LIMFJORDEN 4 predali bela', qty: 1, price: '95.00' },
      { sku: '3670619', name: 'DIVERSES', qty: 1, price: '315.00' }
    ]
  };

  if (isCapacitorNative()) {
    const choice = confirm("Želite poskenirati račun kupca s kamero?\n\n[V redu (OK)] = Slikaj račun s kamero\n[Prekliči (Cancel)] = Naloži sliko iz galerije ali uporabi vzorčni račun");
    if (choice) {
      await triggerNativeMLKitScan();
    } else {
      const useSample = confirm("Želite odpreti vzorčni račun JYSK (LIMFJORDEN + DIVERSES)?\n\n[V redu (OK)] = Odpri vzorčni račun\n[Prekliči (Cancel)] = Odpri galerijo slik");
      if (useSample) {
        await openReceiptDispatchModal(sampleReceiptData);
      } else {
        await triggerNativeMLKitGallery();
      }
    }
  } else {
    const useSample = confirm("Odprem pomoč pri izdaji z vzorčnim računom JYSK (Predalnik LIMFJORDEN + DIVERSES)?\n\n[V redu (OK)] = Takojšnji preizkus z vzorčnim računom\n[Prekliči (Cancel)] = Naloži svojo sliko računa");
    if (useSample) {
      await openReceiptDispatchModal(sampleReceiptData);
    } else {
      const fi = document.getElementById('receiptFileInput') || document.getElementById('ocrFileInput');
      if (fi) fi.click();
    }
  }
}

async function openReceiptDispatchModal(receiptData) {
  if (DB.ensureReceiptDemoItems) {
    await DB.ensureReceiptDemoItems();
  }

  currentDispatchData = receiptData;
  const modal = document.getElementById('modalReceiptDispatch');
  if (!modal) return;

  const receiptNoEl = document.getElementById('dispatchReceiptNo');
  const receiptDateEl = document.getElementById('dispatchReceiptDate');
  const barcodeRow = document.getElementById('dispatchBarcodeRow');
  const barcodeEl = document.getElementById('dispatchReceiptBarcode');

  if (receiptNoEl) receiptNoEl.textContent = receiptData.receiptNo || 'Račun kupca';
  if (receiptDateEl) receiptDateEl.textContent = receiptData.receiptDate || new Date().toLocaleDateString('sl-SI');
  if (barcodeRow && barcodeEl) {
    if (receiptData.barcode) {
      barcodeRow.style.display = 'block';
      barcodeEl.textContent = receiptData.barcode;
    } else {
      barcodeRow.style.display = 'none';
    }
  }

  currentDispatchItems = [];
  const rawItems = receiptData.items || [];

  for (let i = 0; i < rawItems.length; i++) {
    const rawIt = rawItems[i];
    const dbItem = await DB.getItemBySKU(rawIt.sku);
    currentDispatchItems.push({
      index: i,
      sku: rawIt.sku,
      name: (dbItem && dbItem.name) ? dbItem.name : rawIt.name,
      orderedQty: Number(rawIt.qty) || 1,
      price: rawIt.price || '',
      dbItem: dbItem,
      isPicked: false
    });
  }

  renderDispatchRouteList();
  updateDispatchProgress();

  modal.classList.add('active');
  modal.style.display = 'flex';
  playSuccessBeep();
}

function renderDispatchRouteList() {
  const container = document.getElementById('dispatchRouteBody');
  if (!container) return;

  if (currentDispatchItems.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 24px; color: var(--text-muted);">
        Na računu ni bilo zaznanih artiklov za izdajo.
      </div>
    `;
    return;
  }

  let html = '';

  currentDispatchItems.forEach((item, idx) => {
    const dbIt = item.dbItem;
    const isPicked = item.isPicked;

    let shelfBadges = '';
    let multiBoxSection = '';
    let stockSummary = '';

    if (dbIt) {
      const stats = DB.getBoxStats(dbIt);
      const boxTotal = stats.boxTotal;

      if (boxTotal > 1) {
        const badgeList = [];
        stats.breakdown.forEach(b => {
          const locs = b.locations || [{ name: b.location, count: b.count, isPrimary: true }];
          const activeLoc = locs.find(l => l.count > 0) || locs[0];
          const hasMultiple = locs.length > 1;

          if (hasMultiple) {
            locs.forEach(l => {
              if (l.count > 0) {
                const isTarget = (l === activeLoc);
                badgeList.push(`
                  <div class="dispatch-shelf-pill ${isTarget ? 'highlight' : ''}" style="${!isTarget ? 'border: 1.5px dashed #f59e0b; background: rgba(245, 158, 11, 0.08);' : ''}">
                    <span>Šk.${b.boxNum}: ${escapeHtml(l.name)}</span>
                    <span style="font-size:0.75rem; opacity:0.9; margin-left:4px;">(${l.count} kos)</span>
                  </div>
                `);
              } else {
                badgeList.push(`
                  <div class="dispatch-shelf-pill" style="border-color: #ef4444; color: #f87171; background: rgba(239, 68, 68, 0.1);">
                    <span>Šk.${b.boxNum}: ${escapeHtml(l.name)} (prazno)</span>
                  </div>
                `);
              }
            });
          } else {
            badgeList.push(`
              <div class="dispatch-shelf-pill highlight">
                <span>Šk.${b.boxNum}: ${escapeHtml(activeLoc.name)}</span>
              </div>
            `);
          }
        });

        shelfBadges = badgeList.join(' ');

        multiBoxSection = `
          <div class="dispatch-multibox-box">
            <div style="font-size: 0.78rem; font-weight: 700; color: #fbbf24;">
              Artikel sestavljata ${boxTotal} škatli:
            </div>
            ${stats.breakdown.map(b => {
              const locs = b.locations || [{ name: b.location, count: b.count, isPrimary: true }];
              const activeLoc = locs.find(l => l.count > 0) || locs[0];

              return `
                <div class="dispatch-box-row" style="flex-direction: column; align-items: stretch; gap: 4px; padding: 6px 8px;">
                  <div style="display:flex; justify-content:space-between; align-items:center;">
                    <div class="dispatch-box-name">
                      Škatla ${b.boxNum}/${boxTotal}
                    </div>
                    <div class="dispatch-box-stock">
                      (Skupaj zaloga: <strong>${b.count}</strong> kos)
                    </div>
                  </div>
                  
                  <div style="display:flex; flex-direction:column; gap:4px; margin-top:2px;">
                    ${locs.map(l => {
                      const isTarget = (l === activeLoc && l.count > 0);
                      const isZero = (l.count === 0);
                      return `
                        <div style="display:flex; justify-content:space-between; align-items:center; font-size:0.8rem; background:${isTarget ? 'rgba(245, 158, 11, 0.12)' : (isZero ? 'rgba(239, 68, 68, 0.08)' : 'rgba(255,255,255,0.03)')}; padding:4px 8px; border-radius:4px; border:1px solid ${isTarget ? 'rgba(245, 158, 11, 0.35)' : 'transparent'};">
                          <div>
                            <span style="font-weight:700; color:${isTarget ? '#fbbf24' : (isZero ? '#ef4444' : '#cbd5e1')};">
                              ${isZero ? 'Prazen regal:' : (isTarget ? 'Glavni regal:' : 'Preliv / rezerva:')}
                            </span>
                            <span style="color:#fff; margin-left:4px; font-weight:600;">${escapeHtml(l.name)}</span>
                          </div>
                          <span style="font-weight:700; color:${l.count > 0 ? 'var(--primary)' : 'var(--text-dim)'};">${l.count} kos</span>
                        </div>
                      `;
                    }).join('')}
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        `;

        stockSummary = `
          <div style="font-size: 0.8rem; color: var(--text-muted); display: flex; justify-content: space-between; align-items:center;">
            <span>Celotnih kompletov na zalogi:</span>
            <strong style="color: ${stats.completeSets >= item.orderedQty ? 'var(--success)' : 'var(--warning)'}; font-size: 0.95rem;">
              ${stats.completeSets} garnitur
            </strong>
          </div>
        `;
      } else {
        const singleLocs = dbIt.boxes?.[1]?.locations || [{ name: dbIt.location || 'Regal D-01', count: dbIt.quantity, isPrimary: true }];
        const activeLoc = singleLocs.find(l => l.count > 0) || singleLocs[0];

        shelfBadges = singleLocs.map(l => `
          <div class="dispatch-shelf-pill ${l === activeLoc ? 'highlight' : ''}" style="${l !== activeLoc ? 'border: 1.5px dashed #f59e0b; background: rgba(245, 158, 11, 0.08);' : ''}">
            <span>${escapeHtml(l.name)}</span>
            <span style="font-size:0.75rem; opacity:0.9; margin-left:4px;">(${l.count} kos)</span>
          </div>
        `).join(' ');

        stockSummary = `
          <div style="font-size: 0.8rem; color: var(--text-muted); display: flex; justify-content: space-between; align-items:center;">
            <span>Zaloga na regalu:</span>
            <strong style="color: ${dbIt.quantity >= item.orderedQty ? 'var(--success)' : 'var(--warning)'}; font-size: 0.95rem;">
              ${dbIt.quantity} ${dbIt.unit || 'kos'}
            </strong>
          </div>
        `;
      }
    } else {
      shelfBadges = `
        <div class="dispatch-shelf-pill" style="border-color: #ef4444; color: #f87171; background: rgba(239, 68, 68, 0.15);">
          <span>REGAL NEZNAN (Ni v evidenci)</span>
        </div>
      `;

      stockSummary = `
        <div style="font-size: 0.8rem; color: var(--warning); background: rgba(245, 158, 11, 0.1); padding: 6px 10px; border-radius: var(--radius-sm);">
          Artikel še ni v sistemu zalog skladišča.
        </div>
      `;
    }

    const cardClass = isPicked ? 'dispatch-card picked-step' : (idx === 0 || currentDispatchItems[idx - 1]?.isPicked ? 'dispatch-card active-step' : 'dispatch-card');
    const badgeStatus = isPicked 
      ? '<span class="dispatch-step-badge done">PREVZETO</span>'
      : '<span class="dispatch-step-badge pending">ČAKA PREVZEM</span>';

    html += `
      <div class="${cardClass}" id="dispatchCard_${idx}">
        <div class="dispatch-card-top">
          <div style="display: flex; flex-wrap: wrap; gap: 6px; align-items: center;">
            ${shelfBadges}
          </div>
          <div>${badgeStatus}</div>
        </div>

        <div style="display: flex; flex-direction: column; gap: 3px;">
          <div class="dispatch-item-title">${escapeHtml(item.name)}</div>
          <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
            <span class="dispatch-sku-pill">Šifra: ${escapeHtml(item.sku)}</span>
            <span style="font-size: 0.82rem; color: var(--text-muted);">Naročeno: <strong style="color: #fff;">${item.orderedQty}x</strong></span>
            ${item.price ? `<span style="font-size: 0.8rem; color: var(--primary);">(${item.price} €)</span>` : ''}
          </div>
        </div>

        ${multiBoxSection}
        ${stockSummary}

        <div style="margin-top: 4px;">
          ${isPicked ? `
            <button type="button" class="btn-pick-confirm" disabled style="background: rgba(16, 185, 129, 0.2); color: #10b981; border-color: rgba(16, 185, 129, 0.4); cursor: default;">
              Pobrano iz regala
            </button>
          ` : `
            <button type="button" class="btn-pick-confirm" onclick="confirmDispatchPick(${idx})">
              Potrdi prevzem (${item.orderedQty}x)
            </button>
          `}
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

window.confirmDispatchPick = async function(index) {
  const item = currentDispatchItems[index];
  if (!item || item.isPicked) return;

  const receiptNo = currentDispatchData?.receiptNo || 'račun';
  const note = `Izdaja po računu ${receiptNo}`;

  try {
    if (item.dbItem) {
      if (item.dbItem.boxTotal > 1) {
        await DB.issueCompleteItem(item.dbItem.id, item.orderedQty, note);
      } else {
        await DB.adjustStock(item.dbItem.id, -item.orderedQty, note, 'out');
      }
      item.dbItem = await DB.getItemById(item.dbItem.id);
    }

    item.isPicked = true;
    if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
    playSuccessBeep();
    showToast(`Prevzeto: ${item.name}`);

    renderDispatchRouteList();
    updateDispatchProgress();

    const nextIdx = currentDispatchItems.findIndex(it => !it.isPicked);
    if (nextIdx !== -1) {
      const nextEl = document.getElementById(`dispatchCard_${nextIdx}`);
      if (nextEl) {
        nextEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  } catch (err) {
    console.error('Napaka pri potrditvi prevzema:', err);
    showToast('Napaka pri posodobitvi zaloge: ' + err.message);
  }
};

function updateDispatchProgress() {
  const total = currentDispatchItems.length;
  const picked = currentDispatchItems.filter(it => it.isPicked).length;
  const percent = total > 0 ? Math.round((picked / total) * 100) : 0;

  const countEl = document.getElementById('dispatchProgressCount');
  const percentEl = document.getElementById('dispatchProgressPercent');
  const barEl = document.getElementById('dispatchProgressBar');
  const btnFinish = document.getElementById('btnFinishDispatch');

  if (countEl) countEl.textContent = `Prevzeto ${picked} / ${total} artiklov`;
  if (percentEl) percentEl.textContent = `${percent}%`;
  if (barEl) barEl.style.width = `${percent}%`;

  if (btnFinish) {
    if (picked === total && total > 0) {
      btnFinish.disabled = false;
      btnFinish.innerHTML = 'Zaključi izdajo';
    } else {
      btnFinish.disabled = (picked === 0);
      btnFinish.innerHTML = `Zaključi delno izdajo (${picked}/${total})`;
    }
  }
}

window.closeReceiptDispatchModal = function() {
  const modal = document.getElementById('modalReceiptDispatch');
  if (modal) {
    modal.classList.remove('active');
    modal.style.display = 'none';
  }
};

async function finishReceiptDispatch() {
  closeReceiptDispatchModal();

  const receiptNo = currentDispatchData?.receiptNo || '';
  showToast(`Izdaja po računu ${receiptNo} je zaključena.`);
  playSuccessBeep();

  await refreshInventory();
  await loadLogs();
}

window.closeBoxResultCard = function() {
  const resultCard = document.getElementById('scanResultCard');
  if (resultCard) resultCard.style.display = 'none';
  if (currentScannedBox && currentScannedBox.articleNumber) {
    lastDetectedSKU = currentScannedBox.articleNumber;
  }
  currentScannedBox = null;
  window.parsed = null;
  lastDetectedTime = performance.now();
};

function renderBoxResultCard(existingItem) {
  const resultCard = document.getElementById('scanResultCard');
  const parsed = currentScannedBox;
  if (!parsed) return;

  const sku = parsed.articleNumber || 'Ni zaznana';
  const name = (existingItem && existingItem.name) ? existingItem.name : (parsed.name || 'Neznan artikel');
  const boxNum = parsed.boxCurrent || 1;
  const boxTotal = Math.max(1, parsed.boxTotal || (existingItem ? existingItem.boxTotal : 1));
  const boxInfo = `Box ${boxNum}/${boxTotal}`;

  let currentBoxLoc = (existingItem && existingItem.boxes && existingItem.boxes[boxNum]) 
    ? existingItem.boxes[boxNum].location 
    : (existingItem ? existingItem.location : '');

  // 1. PAMETNO USMERJANJE NA ISTI REGAL:
  let smartShelfHintHtml = '';
  let suggestedShelf = '';
  let suggestedReason = '';

  if (existingItem && boxTotal > 1) {
    const otherBoxLocations = [];
    if (existingItem.boxes) {
      for (let b = 1; b <= boxTotal; b++) {
        if (b !== boxNum && existingItem.boxes[b]) {
          const bData = existingItem.boxes[b];
          const loc = bData.location || (bData.locations && bData.locations[0]?.name);
          const count = Number(bData.count) || 0;
          if (loc && loc !== 'Prevzemno območje' && loc !== 'Brez lokacije') {
            otherBoxLocations.push({ boxNum: b, location: loc, count });
          }
        }
      }
    }

    if (otherBoxLocations.length > 0) {
      const withStock = otherBoxLocations.find(o => o.count > 0) || otherBoxLocations[0];
      suggestedShelf = withStock.location;
      suggestedReason = `Škatla ${withStock.boxNum}/${boxTotal} je na regalu <strong>${escapeHtml(suggestedShelf)}</strong> (${withStock.count} kos).`;

      smartShelfHintHtml = `
        <div class="smart-shelf-banner" style="background: rgba(16, 185, 129, 0.14); border: 1px solid #10b981; border-radius: var(--radius-sm); padding: 10px 12px; margin: 6px 0; display: flex; align-items: center; justify-content: space-between; gap: 8px;">
          <div style="flex: 1;">
            <div style="font-size: 0.84rem; font-weight: 800; color: #fff;">
              Priporočeni regal: <span style="color: #34d399; font-size: 0.95rem;">${escapeHtml(suggestedShelf)}</span>
            </div>
            <div style="font-size: 0.73rem; color: #d1fae5; margin-top: 2px;">
              ${suggestedReason}
            </div>
          </div>
          <button type="button" class="btn-sm" onclick="applySuggestedShelf('${escapeHtml(suggestedShelf)}')" style="background: #10b981; color: #042f2e; border: none; border-radius: 6px; padding: 7px 11px; font-weight: 800; font-size: 0.78rem; cursor: pointer; white-space: nowrap;">
            Izberi regal
          </button>
        </div>
      `;

      // Če ta škatla še nima določene lokacije ali je v Prevzemnem območju, avtomatsko predlagamo ta regal
      if (!currentBoxLoc || currentBoxLoc === 'Prevzemno območje' || currentBoxLoc === 'Brez lokacije') {
        currentBoxLoc = suggestedShelf;
      }
    }
  }

  let boxBreakdownHtml = '';
  let stockInfoHtml = '';

  if (existingItem) {
    const stats = DB.getBoxStats(existingItem);
    stockInfoHtml = `
      <div style="background: rgba(16, 185, 129, 0.12); border: 1px solid rgba(16, 185, 129, 0.3); border-radius: var(--radius-sm); padding: 8px 12px; font-size: 0.85rem; color: var(--success); display:flex; justify-content:space-between; align-items:center;">
        <span>Zaloga celih kompletov:</span>
        <strong style="font-size: 1.05rem;">${stats.completeSets} ${existingItem.unit || (stats.boxTotal > 1 ? 'garnitur' : 'kos')}</strong>
      </div>
    `;

    if (stats.boxTotal > 1) {
      boxBreakdownHtml = `
        <div class="box-breakdown-container" style="margin-top: 6px;">
          <div style="font-size: 0.72rem; color: var(--text-muted); font-weight: 600; text-transform: uppercase;">
            Stanje vseh škatel tega artikla:
          </div>
          ${stats.breakdown.map(b => `
            <div class="box-breakdown-row" style="${b.boxNum === boxNum ? 'border-color: rgba(56, 189, 248, 0.5); background: rgba(56, 189, 248, 0.1);' : ''}">
              <span>${b.boxNum === boxNum ? '> ' : ''}Škatla ${b.boxNum}/${stats.boxTotal}: <span class="box-breakdown-loc">${escapeHtml(b.location)}</span></span>
              <span class="box-breakdown-count">${b.count} kos</span>
            </div>
          `).join('')}
          <div style="font-size: 0.76rem; margin-top: 2px;">
            ${stats.hasIncomplete 
              ? `<span style="color: var(--warning); font-weight:600;">${escapeHtml(stats.missingSummary)} (celih: ${stats.completeSets})</span>` 
              : `<span style="color: var(--success); font-weight:600;">Vse škatle na voljo (${stats.completeSets} kompletov)</span>`}
          </div>
        </div>
      `;
    }
  } else {
    stockInfoHtml = `
      <div style="background: rgba(245, 158, 11, 0.12); border: 1px solid rgba(245, 158, 11, 0.3); border-radius: var(--radius-sm); padding: 8px 12px; font-size: 0.85rem; color: var(--warning);">
        Artikel s šifro <strong>${escapeHtml(sku)}</strong> še ni vpisan v zalogo.
      </div>
    `;
  }

  resultCard.innerHTML = `
    <div class="box-result-header">
      <div style="display:flex; align-items:baseline; gap: 8px;">
        <span style="font-size: 0.8rem; color: var(--text-muted); font-weight: 600;">ŠIFRA ARTIKLA:</span>
        <span class="box-sku-highlight">${escapeHtml(sku)}</span>
      </div>
      <button type="button" class="btn-card-close" onclick="closeBoxResultCard()" title="Zapri in nadaljuj skeniranje">✕</button>
    </div>

    <div style="display: flex; flex-direction: column; gap: 4px; margin: 4px 0;">
      <div style="display:flex; justify-content: space-between; align-items:center;">
        <span style="font-size: 0.72rem; color: var(--text-muted); text-transform: uppercase; font-weight: 600;">Naziv artikla:</span>
        <span style="font-size: 0.72rem; color: var(--primary);">uredi naziv</span>
      </div>
      <input type="text" id="boxResultNameInput" class="form-control" style="font-size: 1.05rem; font-weight: 700; color: #fff; background: rgba(255,255,255,0.08); border-color: rgba(56, 189, 248, 0.4); padding: 8px 10px;" value="${escapeHtml(name)}">
    </div>

    <div class="box-badges">
      <span class="box-badge highlight">${escapeHtml(boxInfo)}</span>
      ${boxTotal > 1 ? `<span class="box-badge" style="background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3);">Škatla ${boxNum} od ${boxTotal}</span>` : ''}
    </div>

    ${smartShelfHintHtml}

    <!-- Vnos / urejanje lokacije za to posamezno škatlo -->
    <div style="background: rgba(56, 189, 248, 0.08); border: 1px solid rgba(56, 189, 248, 0.25); border-radius: var(--radius-sm); padding: 8px 10px; margin: 4px 0;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 4px;">
        <span style="font-size: 0.74rem; color: var(--primary); font-weight: 700; text-transform: uppercase;">
          Lokacija za Škatlo ${boxNum}/${boxTotal}:
        </span>
        <span style="font-size: 0.7rem; color: var(--text-muted);">regal / polica</span>
      </div>
      <input type="text" id="boxResultLocationInput" class="form-control" style="padding: 7px 10px; font-weight: 600; font-size: 0.95rem; background: rgba(0,0,0,0.35); border-color: rgba(56, 189, 248, 0.4);" placeholder="npr. Regal A-01" value="${escapeHtml(currentBoxLoc || '')}">
    </div>

    ${boxBreakdownHtml}
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
      <button id="btnConfirmReceiveBox" class="btn-primary" onclick="executeBoxStockChange('in')" style="margin-top:0; padding: 12px;">
        PREVZEMI (+${currentMultiplier} škatel)
      </button>
      <button id="btnConfirmIssueBox" class="btn-secondary" onclick="executeBoxStockChange('out')" style="margin-top:0; padding: 12px;">
        IZDAJ (-${currentMultiplier} škatel)
      </button>
    </div>

    ${!existingItem && sku ? `
      <button class="btn-secondary" onclick="openAddFromScannedBox()" style="margin-top: 4px; border-color: var(--primary); color: var(--primary);">
        + Dodaj ta artikel v skladišče
      </button>
    ` : ''}
    <button type="button" class="btn-secondary" onclick="closeBoxResultCard()" style="margin-top: 4px; padding: 10px; font-size: 0.85rem; border-color: rgba(255,255,255,0.15);">
      Zapri in skeniraj naslednjo škatlo
    </button>
  `;
}

window.applySuggestedShelf = function(shelf) {
  const input = document.getElementById('boxResultLocationInput');
  if (input) {
    input.value = shelf;
    showToast(`Izbran priporočeni regal: ${shelf}`);
  }
};

window.setBoxMultiplier = function(m) {
  currentMultiplier = Number(m) || 1;
  const inBtn = document.getElementById('btnConfirmReceiveBox');
  const outBtn = document.getElementById('btnConfirmIssueBox');
  if (inBtn) inBtn.textContent = `PREVZEMI (+${currentMultiplier} škatel)`;
  if (outBtn) outBtn.textContent = `IZDAJ (-${currentMultiplier} škatel)`;

  const btns = document.querySelectorAll('.mult-btn');
  btns.forEach(b => b.classList.remove('active'));
  const activeBtn = Array.from(btns).find(b => b.textContent.trim() === `${m}x`);
  if (activeBtn) activeBtn.classList.add('active');
};

window.executeBoxStockChange = async function(direction) {
  if (!currentScannedBox) return;

  const sku = currentScannedBox.articleNumber;
  const totalAmount = currentMultiplier;
  const chosenName = document.getElementById('boxResultNameInput')?.value?.trim() || currentScannedBox.name || `Artikel ${sku}`;
  const boxLocation = document.getElementById('boxResultLocationInput')?.value?.trim() || '';
  const boxNum = currentScannedBox.boxCurrent || 1;
  const boxTotal = Math.max(1, currentScannedBox.boxTotal || 1);

  let item = await DB.getItemBySKU(sku);

  // Če artikel še ne obstaja, ga avtomatsko ustvari s prepoznanim ali popravljenim imenom
  if (!item) {
    const boxes = {};
    for (let b = 1; b <= boxTotal; b++) {
      boxes[b] = {
        count: (b === boxNum) ? 0 : 0,
        location: (b === boxNum && boxLocation) ? boxLocation : (boxLocation || 'Prevzemno območje')
      };
    }

    const res = await DB.addItem({
      sku: sku || 'ART-' + Math.floor(1000 + Math.random() * 9000),
      name: chosenName,
      quantity: 0,
      minQuantity: 2,
      boxInfo: `Box ${boxNum}/${boxTotal}`,
      boxTotal: boxTotal,
      boxes: boxes,
      unit: (boxTotal > 1) ? 'garnitura' : 'kos',
      category: 'Splošno',
      location: boxLocation || 'Prevzemno območje'
    });
    const newId = (typeof res === 'object' && res.sku) ? res.sku : (res.id || res);
    item = await DB.getItemById(newId);
  } else if (item.name !== chosenName) {
    item.name = chosenName;
    await DB.updateItem(item);
  }

  // Če je prevzem in je aktivna prevzemna pošiljka, zabeleži vnos
  if (direction === 'in') {
    await recordReceivingEntry(item.sku, chosenName, boxNum, boxTotal, boxLocation || 'Glavni regal', totalAmount);
  }

  const note = `${currentMultiplier}x škatla (${boxNum}/${boxTotal})`;
  const delta = (direction === 'in') ? totalAmount : -totalAmount;

  await DB.adjustStock(item.sku, delta, note, direction, boxNum, boxLocation);
  if (navigator.vibrate) navigator.vibrate([100, 50, 100]);

  showToast(direction === 'in' ? `Prevzeto: +${totalAmount} škatel (${chosenName})` : `Izdano: -${totalAmount} škatel (${chosenName})`);

  // Osveži prikaz
  const updatedItem = await DB.getItemById(item.sku);
  renderBoxResultCard(updatedItem);
  await refreshInventory();
};

window.openAddFromScannedBox = function() {
  if (!currentScannedBox) return;

  const chosenName = document.getElementById('boxResultNameInput')?.value?.trim() || currentScannedBox.name || '';
  const modalItem = document.getElementById('modalItem');
  const formItem = document.getElementById('formItem');
  formItem.reset();
  document.getElementById('itemId').value = '';
  document.getElementById('itemSku').value = currentScannedBox.articleNumber || '';
  document.getElementById('itemName').value = chosenName;
  document.getElementById('itemBoxInfo').value = `Box ${currentScannedBox.boxCurrent}/${currentScannedBox.boxTotal}`;
  document.getElementById('itemQuantity').value = 1;
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
    boxTotal: item ? item.boxTotal : 1,
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
   6b. MODUL ZA INVENTURO (STOCKTAKING AUDIT)
   ========================================================================= */
let auditSession = {
  entries: [],
  shelfFilter: 'all',
  statusFilter: 'all'
};
const AUDIT_STORAGE_KEY = 'skladisce_audit_session_v1';

function setupAuditModule() {
  // 1. Filter po regalu
  const shelfFilterEl = document.getElementById('auditShelfFilter');
  if (shelfFilterEl) {
    shelfFilterEl.addEventListener('change', (e) => {
      auditSession.shelfFilter = e.target.value;
      saveAuditSession();
      renderAuditList();
      updateAuditStats();
    });
  }

  // 2. Filter po statusu (Vse / Odstopanja / Še neprešteto / Usklajeno)
  const filterChipsEl = document.getElementById('auditFilterChips');
  if (filterChipsEl) {
    filterChipsEl.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      filterChipsEl.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      auditSession.statusFilter = chip.dataset.auditFilter || 'all';
      saveAuditSession();
      renderAuditList();
    });
  }

  // 3. Hitro skeniranje / iskanje po 7-mestni šifri
  const scanInput = document.getElementById('auditScanInput');
  const btnQuickCount = document.getElementById('btnAuditQuickCount');

  const triggerAuditScan = () => {
    const rawVal = scanInput ? scanInput.value.trim() : '';
    if (!rawVal) return;
    handleAuditScan(rawVal);
    if (scanInput) scanInput.value = '';
  };

  if (scanInput) {
    scanInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        triggerAuditScan();
      }
    });
  }
  if (btnQuickCount) {
    btnQuickCount.addEventListener('click', triggerAuditScan);
  }

  // 4. Ponastavitev popisa
  const btnReset = document.getElementById('btnResetAuditSession');
  if (btnReset) {
    btnReset.addEventListener('click', resetAuditSession);
  }

  // 5. Izvoz PDF Zapisnika
  const btnPdf = document.getElementById('btnExportAuditPDF');
  if (btnPdf) {
    btnPdf.addEventListener('click', exportAuditPDF);
  }

  // 6. Uveljavitev popisa v zalogo
  const btnApply = document.getElementById('btnApplyAudit');
  if (btnApply) {
    btnApply.addEventListener('click', applyAuditToInventory);
  }
}

async function loadAuditSession(forceReset = false) {
  try {
    const allItems = await DB.getAllItems();
    const newEntries = [];
    const shelfSet = new Set();

    for (const item of allItems) {
      const norm = DB.normalizeItemBoxes(item);
      const boxTotal = norm.boxTotal || 1;

      for (let b = 1; b <= boxTotal; b++) {
        const bObj = norm.boxes[b];
        if (!bObj) continue;

        const locs = (bObj.locations && bObj.locations.length > 0)
          ? bObj.locations
          : [{ name: bObj.location || norm.location || 'Brez lokacije', count: bObj.count || 0 }];

        for (const loc of locs) {
          const locName = String(loc.name || 'Brez lokacije').trim();
          shelfSet.add(locName);

          const key = `${item.id}_b${b}_${encodeURIComponent(locName)}`;
          newEntries.push({
            key,
            itemId: item.id,
            sku: item.sku,
            name: item.name,
            category: item.category || '',
            boxNum: b,
            boxTotal: boxTotal,
            locName: locName,
            bookQty: Number(loc.count) || 0,
            countedQty: 0,
            isCounted: false
          });
        }
      }
    }

    // Obnovi predhodno shranjene štetje iz localStorage
    if (!forceReset) {
      try {
        const savedRaw = localStorage.getItem(AUDIT_STORAGE_KEY);
        if (savedRaw) {
          const savedData = JSON.parse(savedRaw);
          if (savedData && Array.isArray(savedData.entries)) {
            const savedMap = new Map();
            savedData.entries.forEach(e => savedMap.set(e.key, e));

            newEntries.forEach(e => {
              const prev = savedMap.get(e.key);
              if (prev && prev.isCounted) {
                e.countedQty = Number(prev.countedQty) || 0;
                e.isCounted = true;
              }
            });
            if (savedData.shelfFilter) auditSession.shelfFilter = savedData.shelfFilter;
            if (savedData.statusFilter) auditSession.statusFilter = savedData.statusFilter;
          }
        }
      } catch (err) {
        console.warn('Napaka pri branju shranjene inventurne seje:', err);
      }
    }

    auditSession.entries = newEntries;

    // Posodobi spustni seznam regalov
    const shelfSelect = document.getElementById('auditShelfFilter');
    if (shelfSelect) {
      const currentSelected = auditSession.shelfFilter || 'all';
      const sortedShelves = Array.from(shelfSet).sort((a, b) => a.localeCompare(b, 'sl-SI'));

      let optionsHtml = '<option value="all">Vsi regali</option>';
      sortedShelves.forEach(shelf => {
        const isSel = (shelf === currentSelected) ? 'selected' : '';
        optionsHtml += `<option value="${escapeHtml(shelf)}" ${isSel}>${escapeHtml(shelf)}</option>`;
      });
      shelfSelect.innerHTML = optionsHtml;
    }

    // Posodobi statusne gumbe
    const filterChips = document.querySelectorAll('#auditFilterChips .chip');
    filterChips.forEach(chip => {
      chip.classList.toggle('active', chip.dataset.auditFilter === auditSession.statusFilter);
    });

    updateAuditStats();
    renderAuditList();
  } catch (err) {
    console.error('Napaka pri nalaganju inventurne seje:', err);
    showToast('Napaka pri nalaganju inventure: ' + err.message);
  }
}

function saveAuditSession() {
  try {
    localStorage.setItem(AUDIT_STORAGE_KEY, JSON.stringify(auditSession));
  } catch (e) {
    console.warn('Ne morem shraniti inventurne seje v localStorage:', e);
  }
}

function updateAuditStats() {
  const entries = auditSession.entries || [];
  const activeShelf = auditSession.shelfFilter || 'all';
  const filtered = (activeShelf === 'all')
    ? entries
    : entries.filter(e => e.locName.toLowerCase() === activeShelf.toLowerCase());

  const total = filtered.length;
  const counted = filtered.filter(e => e.isCounted).length;
  const match = filtered.filter(e => e.isCounted && e.countedQty === e.bookQty).length;
  const diff = filtered.filter(e => e.isCounted && e.countedQty !== e.bookQty).length;

  const totalEl = document.getElementById('auditStatTotal');
  const countedEl = document.getElementById('auditStatCounted');
  const matchEl = document.getElementById('auditStatMatch');
  const diffEl = document.getElementById('auditStatDiff');

  if (totalEl) totalEl.textContent = total;
  if (countedEl) countedEl.textContent = counted;
  if (matchEl) matchEl.textContent = match;
  if (diffEl) diffEl.textContent = diff;
}

function getAuditEntryStatus(entry) {
  if (!entry.isCounted) return 'uncounted';
  if (entry.countedQty === entry.bookQty) return 'match';
  return 'diff';
}

function renderAuditList() {
  const container = document.getElementById('auditItemsList');
  if (!container) return;

  const entries = auditSession.entries || [];
  const shelf = auditSession.shelfFilter || 'all';
  const statusFilter = auditSession.statusFilter || 'all';

  const list = entries.filter(entry => {
    // Filter regala
    if (shelf !== 'all' && entry.locName.toLowerCase() !== shelf.toLowerCase()) {
      return false;
    }
    // Filter statusa
    const status = getAuditEntryStatus(entry);
    if (statusFilter === 'diff' && status !== 'diff') return false;
    if (statusFilter === 'uncounted' && status !== 'uncounted') return false;
    if (statusFilter === 'match' && status !== 'match') return false;
    return true;
  });

  if (list.length === 0) {
    container.innerHTML = `
      <div class="empty-box" style="padding: 32px 16px; text-align: center;">
        <p style="color: var(--text-muted); font-size: 0.95rem;">Ni postavk za izbrane filtre.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = list.map(entry => {
    const status = getAuditEntryStatus(entry);
    const diff = entry.countedQty - entry.bookQty;
    const keyAttr = escapeHtml(entry.key);

    let diffBadgeHtml = '';
    if (!entry.isCounted) {
      diffBadgeHtml = `<span class="audit-diff-badge uncounted">Neprešteto</span>`;
    } else if (diff === 0) {
      diffBadgeHtml = `<span class="audit-diff-badge match">Usklajeno (0)</span>`;
    } else if (diff < 0) {
      diffBadgeHtml = `<span class="audit-diff-badge deficit">Manjko (${diff})</span>`;
    } else {
      diffBadgeHtml = `<span class="audit-diff-badge surplus">Višek (+${diff})</span>`;
    }

    return `
      <div class="audit-card status-${status}" id="auditCard_${keyAttr}">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 8px;">
          <div style="flex: 1;">
            <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 4px; flex-wrap: wrap;">
              <span class="item-sku-badge">${escapeHtml(entry.sku)}</span>
              <span class="chip" style="padding: 2px 7px; font-size: 0.72rem; border-color: rgba(56, 189, 248, 0.3); color: #38bdf8;">
                Škatla ${entry.boxNum}/${entry.boxTotal}
              </span>
              <span class="location-badge" style="font-size: 0.75rem;">
                ${escapeHtml(entry.locName)}
              </span>
            </div>
            <div style="font-weight: 700; font-size: 0.95rem; color: #fff; line-height: 1.3;">
              ${escapeHtml(entry.name)}
            </div>
          </div>
        </div>

        <div class="audit-counter-row">
          <div style="font-size: 0.85rem; color: var(--text-muted);">
            Knjižno: <strong style="color: #fff; font-size: 0.95rem;">${entry.bookQty}</strong> kos
          </div>

          <div class="audit-counter-ctrl">
            <button type="button" class="btn-audit-step" onclick="changeAuditCount('${keyAttr}', -1)">-</button>
            <input type="number" class="audit-count-input" id="auditInput_${keyAttr}" value="${entry.isCounted ? entry.countedQty : ''}" placeholder="0" min="0" onchange="setAuditCountExact('${keyAttr}', this.value)" onfocus="this.select()">
            <button type="button" class="btn-audit-step" onclick="changeAuditCount('${keyAttr}', 1)">+</button>
            <button type="button" class="chip" style="margin-left: 4px; padding: 6px 9px; font-size: 0.75rem; border-color: rgba(16, 185, 129, 0.4); color: #10b981; font-weight: 700;" onclick="matchAuditBook('${keyAttr}')" title="Nastavi enako kot knjižno">
              = Knjižno
            </button>
          </div>

          <div id="auditDiff_${keyAttr}">
            ${diffBadgeHtml}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function updateAuditCardDOM(entry) {
  const keyAttr = escapeHtml(entry.key);
  const card = document.getElementById(`auditCard_${keyAttr}`);
  const input = document.getElementById(`auditInput_${keyAttr}`);
  const diffDiv = document.getElementById(`auditDiff_${keyAttr}`);

  if (input) {
    input.value = entry.isCounted ? entry.countedQty : '';
  }

  const status = getAuditEntryStatus(entry);
  if (card) {
    card.className = `audit-card status-${status}`;
  }

  if (diffDiv) {
    const diff = entry.countedQty - entry.bookQty;
    if (!entry.isCounted) {
      diffDiv.innerHTML = `<span class="audit-diff-badge uncounted">Neprešteto</span>`;
    } else if (diff === 0) {
      diffDiv.innerHTML = `<span class="audit-diff-badge match">Usklajeno (0)</span>`;
    } else if (diff < 0) {
      diffDiv.innerHTML = `<span class="audit-diff-badge deficit">Manjko (${diff})</span>`;
    } else {
      diffDiv.innerHTML = `<span class="audit-diff-badge surplus">Višek (+${diff})</span>`;
    }
  }
}

window.changeAuditCount = function(key, delta) {
  const entry = auditSession.entries.find(e => e.key === key);
  if (!entry) return;

  if (!entry.isCounted) {
    entry.countedQty = Math.max(0, delta > 0 ? 1 : 0);
  } else {
    entry.countedQty = Math.max(0, (Number(entry.countedQty) || 0) + delta);
  }
  entry.isCounted = true;

  saveAuditSession();
  updateAuditStats();
  updateAuditCardDOM(entry);
};

window.setAuditCountExact = function(key, val) {
  const entry = auditSession.entries.find(e => e.key === key);
  if (!entry) return;

  if (val === '' || val === null) {
    entry.isCounted = false;
    entry.countedQty = 0;
  } else {
    entry.isCounted = true;
    entry.countedQty = Math.max(0, parseInt(val, 10) || 0);
  }

  saveAuditSession();
  updateAuditStats();
  updateAuditCardDOM(entry);
};

window.matchAuditBook = function(key) {
  const entry = auditSession.entries.find(e => e.key === key);
  if (!entry) return;

  entry.countedQty = entry.bookQty;
  entry.isCounted = true;

  saveAuditSession();
  updateAuditStats();
  updateAuditCardDOM(entry);
  playSuccessBeep();
  showToast(`Potrjeno: ${entry.sku} = ${entry.bookQty} kos`);
};

function handleAuditScan(skuInput) {
  const cleanSku = String(skuInput).trim().replace(/\D/g, '').substring(0, 7) || String(skuInput).trim();
  const entries = auditSession.entries || [];

  // Poišči vse postavke s tem SKU
  let matches = entries.filter(e => e.sku === cleanSku || e.sku.includes(cleanSku));
  if (matches.length === 0) {
    showToast(`Artikel s šifro "${skuInput}" ni bil najden.`);
    return;
  }

  // Če je aktiven filter regala, zožimo
  const activeShelf = auditSession.shelfFilter || 'all';
  if (activeShelf !== 'all') {
    const shelfMatches = matches.filter(e => e.locName.toLowerCase() === activeShelf.toLowerCase());
    if (shelfMatches.length > 0) {
      matches = shelfMatches;
    }
  }

  const target = matches[0];
  window.changeAuditCount(target.key, 1);

  // Pomakni se do kartice in jo označi
  const card = document.getElementById(`auditCard_${escapeHtml(target.key)}`);
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.style.outline = '2px solid #38bdf8';
    setTimeout(() => { card.style.outline = ''; }, 1200);
  }

  playSuccessBeep();
  showToast(`Prešteto +1: ${target.name} (${target.countedQty} kos)`);
}

async function resetAuditSession() {
  if (confirm('Ali res želite ponastaviti popis? Vse preštete vrednosti se bodo izbrisale.')) {
    localStorage.removeItem(AUDIT_STORAGE_KEY);
    await loadAuditSession(true);
    showToast('Inventurni popis ponastavljen.');
  }
}

async function applyAuditToInventory() {
  const entries = auditSession.entries || [];
  if (entries.length === 0) {
    showToast('Ni postavk za uveljavitev.');
    return;
  }

  const countedEntries = entries.filter(e => e.isCounted);
  if (countedEntries.length === 0) {
    showToast('Še niste prešteli nobene postavke.');
    return;
  }

  const diffEntries = countedEntries.filter(e => e.countedQty !== e.bookQty);
  const uncountedCount = entries.filter(e => !e.isCounted).length;

  if (diffEntries.length === 0) {
    showToast('Vse preštete postavke se ujemajo s knjižno zalogo. Spremembe niso potrebne.');
    return;
  }

  let confirmMsg = `Uveljavitev inventurnega popisa:\n\n` +
    `• Število postavk z odstopanjem: ${diffEntries.length}\n` +
    `• Preštetih brez razlik: ${countedEntries.length - diffEntries.length}\n`;

  if (uncountedCount > 0) {
    confirmMsg += `• Še nepreštetih: ${uncountedCount} (njihova zaloga se NE bo spreminjala)\n`;
  }
  confirmMsg += `\nAli želite uveljaviti novo stanje v zalogo? To bo zabeleženo v dnevnik premikov.`;

  if (!confirm(confirmMsg)) return;

  try {
    showToast('Usklajujem zalogo...');
    const result = await DB.applyAuditResults(entries);

    showToast(`Zaloga usklajena. Posodobljenih ${result.totalAdjustments} postavk.`);
    playSuccessBeep();

    // Počistimo sejo in naložimo sveže podatke
    localStorage.removeItem(AUDIT_STORAGE_KEY);
    await refreshInventory();
    await refreshLogs();
    await loadAuditSession(true);
  } catch (err) {
    console.error('Napaka pri uveljavljanju inventure:', err);
    showToast('Napaka pri uveljavljanju: ' + err.message);
  }
}

window.exportAuditPDF = async function exportAuditPDF() {
  try {
    showToast('Pripravljam PDF zapisnik inventure...');
    if (!auditSession.entries || auditSession.entries.length === 0) {
      await loadAuditSession();
    }
    const entries = auditSession.entries || [];
    if (entries.length === 0) {
      showToast('Ni podatkov za izpis.');
      return;
    }

    if (typeof window.jspdf === 'undefined' || !window.jspdf.jsPDF) {
      showToast('jsPDF knjižnica ni na voljo.');
      return;
    }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: 'a4'
    });

    const pageWidth = 210;
    const pageHeight = 297;
    const margin = 12;
    const contentWidth = pageWidth - (margin * 2); // 186mm

    let currentPage = 1;
    let y = 12;

    const activeShelf = auditSession.shelfFilter || 'all';
    const filteredEntries = (activeShelf === 'all')
      ? entries
      : entries.filter(e => (e.locName || '').toLowerCase() === activeShelf.toLowerCase());

    const totalPositions = filteredEntries.length;
    const countedPositions = filteredEntries.filter(e => e.isCounted).length;
    const matchPositions = filteredEntries.filter(e => e.isCounted && e.countedQty === e.bookQty).length;
    const diffPositions = filteredEntries.filter(e => e.isCounted && e.countedQty !== e.bookQty).length;

    let totalDeficit = 0;
    let totalSurplus = 0;
    filteredEntries.forEach(e => {
      if (e.isCounted) {
        const d = e.countedQty - e.bookQty;
        if (d < 0) totalDeficit += Math.abs(d);
        if (d > 0) totalSurplus += d;
      }
    });

    function drawPageHeader(pageNo) {
      if (pageNo === 1) {
        // Glavni pas naslova
        doc.setFillColor(15, 23, 42); // #0f172a
        doc.rect(margin, y, contentWidth, 22, 'F');

        doc.setTextColor(255, 255, 255);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(13);
        doc.text('INVENTURNI ZAPISNIK SKLADISCA', margin + 6, y + 8.5);

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8.2);
        doc.setTextColor(148, 163, 184);
        const nowStr = new Date().toLocaleDateString('sl-SI') + ' ob ' + new Date().toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' });
        const shelfText = (activeShelf === 'all') ? 'Vsi regali' : activeShelf;
        doc.text(`Uradni popis zaloge | Datum: ${nowStr} | Lokacija: ${shelfText}`, margin + 6, y + 16);

        y += 25;

        // Povzetek v glavi (samo 1. stran)
        doc.setFillColor(241, 245, 249);
        doc.rect(margin, y, contentWidth, 10, 'F');
        doc.setDrawColor(203, 213, 225);
        doc.rect(margin, y, contentWidth, 10, 'S');

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(7.5);
        doc.setTextColor(30, 41, 59);

        const colW = contentWidth / 5;
        doc.text(`POZICIJ: ${totalPositions}`, margin + 4, y + 6.5);
        doc.text(`PRESTETO: ${countedPositions}/${totalPositions}`, margin + colW + 2, y + 6.5);
        doc.text(`USKLAJENO: ${matchPositions}`, margin + (colW * 2) + 2, y + 6.5);
        doc.setTextColor(185, 28, 28);
        doc.text(`MANJKO: -${totalDeficit} kos`, margin + (colW * 3) + 2, y + 6.5);
        doc.setTextColor(217, 119, 6);
        doc.text(`VISEK: +${totalSurplus} kos`, margin + (colW * 4) + 2, y + 6.5);

        y += 13;
      } else {
        // Kompaktna glava za nadaljnje strani
        doc.setFillColor(15, 23, 42);
        doc.rect(margin, y, contentWidth, 10, 'F');

        doc.setTextColor(255, 255, 255);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9.5);
        doc.text('INVENTURNI ZAPISNIK SKLADISCA (Nadaljevanje)', margin + 6, y + 6.5);

        y += 12;
      }

      // Glava tabele z jasnimi, ločenimi stolpci
      doc.setFillColor(30, 41, 59);
      doc.rect(margin, y, contentWidth, 8, 'F');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.6);
      doc.setTextColor(255, 255, 255);

      doc.text('CRTNA KODA & SIFRA', margin + 3, y + 5.5);
      doc.text('NAZIV ARTIKLA', margin + 42, y + 5.5);
      doc.text('SKATLA', margin + 94, y + 5.5);
      doc.text('REGAL / LOKACIJA', margin + 110, y + 5.5);
      doc.text('KNJIZNO', margin + 144, y + 5.5);
      doc.text('PRESTETO', margin + 158, y + 5.5);
      doc.text('RAZLIKA', margin + 172, y + 5.5);

      y += 8.5;
    }

    function drawFooter(pageNo) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(148, 163, 184);
      doc.text(`Skladisce - Inventurni zapisnik - Stran ${pageNo}`, margin, pageHeight - 6);
    }

    drawPageHeader(1);

    let rowIndex = 0;
    for (const entry of filteredEntries) {
      const rowHeight = 15;
      if (y + rowHeight > pageHeight - 22) {
        drawFooter(currentPage);
        doc.addPage();
        currentPage++;
        y = 12;
        drawPageHeader(currentPage);
      }

      const isDiff = entry.isCounted && (entry.countedQty !== entry.bookQty);
      if (isDiff) {
        doc.setFillColor(254, 242, 242);
        doc.rect(margin, y - 0.5, contentWidth, rowHeight, 'F');
      } else if (rowIndex % 2 === 1) {
        doc.setFillColor(248, 250, 252);
        doc.rect(margin, y - 0.5, contentWidth, rowHeight, 'F');
      }

      doc.setDrawColor(226, 232, 240);
      doc.line(margin, y + rowHeight - 0.5, margin + contentWidth, y + rowHeight - 0.5);

      // 1. Črtna koda
      const barcodeData = generateBarcodeDataUrl(entry.sku);
      if (barcodeData) {
        doc.addImage(barcodeData, 'PNG', margin + 2, y + 0.5, 36, 12);
      } else {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8.5);
        doc.setTextColor(15, 23, 42);
        doc.text(String(entry.sku), margin + 3, y + 7);
      }

      // 2. Naziv artikla (z omejitvijo širine)
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.8);
      doc.setTextColor(15, 23, 42);
      const cleanName = (entry.name || '').replace(/[\u010d\u010c]/g, 'c').replace(/[\u0161\u0160]/g, 's').replace(/[\u017e\u017d]/g, 'z');
      const splitName = doc.splitTextToSize(cleanName, 49);
      doc.text(splitName, margin + 42, y + 5);

      // 3. Škatla
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(100, 116, 139);
      doc.text(`${entry.boxNum}/${entry.boxTotal}`, margin + 95, y + 6);

      // 4. Regal / Lokacija (z omejitvijo širine)
      const cleanLoc = (entry.locName || 'Brez lokacije').replace(/[\u010d\u010c]/g, 'c').replace(/[\u0161\u0160]/g, 's').replace(/[\u017e\u017d]/g, 'z');
      const splitLoc = doc.splitTextToSize(cleanLoc, 31);
      doc.text(splitLoc, margin + 110, y + 5);

      // 5. Knjižno
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(15, 23, 42);
      doc.text(`${entry.bookQty}`, margin + 146, y + 6);

      // 6. Prešteto
      doc.setFont('helvetica', 'bold');
      if (!entry.isCounted) {
        doc.setTextColor(148, 163, 184);
        doc.text('-', margin + 160, y + 6);
      } else {
        doc.setTextColor(15, 23, 42);
        doc.text(`${entry.countedQty}`, margin + 160, y + 6);
      }

      // 7. Razlika
      doc.setFontSize(7.6);
      if (!entry.isCounted) {
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(148, 163, 184);
        doc.text('Neprest.', margin + 172, y + 6);
      } else {
        const diff = entry.countedQty - entry.bookQty;
        if (diff === 0) {
          doc.setTextColor(16, 185, 129);
          doc.text('0 (Uskl.)', margin + 172, y + 6);
        } else if (diff < 0) {
          doc.setTextColor(220, 38, 38);
          doc.text(`${diff} kos`, margin + 172, y + 6);
        } else {
          doc.setTextColor(217, 119, 6);
          doc.text(`+${diff} kos`, margin + 172, y + 6);
        }
      }

      y += rowHeight;
      rowIndex++;
    }

    // Podpisna komisija na dnu
    if (y + 32 > pageHeight - 16) {
      drawFooter(currentPage);
      doc.addPage();
      currentPage++;
      y = 16;
      drawPageHeader(currentPage);
    } else {
      y += 6;
    }

    doc.setFillColor(248, 250, 252);
    doc.rect(margin, y, contentWidth, 22, 'F');
    doc.setDrawColor(203, 213, 225);
    doc.rect(margin, y, contentWidth, 22, 'S');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.8);
    doc.setTextColor(30, 41, 59);
    doc.text('POTRDITEV INVENTURNE KOMISIJE:', margin + 4, y + 5);

    const sigW = contentWidth / 3;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.2);
    doc.setTextColor(100, 116, 139);

    doc.text('Vodja komisije: ____________________', margin + 4, y + 15);
    doc.text('Clan komisije: ____________________', margin + sigW + 4, y + 15);
    doc.text('Vodja skladisca: ____________________', margin + (sigW * 2) + 4, y + 15);

    drawFooter(currentPage);

    const fileName = `Inventurni_zapisnik_${getDateStamp()}.pdf`;
    downloadFile(doc.output('blob'), fileName, 'application/pdf');
    showToast('Inventurni zapisnik PDF prenesen.');
  } catch (err) {
    console.error('Napaka pri generiranju inventurnega PDF:', err);
    showToast('Napaka pri PDF: ' + err.message);
  }
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

  // Ročno sprožena deduplikacija (združitev dvojnikov)
  const btnDeduplicate = document.getElementById('btnDeduplicate');
  if (btnDeduplicate) {
    btnDeduplicate.addEventListener('click', async () => {
      try {
        showToast('Preverjam dvojnike v bazi...');
        const res = await DB.deduplicateItems();
        if (res.removedDuplicatesCount > 0) {
          showToast(`Združeni ${res.mergedGroupsCount} artikli (odstranjenih ${res.removedDuplicatesCount} dvojnikov).`);
        } else {
          showToast('V bazi ni podvojenih artiklov.');
        }
        await refreshInventory();
      } catch (err) {
        console.error('Napaka pri deduplikaciji:', err);
        showToast('Napaka pri preverjanju dvojnikov: ' + err.message);
      }
    });
  }

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
          showToast(`Uvoženih ${data.items.length} artiklov.`);
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

  // Hitri PDF izpisi (Kompleti vs Nepopolne škatle)
  const btnPdfComplete = document.getElementById('btnPdfComplete');
  if (btnPdfComplete) btnPdfComplete.addEventListener('click', exportCompleteSetsPDF);

  const btnQuickPdfComplete = document.getElementById('btnQuickPdfComplete');
  if (btnQuickPdfComplete) btnQuickPdfComplete.addEventListener('click', exportCompleteSetsPDF);

  const btnPdfIncomplete = document.getElementById('btnPdfIncomplete');
  if (btnPdfIncomplete) btnPdfIncomplete.addEventListener('click', exportIncompleteSetsPDF);

  const btnQuickPdfIncomplete = document.getElementById('btnQuickPdfIncomplete');
  if (btnQuickPdfIncomplete) btnQuickPdfIncomplete.addEventListener('click', exportIncompleteSetsPDF);

  // Naloži Demo
  document.getElementById('btnLoadDemo').addEventListener('click', () => {
    loadDemoData();
  });

  // Izbris vseh artiklov (Počisti bazo)
  const btnClearAll = document.getElementById('btnClearAllItems');
  if (btnClearAll) {
    btnClearAll.addEventListener('click', async () => {
      const confirmed = confirm(
        'Ali ste prepričani, da želite izbrisati vse artikle in zalogo iz skladišča?'
      );
      if (!confirmed) return;

      try {
        await DB.clearAllItems();
        localStorage.setItem('skladisce_demo_seeded', 'true'); // Da se demo artikli ne naložijo ponovno
        showToast('Vsi artikli in zaloge so bili izbrisani.');
        await refreshInventory();
        await refreshLogs();
      } catch (err) {
        console.error('Napaka pri brisanju artiklov:', err);
        showToast('Napaka pri brisanju artiklov: ' + err.message);
      }
    });
  }
}

window.loadDemoData = async function() {
  await DB.seedDemoData();
  localStorage.setItem('skladisce_demo_seeded', 'true');
  showToast('Vzorčni artikli naloženi.');
  await refreshInventory();
};

/* =========================================================================
   7b. BREZZICNA BLE SINHRONIZACIJA
   ========================================================================= */
function setupBLESync() {
  const btnHeader = document.getElementById('btnHeaderBLESync');
  const btnSend = document.getElementById('btnOpenBLESend');
  const btnReceive = document.getElementById('btnOpenBLEReceive');
  const btnCancel = document.getElementById('btnCancelBLESync');
  const btnClose = document.getElementById('btnCloseBLESyncModal');

  if (btnHeader) {
    btnHeader.addEventListener('click', () => {
      openBLESyncChoice();
    });
  }

  if (btnSend) {
    btnSend.addEventListener('click', () => {
      startBLESending();
    });
  }

  if (btnReceive) {
    btnReceive.addEventListener('click', () => {
      startBLEReceiving();
    });
  }

  if (btnCancel) {
    btnCancel.addEventListener('click', () => {
      cancelBLESync();
    });
  }

  if (btnClose) {
    btnClose.addEventListener('click', () => {
      cancelBLESync();
    });
  }

  // Preveri, če je bila aplikacija odprta z zunanjim paketom (Intent)
  setTimeout(() => {
    checkNativeIncomingSync();
  }, 1000);
}

function openBLESyncChoice() {
  const modal = document.getElementById('modalBLESync');
  const title = document.getElementById('bleSyncStatusTitle');
  const desc = document.getElementById('bleSyncStatusDesc');
  const summary = document.getElementById('bleSyncSummaryBox');
  const radar = document.getElementById('bleRadarPulse');
  const cancelBtn = document.getElementById('btnCancelBLESync');

  if (!modal) return;

  radar.style.display = 'none';
  summary.style.display = 'block';
  summary.innerHTML = `
    <div style="display: flex; flex-direction: column; gap: 10px; margin-top: 6px;">
      <button class="btn-primary" onclick="startBLESending()" style="margin: 0; padding: 13px; font-weight: 700; font-size: 0.95rem;">
        Pošlji zalogo (Oddajaj)
      </button>
      <button class="btn-secondary" onclick="startBLEReceiving()" style="margin: 0; padding: 13px; font-weight: 700; font-size: 0.95rem; color: #38bdf8; border-color: rgba(56, 189, 248, 0.5);">
        Prejmi zalogo
      </button>
    </div>
  `;

  title.textContent = 'Bluetooth sinhronizacija';
  desc.textContent = 'Izberite pošiljanje ali prejemanje podatkov o zalogi.';
  cancelBtn.textContent = 'Zapri';
  modal.style.display = 'flex';
}

async function startBLESending() {
  const modal = document.getElementById('modalBLESync');
  const title = document.getElementById('bleSyncStatusTitle');
  const desc = document.getElementById('bleSyncStatusDesc');
  const summary = document.getElementById('bleSyncSummaryBox');
  const radar = document.getElementById('bleRadarPulse');
  const radarIcon = document.getElementById('bleRadarIcon');
  const cancelBtn = document.getElementById('btnCancelBLESync');

  modal.style.display = 'flex';
  radar.style.display = 'flex';
  radarIcon.textContent = 'BLE';
  summary.style.display = 'none';
  cancelBtn.textContent = 'Prekliči';

  title.textContent = 'Oddajam zalogo prek BLE...';
  desc.textContent = 'Na drugi napravi izberite "Prejmi zalogo". Čakam povezavo...';

  try {
    const items = await DB.getAllItems();
    const logs = await DB.getAllLogs();
    const payload = {
      version: 1,
      type: 'skladisce_sync',
      exportedAt: new Date().toISOString(),
      items,
      logs
    };
    const jsonStr = JSON.stringify(payload);

    if (isCapacitorNative() && window.Capacitor?.Plugins?.BLESync) {
      const res = await window.Capacitor.Plugins.BLESync.startSending({ data: jsonStr });
      if (res && res.success) {
        radar.style.display = 'none';
        summary.style.display = 'block';
        title.textContent = 'Podatki poslani';
        desc.textContent = 'Druga naprava je prejela stanje zaloge in premike.';
        summary.innerHTML = `
          <div style="color: #34d399; font-weight: 700; margin-bottom: 4px;">Prenos zaključen</div>
          <div>Oddanih ${items.length} artiklov in ${logs.length} zapisov premikov.</div>
        `;
        playSuccessBeep();
        cancelBtn.textContent = 'Zaključi';
      }
    } else {
      radar.style.display = 'none';
      summary.style.display = 'block';
      title.textContent = 'BLE zahteva nameščen APK';
      desc.textContent = 'Bluetooth povezava deluje na Android napravi (APK). V brskalniku uporabite izvoz varnostne kopije.';
    }
  } catch (err) {
    console.warn('BLE Send error:', err);
    radar.style.display = 'none';
    title.textContent = 'Oddajanje zaključeno / prekinjeno';
    desc.textContent = err.message || String(err);
  }
}

async function startBLEReceiving() {
  const modal = document.getElementById('modalBLESync');
  const title = document.getElementById('bleSyncStatusTitle');
  const desc = document.getElementById('bleSyncStatusDesc');
  const summary = document.getElementById('bleSyncSummaryBox');
  const radar = document.getElementById('bleRadarPulse');
  const radarIcon = document.getElementById('bleRadarIcon');
  const cancelBtn = document.getElementById('btnCancelBLESync');

  modal.style.display = 'flex';
  radar.style.display = 'flex';
  radarIcon.textContent = 'BLE';
  summary.style.display = 'none';
  cancelBtn.textContent = 'Prekliči';

  title.textContent = 'Iščem napravo v bližini...';
  desc.textContent = 'Približajte napravi (1–5 metrov).';

  try {
    if (isCapacitorNative() && window.Capacitor?.Plugins?.BLESync) {
      const res = await window.Capacitor.Plugins.BLESync.startReceiving();
      if (res && res.json) {
        title.textContent = 'Usklajujem bazo zaloge...';
        desc.textContent = 'Prejeti podatki se obdelujejo...';

        const parsed = JSON.parse(res.json);
        const mergeResult = await DB.mergeSyncData(parsed);

        await refreshInventory();
        await refreshLogs();
        playSuccessBeep();

        radar.style.display = 'none';
        summary.style.display = 'block';
        title.textContent = 'Zaloga usklajena';
        desc.textContent = 'Podatki o zalogi in premikih so posodobljeni.';

        let newNamesHtml = '';
        if (mergeResult.addedItemNames && mergeResult.addedItemNames.length > 0) {
          newNamesHtml = `<div style="margin-top: 6px; font-size: 0.78rem; color: #38bdf8;">Novi artikli: ${mergeResult.addedItemNames.slice(0, 3).join(', ')}${mergeResult.addedItemNames.length > 3 ? '...' : ''}</div>`;
        }

        summary.innerHTML = `
          <div style="font-weight: 700; color: #34d399; margin-bottom: 6px;">Posodobljeno:</div>
          <div><strong>${mergeResult.addedCount}</strong> novih artiklov dodanih v bazo</div>
          <div><strong>${mergeResult.updatedCount}</strong> stanj na policah posodobljenih</div>
          ${mergeResult.decreasedCount > 0 ? `<div style="color: #f87171; font-weight: 600;"><strong>${mergeResult.decreasedCount}</strong> artiklov z zmanjšano zalogo (izdaje)</div>` : ''}
          <div><strong>${mergeResult.addedLogsCount}</strong> novih zapisov v zgodovino premikov</div>
          ${newNamesHtml}
        `;
        cancelBtn.textContent = 'Zapri';
      }
    } else {
      radar.style.display = 'none';
      summary.style.display = 'block';
      title.textContent = 'BLE zahteva nameščen APK';
      desc.textContent = 'Bluetooth povezava deluje na Android napravi (APK).';
    }
  } catch (err) {
    console.warn('BLE Receive error:', err);
    radar.style.display = 'none';
    title.textContent = 'Iskanje prekinjeno';
    desc.textContent = err.message || String(err);
  }
}

function cancelBLESync() {
  if (isCapacitorNative() && window.Capacitor?.Plugins?.BLESync) {
    try {
      window.Capacitor.Plugins.BLESync.cancel();
    } catch (e) {}
  }
  const modal = document.getElementById('modalBLESync');
  if (modal) modal.style.display = 'none';
}

async function checkNativeIncomingSync() {
  if (isCapacitorNative() && window.Capacitor?.Plugins?.NativeFileSaver) {
    try {
      const res = await window.Capacitor.Plugins.NativeFileSaver.checkIncomingSync();
      if (res && res.hasData && res.jsonData) {
        const parsed = JSON.parse(res.jsonData);
        if (parsed && Array.isArray(parsed.items)) {
          showToast('Prejet nov paket zaloge. Usklajujem...');
          const result = await DB.mergeSyncData(parsed);
          await refreshInventory();
          await refreshLogs();
          playSuccessBeep();
          showToast(`Zaloga usklajena. Posodobljenih ${result.updatedCount} stanj.`);
        }
      }
    } catch (e) {
      console.warn('Napaka pri preverjanju dohodnega paketa:', e);
    }
  }
}

window.startBLESending = startBLESending;
window.startBLEReceiving = startBLEReceiving;
window.cancelBLESync = cancelBLESync;

/* =========================================================================
   8. GENERIRANJE PDF IZPISOV
   ========================================================================= */
function generateBarcodeDataUrl(sku) {
  try {
    if (typeof JsBarcode === 'undefined') return null;
    const canvas = document.createElement('canvas');
    JsBarcode(canvas, String(sku).trim(), {
      format: 'CODE128',
      width: 2,
      height: 42,
      displayValue: true,
      fontSize: 13,
      fontOptions: 'bold',
      margin: 4,
      background: '#ffffff',
      lineColor: '#000000'
    });
    return canvas.toDataURL('image/png');
  } catch (e) {
    console.warn('Napaka pri generiranju črtne kode za', sku, e);
    return null;
  }
}

window.exportCompleteSetsPDF = async function exportCompleteSetsPDF() {
  try {
    showToast('Pripravljam PDF s popolnimi kompleti...');
    const allItems = await DB.getAllItems();

    // V ta izpis gredo SAMO POPOLNI KOMPLETI (kjer so vse škatle na voljo)
    const items = allItems.filter(item => {
      const stats = DB.getBoxStats(item);
      return stats.completeSets > 0;
    });

    if (typeof window.jspdf === 'undefined' || !window.jspdf.jsPDF) {
      showToast('jsPDF knjižnica ni naložena.');
      return;
    }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: 'a4'
    });

    const pageWidth = 210;
    const pageHeight = 297;
    const margin = 14;
    const contentWidth = pageWidth - (margin * 2); // 182mm

    let currentPage = 1;
    let y = 16;

    function drawHeader() {
      // Header pas
      doc.setFillColor(15, 23, 42); // Temno modra
      doc.rect(margin, y, contentWidth, 22, 'F');

      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(13);
      doc.text('SKLADISCE - CELOTNA ZALOGA (POPOLNI KOMPLETI)', margin + 6, y + 9);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(148, 163, 184);
      const nowStr = new Date().toLocaleDateString('sl-SI') + ' ob ' + new Date().toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' });
      doc.text(`Izpis samo celih kompletov (vse sestavne skatle na zalogi) | Datum: ${nowStr}`, margin + 6, y + 16);

      y += 26;

      // Glava tabele: Stolpci (Koda s crtno kodo, Ime, Lokacija skatel, Kolicina)
      doc.setFillColor(241, 245, 249);
      doc.rect(margin, y, contentWidth, 8, 'F');
      doc.setDrawColor(203, 213, 225);
      doc.rect(margin, y, contentWidth, 8, 'S');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(30, 41, 59);

      doc.text('CRTNA KODA & SIFRA', margin + 3, y + 5.5);
      doc.text('IME ARTIKLA', margin + 50, y + 5.5);
      doc.text('LOKACIJA SKATEL', margin + 115, y + 5.5);
      doc.text('KOLICINA', margin + 158, y + 5.5);

      y += 9;
    }

    function drawFooter(pageNo) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(148, 163, 184);
      doc.text(`Skladisce - Porocilo popolnih kompletov - Stran ${pageNo}`, margin, pageHeight - 8);
    }

    if (items.length === 0) {
      drawHeader();
      y += 8;
      doc.setFillColor(254, 242, 242);
      doc.rect(margin, y, contentWidth, 24, 'F');
      doc.setDrawColor(239, 68, 68);
      doc.rect(margin, y, contentWidth, 24, 'S');
      
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(153, 27, 27);
      doc.text('NI POPOLNIH KOMPLETOV NA ZALOGI', margin + 8, y + 10);
      
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(185, 28, 28);
      doc.text('Trenutno na zalogi v skladiscu ni nobenega artikla s popolnimi vsemi skatlami.', margin + 8, y + 18);
      
      drawFooter(currentPage);
      const fileName = `skladisce-popolni-kompleti-${getDateStamp()}.pdf`;
      await downloadFile(doc.output('blob'), fileName, 'application/pdf');
      showToast('PDF s popolnimi kompleti shranjen.');
      return;
    }

    drawHeader();

    let totalSetsSum = 0;
    let rowIndex = 0;

    for (const item of items) {
      const stats = DB.getBoxStats(item);
      const completeQty = stats.completeSets;
      totalSetsSum += completeQty;

      const boxLines = stats.breakdown.map(b => 
        (stats.boxTotal > 1) 
          ? `Skatla ${b.boxNum}/${stats.boxTotal}: ${b.location} (${b.count} kos)`
          : `${b.location}`
      );
      const rowHeight = Math.max(18, 8 + (boxLines.length * 4.5));

      if (y + rowHeight > pageHeight - 16) {
        drawFooter(currentPage);
        doc.addPage();
        currentPage++;
        y = 16;
        drawHeader();
      }

      if (rowIndex % 2 === 1) {
        doc.setFillColor(248, 250, 252);
        doc.rect(margin, y - 1, contentWidth, rowHeight, 'F');
      }
      doc.setDrawColor(226, 232, 240);
      doc.line(margin, y + rowHeight - 1, margin + contentWidth, y + rowHeight - 1);

      // 1. Crtna koda & Sifra
      const barcodeData = generateBarcodeDataUrl(item.sku);
      if (barcodeData) {
        doc.addImage(barcodeData, 'PNG', margin + 2, y + 1, 42, 13);
      } else {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10);
        doc.setTextColor(15, 23, 42);
        doc.text(String(item.sku), margin + 4, y + 8);
      }

      // 2. Ime artikla
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(15, 23, 42);
      const splitName = doc.splitTextToSize(item.name, 60);
      doc.text(splitName, margin + 50, y + 4.5);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(100, 116, 139);
      const subInfo = `${item.category || 'Splosno'}${stats.boxTotal > 1 ? ` | ${stats.boxTotal}-delna garnitura` : ''}`;
      doc.text(subInfo, margin + 50, y + 4.5 + (splitName.length * 4));

      // 3. Lokacija skatel
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.8);
      doc.setTextColor(30, 41, 59);
      let locY = y + 4.5;
      boxLines.forEach(line => {
        const splitLine = doc.splitTextToSize(line, 41);
        doc.text(splitLine, margin + 115, locY);
        locY += splitLine.length * 4.0;
      });

      // 4. Kolicina
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(16, 185, 129);
      doc.text(`${completeQty}`, margin + 158, y + 6);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(100, 116, 139);
      doc.text(`${item.unit || (stats.boxTotal > 1 ? 'kompletov' : 'kos')}`, margin + 158, y + 10.5);

      y += rowHeight;
      rowIndex++;
    }

    if (y + 18 > pageHeight - 16) {
      drawFooter(currentPage);
      doc.addPage();
      currentPage++;
      y = 16;
    }

    y += 4;
    doc.setFillColor(241, 245, 249);
    doc.rect(margin, y, contentWidth, 13, 'F');
    doc.setDrawColor(148, 163, 184);
    doc.rect(margin, y, contentWidth, 13, 'S');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(15, 23, 42);
    doc.text(`SKUPAJ: ${items.length} artiklov z zalogo`, margin + 6, y + 8.5);
    doc.text(`Vseh celih kompletov: ${totalSetsSum} kos/garnitur`, margin + 100, y + 8.5);

    drawFooter(currentPage);

    const fileName = `skladisce-popolni-kompleti-${getDateStamp()}.pdf`;
    downloadFile(doc.output('blob'), fileName, 'application/pdf');
    showToast(`PDF s popolnimi kompleti shranjen.`);
  } catch (err) {
    console.error('Napaka pri generiranju PDF kompletov:', err);
    showToast('Napaka pri generiranju PDF: ' + err.message);
  }
}

window.exportIncompleteSetsPDF = async function exportIncompleteSetsPDF() {
  try {
    showToast('Pripravljam PDF z nepopolnimi škatlami...');
    const allItems = await DB.getAllItems();

    // V ta izpis gredo NEPOPOLNE ŠKATLE (kjer je samo en del škatel / manjkajo deli)
    const items = allItems.filter(item => {
      const stats = DB.getBoxStats(item);
      return stats.hasIncomplete;
    });

    if (typeof window.jspdf === 'undefined' || !window.jspdf.jsPDF) {
      showToast('jsPDF knjižnica ni naložena.');
      return;
    }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: 'a4'
    });

    const pageWidth = 210;
    const pageHeight = 297;
    const margin = 12;
    const contentWidth = pageWidth - (margin * 2); // 186mm

    let currentPage = 1;
    let y = 14;

    function drawHeader() {
      // Header pas (Amber barva)
      doc.setFillColor(180, 83, 9); // #b45309
      doc.rect(margin, y, contentWidth, 22, 'F');

      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(13);
      doc.text('POROCILO: NEPOPOLNE SKATLE IN MANJKAJOCI DELI', margin + 6, y + 8.5);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.2);
      doc.setTextColor(254, 243, 199);
      const nowStr = new Date().toLocaleDateString('sl-SI') + ' ob ' + new Date().toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' });
      doc.text(`Artikli z manjkajocimi skatlami za sestavo celotnega kompleta | Datum: ${nowStr}`, margin + 6, y + 16);

      y += 26;

      // Glava tabele z jasnimi razmiki
      doc.setFillColor(254, 243, 199);
      doc.rect(margin, y, contentWidth, 8, 'F');
      doc.setDrawColor(245, 158, 11);
      doc.rect(margin, y, contentWidth, 8, 'S');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(146, 64, 14);

      doc.text('CRTNA KODA & SIFRA', margin + 3, y + 5.5);
      doc.text('IME ARTIKLA', margin + 44, y + 5.5);
      doc.text('STANJE SKATEL & LOKACIJE', margin + 95, y + 5.5);
      doc.text('MANJKA / STANJE', margin + 148, y + 5.5);

      y += 8.5;
    }

    function drawFooter(pageNo) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(148, 163, 184);
      doc.text(`Skladisce - Porocilo nepopolnih skatel - Stran ${pageNo}`, margin, pageHeight - 6);
    }

    if (items.length === 0) {
      drawHeader();
      y += 8;
      doc.setFillColor(240, 253, 244);
      doc.rect(margin, y, contentWidth, 24, 'F');
      doc.setDrawColor(34, 197, 94);
      doc.rect(margin, y, contentWidth, 24, 'S');
      
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(22, 101, 52);
      doc.text('VSE SKATLE SO POPOLNE - NI MANJKAJOCIH DELOV', margin + 8, y + 10);
      
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(21, 128, 61);
      doc.text('Vsi artikli na zalogi imajo usklajene vse sestavne dele skatel. Noben artikel nima primanjkljaja.', margin + 8, y + 18);
      
      drawFooter(currentPage);
      const fileName = `skladisce-nepopolne-skatle-${getDateStamp()}.pdf`;
      await downloadFile(doc.output('blob'), fileName, 'application/pdf');
      showToast('PDF z nepopolnimi škatlami shranjen.');
      return;
    }

    drawHeader();

    let rowIndex = 0;

    for (const item of items) {
      const stats = DB.getBoxStats(item);

      const boxLines = stats.breakdown.map(b => 
        `Skatla ${b.boxNum}/${stats.boxTotal}: ${b.count} kos (${b.location})`
      );

      // 2. Ime artikla (priprava vrstic za preračun višine)
      const cleanName = (item.name || '').replace(/[\u010d\u010c]/g, 'c').replace(/[\u0161\u0160]/g, 's').replace(/[\u017e\u017d]/g, 'z');
      const splitName = doc.splitTextToSize(cleanName, 48);

      // 3. Stanje škatel (ovite vrstice)
      const wrappedBoxLines = [];
      boxLines.forEach(line => {
        const cleanLine = line.replace(/[\u010d\u010c]/g, 'c').replace(/[\u0161\u0160]/g, 's').replace(/[\u017e\u017d]/g, 'z');
        const splitBox = doc.splitTextToSize(cleanLine, 50);
        splitBox.forEach(s => wrappedBoxLines.push(s));
      });

      // 4. Manjka / Stanje
      const cleanMissing = (stats.missingSummary || 'Nepopolno').replace(/[\u010d\u010c]/g, 'c').replace(/[\u0161\u0160]/g, 's').replace(/[\u017e\u017d]/g, 'z');
      const splitMissing = doc.splitTextToSize(cleanMissing, 35);

      // Dinamična višina vrstice, da se besedilo nikoli ne seka ali reže
      const nameLinesCount = splitName.length + 1;
      const boxLinesCount = wrappedBoxLines.length;
      const missingLinesCount = splitMissing.length + 1;
      const maxContentLines = Math.max(nameLinesCount, boxLinesCount, missingLinesCount, 3);
      const rowHeight = Math.max(18, 6 + (maxContentLines * 4.2));

      if (y + rowHeight > pageHeight - 20) {
        drawFooter(currentPage);
        doc.addPage();
        currentPage++;
        y = 14;
        drawHeader();
      }

      if (rowIndex % 2 === 1) {
        doc.setFillColor(255, 251, 235);
        doc.rect(margin, y - 0.5, contentWidth, rowHeight, 'F');
      }
      doc.setDrawColor(253, 230, 138);
      doc.line(margin, y + rowHeight - 0.5, margin + contentWidth, y + rowHeight - 0.5);

      // 1. Crtna koda & Sifra
      const barcodeData = generateBarcodeDataUrl(item.sku);
      if (barcodeData) {
        doc.addImage(barcodeData, 'PNG', margin + 2, y + 1, 38, 12);
      } else {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8.5);
        doc.setTextColor(15, 23, 42);
        doc.text(String(item.sku), margin + 4, y + 8);
      }

      // 2. Ime artikla
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.2);
      doc.setTextColor(15, 23, 42);
      doc.text(splitName, margin + 44, y + 4.5);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.2);
      doc.setTextColor(100, 116, 139);
      doc.text(`${item.category || 'Splosno'} | ${stats.boxTotal}-delni`, margin + 44, y + 4.5 + (splitName.length * 3.8));

      // 3. Stanje skatel & lokacije (strogo omejeno na širino 50mm, brez prekrivanja!)
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(30, 41, 59);
      let locY = y + 4.5;
      wrappedBoxLines.forEach(line => {
        doc.text(line, margin + 95, locY);
        locY += 4.0;
      });

      // 4. Manjka / Stanje (pri margin + 148, ločeno od stolpca 3)
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.8);
      doc.setTextColor(217, 119, 6);
      doc.text(splitMissing, margin + 148, y + 4.5);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.2);
      doc.setTextColor(71, 85, 105);
      doc.text(`Celih: ${stats.completeSets} kpl`, margin + 148, y + 5.5 + (splitMissing.length * 3.8));

      y += rowHeight;
      rowIndex++;
    }

    if (y + 18 > pageHeight - 16) {
      drawFooter(currentPage);
      doc.addPage();
      currentPage++;
      y = 14;
      drawHeader();
    }

    y += 4;
    doc.setFillColor(254, 243, 199);
    doc.rect(margin, y, contentWidth, 12, 'F');
    doc.setDrawColor(245, 158, 11);
    doc.rect(margin, y, contentWidth, 12, 'S');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(146, 64, 14);
    doc.text(`OPOZORILO: ${items.length} artiklov ima nepopolne skatle in potrebuje dopolnitev.`, margin + 6, y + 7.5);

    drawFooter(currentPage);

    const fileName = `skladisce-nepopolne-skatle-${getDateStamp()}.pdf`;
    downloadFile(doc.output('blob'), fileName, 'application/pdf');
    showToast(`PDF z nepopolnimi škatlami shranjen.`);
  } catch (err) {
    console.error('Napaka pri generiranju PDF nepopolnih škatel:', err);
    showToast('Napaka pri generiranju PDF: ' + err.message);
  }
}

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

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function downloadFile(content, fileName, mimeType) {
  // Če tečemo v Capacitor APK (Android)
  if (isCapacitorNative() && window.Capacitor?.Plugins?.NativeFileSaver) {
    try {
      showToast('Shranjujem v Prenose (Downloads)...');
      let base64 = '';
      if (content instanceof Blob) {
        base64 = await blobToBase64(content);
      } else if (typeof content === 'string') {
        const textBlob = new Blob([content], { type: mimeType || 'text/plain;charset=utf-8;' });
        base64 = await blobToBase64(textBlob);
      }

      await window.Capacitor.Plugins.NativeFileSaver.saveAndOpenFile({
        fileName: fileName,
        base64: base64,
        mimeType: mimeType || 'application/pdf'
      });

      showToast(`Shranjeno v Prenose: ${fileName}`);
      playSuccessBeep();
      return;
    } catch (e) {
      console.warn('NativeFileSaver napaka:', e);
      showToast('Napaka pri shranjevanju: ' + (e.message || e));
    }
  }

  // Spletni način (PWA v brskalniku)
  const blob = (content instanceof Blob) ? content : new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

