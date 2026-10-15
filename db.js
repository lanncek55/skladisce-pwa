/**
 * db.js - IndexedDB modul za shranjevanje podatkov o zalogi in premikih
 */

const DB_NAME = 'SkladisceDB';
const DB_VERSION = 1;

let dbInstance = null;

function openDB() {
  if (dbInstance) return Promise.resolve(dbInstance);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      // Tabela artiklov
      if (!db.objectStoreNames.contains('items')) {
        const itemStore = db.createObjectStore('items', { keyPath: 'id', autoIncrement: true });
        itemStore.createIndex('sku', 'sku', { unique: false });
        itemStore.createIndex('name', 'name', { unique: false });
        itemStore.createIndex('category', 'category', { unique: false });
        itemStore.createIndex('location', 'location', { unique: false });
      }

      // Tabela premikov (zgodovina)
      if (!db.objectStoreNames.contains('logs')) {
        const logStore = db.createObjectStore('logs', { keyPath: 'id', autoIncrement: true });
        logStore.createIndex('itemId', 'itemId', { unique: false });
        logStore.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };

    request.onsuccess = (event) => {
      dbInstance = event.target.result;
      resolve(dbInstance);
    };

    request.onerror = (event) => {
      reject('Napaka pri odpiranju IndexedDB: ' + event.target.error);
    };
  });
}

function parseBoxInfo(boxInfo) {
  const match = String(boxInfo || '').match(/(\d+)\s*[\/:]\s*(\d+)/);
  if (match) {
    return {
      boxCurrent: parseInt(match[1], 10) || 1,
      boxTotal: Math.max(1, parseInt(match[2], 10) || 1)
    };
  }
  return { boxCurrent: 1, boxTotal: 1 };
}

/**
 * Normalizira lokacije posamezne škatle s podporo za več regalov (primarni + rezerva/preliv)
 */
function normalizeBoxLocations(bData, fallbackLoc = 'Brez lokacije') {
  if (!bData) {
    return {
      count: 0,
      location: fallbackLoc,
      locations: [{ name: fallbackLoc, count: 0, isPrimary: true }]
    };
  }

  let locations = [];
  if (Array.isArray(bData.locations) && bData.locations.length > 0) {
    locations = bData.locations.map((loc, idx) => ({
      name: String(loc.name || loc.location || fallbackLoc).trim(),
      count: Math.max(0, Number(loc.count) || 0),
      isPrimary: (idx === 0)
    }));
  } else {
    const rawLoc = String(bData.location || fallbackLoc).trim();
    // Če niz vsebuje npr. "Regal P-04 (4 kos) / Regal P-09 (2 kos)"
    const parts = rawLoc.split(/\s*[\/,+]\s*/).filter(Boolean);
    if (parts.length > 1 && parts.some(p => /\(\s*\d+\s*(?:kos|kom)?\s*\)/i.test(p))) {
      let parsedSum = 0;
      parts.forEach((p, idx) => {
        const countMatch = p.match(/\(\s*(\d+)\s*(?:kos|kom)?\s*\)/i);
        const count = countMatch ? parseInt(countMatch[1], 10) : 0;
        const cleanName = p.replace(/\(\s*\d+\s*(?:kos|kom)?\s*\)/i, '').trim();
        parsedSum += count;
        locations.push({
          name: cleanName || fallbackLoc,
          count: count,
          isPrimary: (idx === 0)
        });
      });
      const bCount = Math.max(0, Number(bData.count) || 0);
      if (bCount > parsedSum && locations.length > 0) {
        locations[0].count += (bCount - parsedSum);
      }
    } else {
      locations = [{
        name: rawLoc || fallbackLoc,
        count: Math.max(0, Number(bData.count) || 0),
        isPrimary: true
      }];
    }
  }

  if (locations.length === 0) {
    locations.push({ name: fallbackLoc, count: Math.max(0, Number(bData.count) || 0), isPrimary: true });
  }

  const totalCount = locations.reduce((sum, l) => sum + (Number(l.count) || 0), 0);
  let summaryLoc = '';
  if (locations.length <= 1) {
    summaryLoc = locations[0]?.name || fallbackLoc;
  } else {
    summaryLoc = locations.map(l => `${l.name} (${l.count} kos)`).join(' / ');
  }

  return {
    count: totalCount,
    location: summaryLoc,
    locations: locations
  };
}

function normalizeItemBoxes(item) {
  if (!item) return item;
  const parsed = parseBoxInfo(item.boxInfo);
  const boxTotal = Math.max(1, parseInt(item.boxTotal, 10) || parsed.boxTotal);
  item.boxTotal = boxTotal;

  if (!item.boxes || typeof item.boxes !== 'object') {
    item.boxes = {};
  }

  for (let b = 1; b <= boxTotal; b++) {
    const rawBox = item.boxes[b] || {
      count: (boxTotal === 1) ? (Number(item.quantity) || 0) : ((b === parsed.boxCurrent) ? (Number(item.quantity) || 0) : 0),
      location: String(item.location || 'Brez lokacije').trim()
    };
    item.boxes[b] = normalizeBoxLocations(rawBox, item.location || 'Brez lokacije');
  }

  return item;
}

const DB = {
  parseBoxInfo,
  normalizeBoxLocations,
  normalizeItemBoxes,

  getBoxStats(item) {
    const it = normalizeItemBoxes(item);
    const boxTotal = it.boxTotal;
    const counts = [];
    const breakdown = [];
    const missing = [];

    for (let b = 1; b <= boxTotal; b++) {
      const bData = it.boxes[b] || { count: 0, location: it.location || 'Brez lokacije', locations: [] };
      const count = Number(bData.count) || 0;
      counts.push(count);
      breakdown.push({
        boxNum: b,
        boxTotal: boxTotal,
        count: count,
        location: bData.location || 'Brez lokacije',
        locations: bData.locations || [{ name: bData.location || 'Brez lokacije', count: count, isPrimary: true }]
      });
    }

    const minCount = Math.min(...counts);
    const maxCount = Math.max(...counts);
    const completeSets = (boxTotal === 1) ? (Number(it.quantity) || 0) : minCount;

    if (boxTotal > 1) {
      breakdown.forEach(b => {
        if (b.count < maxCount) {
          missing.push(`Manjka ${maxCount - b.count}x Škatla ${b.boxNum}/${boxTotal}`);
        }
      });
    }

    const hasIncomplete = (boxTotal > 1) && (maxCount > 0) && (minCount < maxCount || missing.length > 0);

    return {
      boxTotal,
      boxes: it.boxes,
      breakdown,
      completeSets,
      minCount,
      maxCount,
      isComplete: completeSets > 0 && !hasIncomplete,
      hasIncomplete,
      missingSummary: missing.join(', ')
    };
  },

  async getAllItems() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('items', 'readonly');
      const store = tx.objectStore('items');
      const req = store.getAll();
      req.onsuccess = () => {
        const items = (req.result || []).map(normalizeItemBoxes);
        resolve(items);
      };
      req.onerror = () => reject(req.error);
    });
  },

  async getItemById(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('items', 'readonly');
      const store = tx.objectStore('items');
      const req = store.get(Number(id));
      req.onsuccess = () => {
        if (req.result) {
          resolve(normalizeItemBoxes(req.result));
        } else {
          resolve(null);
        }
      };
      req.onerror = () => reject(req.error);
    });
  },

  async getItemBySKU(sku) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('items', 'readonly');
      const store = tx.objectStore('items');
      const req = store.openCursor();
      const cleanSKU = String(sku).trim().toLowerCase();
      let found = null;

      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          if (String(cursor.value.sku || '').trim().toLowerCase() === cleanSKU) {
            found = normalizeItemBoxes(cursor.value);
            resolve(found);
            return;
          }
          cursor.continue();
        } else {
          resolve(found);
        }
      };
      req.onerror = () => reject(req.error);
    });
  },

  async addItem(item) {
    const db = await openDB();
    const parsed = parseBoxInfo(item.boxInfo);
    const boxTotal = Math.max(1, parseInt(item.boxTotal, 10) || parsed.boxTotal);

    let boxes = item.boxes;
    if (!boxes || typeof boxes !== 'object') {
      boxes = {};
      for (let b = 1; b <= boxTotal; b++) {
        boxes[b] = {
          count: (boxTotal === 1) ? (Number(item.quantity) || 0) : ((b === parsed.boxCurrent) ? (Number(item.quantity) || 0) : 0),
          location: String(item.location || 'Brez lokacije').trim()
        };
      }
    }

    const itemData = {
      sku: String(item.sku || '').trim(),
      name: String(item.name || '').trim(),
      category: String(item.category || 'Splošno').trim(),
      location: String(item.location || 'Brez lokacije').trim(),
      quantity: Number(item.quantity) || 0,
      minQuantity: Number(item.minQuantity) || 0,
      unit: String(item.unit || 'kos').trim(),
      boxInfo: String(item.boxInfo || `Box 1/${boxTotal}`).trim(),
      boxTotal: boxTotal,
      boxes: boxes,
      piecesPerBox: Number(item.piecesPerBox) || 1,
      notes: String(item.notes || '').trim(),
      lastUpdated: new Date().toISOString()
    };

    return new Promise((resolve, reject) => {
      const tx = db.transaction(['items', 'logs'], 'readwrite');
      const itemStore = tx.objectStore('items');
      const logStore = tx.objectStore('logs');

      const req = itemStore.add(itemData);
      req.onsuccess = () => {
        const newId = req.result;
        logStore.add({
          itemId: newId,
          sku: itemData.sku,
          itemName: itemData.name,
          changeType: 'create',
          changeAmount: itemData.quantity,
          resultingQty: itemData.quantity,
          note: `Začetni vnos (${itemData.boxInfo}, lokacija: ${itemData.location})`,
          timestamp: new Date().toISOString()
        });
        resolve(newId);
      };
      req.onerror = () => reject(req.error);
    });
  },

  async updateItem(item) {
    const db = await openDB();
    const parsed = parseBoxInfo(item.boxInfo);
    const boxTotal = Math.max(1, parseInt(item.boxTotal, 10) || parsed.boxTotal);

    let boxes = item.boxes;
    if (!boxes || typeof boxes !== 'object') {
      boxes = {};
      for (let b = 1; b <= boxTotal; b++) {
        boxes[b] = {
          count: (boxTotal === 1) ? (Number(item.quantity) || 0) : 0,
          location: String(item.location || 'Brez lokacije').trim()
        };
      }
    }

    const updatedData = {
      ...item,
      id: Number(item.id),
      sku: String(item.sku || '').trim(),
      name: String(item.name || '').trim(),
      category: String(item.category || 'Splošno').trim(),
      location: String(item.location || 'Brez lokacije').trim(),
      quantity: Number(item.quantity) || 0,
      minQuantity: Number(item.minQuantity) || 0,
      unit: String(item.unit || 'kos').trim(),
      boxInfo: String(item.boxInfo || `Box 1/${boxTotal}`).trim(),
      boxTotal: boxTotal,
      boxes: boxes,
      piecesPerBox: Number(item.piecesPerBox) || 1,
      notes: String(item.notes || '').trim(),
      lastUpdated: new Date().toISOString()
    };

    return new Promise((resolve, reject) => {
      const tx = db.transaction('items', 'readwrite');
      const store = tx.objectStore('items');
      const req = store.put(updatedData);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  async deleteItem(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['items', 'logs'], 'readwrite');
      const itemStore = tx.objectStore('items');
      const logStore = tx.objectStore('logs');

      const getReq = itemStore.get(Number(id));
      getReq.onsuccess = () => {
        const existing = getReq.result;
        if (existing) {
          logStore.add({
            itemId: existing.id,
            sku: existing.sku,
            itemName: existing.name,
            changeType: 'delete',
            changeAmount: -existing.quantity,
            resultingQty: 0,
            note: 'Izbris artikla iz zaloge',
            timestamp: new Date().toISOString()
          });
        }
        itemStore.delete(Number(id));
        resolve(true);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  },

  async adjustStock(id, delta, note = '', type = 'adjust', boxNum = null, boxLocation = null) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['items', 'logs'], 'readwrite');
      const itemStore = tx.objectStore('items');
      const logStore = tx.objectStore('logs');

      const getReq = itemStore.get(Number(id));
      getReq.onsuccess = () => {
        let item = getReq.result;
        if (!item) {
          reject(new Error('Artikel ne obstaja.'));
          return;
        }

        item = normalizeItemBoxes(item);
        const bNum = boxNum ? parseInt(boxNum, 10) : 1;

        if (boxLocation) {
          const cleanLoc = String(boxLocation).trim();
          if (cleanLoc && item.boxes[bNum]) {
            const locs = item.boxes[bNum].locations || [];
            let foundLoc = locs.find(l => l.name.toLowerCase() === cleanLoc.toLowerCase());
            if (foundLoc) {
              foundLoc.count = Math.max(0, (Number(foundLoc.count) || 0) + Number(delta));
            } else {
              locs.push({
                name: cleanLoc,
                count: Math.max(0, Number(delta)),
                isPrimary: locs.length === 0
              });
            }
            item.boxes[bNum] = normalizeBoxLocations(item.boxes[bNum], cleanLoc);
          }
        } else if (item.boxes && item.boxes[bNum]) {
          let remaining = Math.abs(Number(delta));
          const locs = item.boxes[bNum].locations || [];
          if (delta >= 0) {
            if (locs.length > 0) {
              locs[0].count = (Number(locs[0].count) || 0) + remaining;
            } else {
              locs.push({ name: item.location || 'Brez lokacije', count: remaining, isPrimary: true });
            }
          } else {
            for (let l of locs) {
              if (remaining <= 0) break;
              if (l.count > 0) {
                const take = Math.min(l.count, remaining);
                l.count -= take;
                remaining -= take;
              }
            }
            if (remaining > 0 && locs.length > 0) {
              locs[0].count = Math.max(0, locs[0].count - remaining);
            }
          }
          item.boxes[bNum] = normalizeBoxLocations(item.boxes[bNum], item.location);
        }

        // Izračunaj nove statistike kompletov
        const stats = DB.getBoxStats(item);
        item.quantity = stats.completeSets;
        item.lastUpdated = new Date().toISOString();

        itemStore.put(item);

        const boxDetailsText = (item.boxTotal > 1) 
          ? ` (Škatla ${bNum}/${item.boxTotal}${boxLocation ? ` @ ${boxLocation}` : ''}, celih kompletov: ${stats.completeSets})`
          : (boxLocation ? ` (@ ${boxLocation})` : '');

        logStore.add({
          itemId: item.id,
          sku: item.sku,
          itemName: item.name,
          changeType: type,
          changeAmount: Number(delta),
          resultingQty: item.quantity,
          note: (note || (delta >= 0 ? 'Prevzem blaga' : 'Izdaja blaga')) + boxDetailsText,
          timestamp: new Date().toISOString()
        });

        resolve(item);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  },

  /**
   * Izdaja celotnega artikla (odšteje po 1 kos od vseh škatel pri večdelnih garniturah)
   */
  async issueCompleteItem(id, qty = 1, note = '') {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['items', 'logs'], 'readwrite');
      const itemStore = tx.objectStore('items');
      const logStore = tx.objectStore('logs');

      const getReq = itemStore.get(Number(id));
      getReq.onsuccess = () => {
        let item = getReq.result;
        if (!item) {
          reject(new Error('Artikel ne obstaja.'));
          return;
        }

        item = normalizeItemBoxes(item);
        const boxTotal = Math.max(1, item.boxTotal || 1);
        const issueQty = Math.max(1, Number(qty) || 1);
        const pickDetails = [];

        for (let b = 1; b <= boxTotal; b++) {
          if (!item.boxes[b]) {
            item.boxes[b] = { count: 0, location: item.location || 'Brez lokacije', locations: [] };
          }
          let remaining = issueQty;
          const locs = item.boxes[b].locations || [];
          for (let l of locs) {
            if (remaining <= 0) break;
            if (l.count > 0) {
              const take = Math.min(l.count, remaining);
              l.count -= take;
              remaining -= take;
              pickDetails.push(`Šk.${b}: ${take}x iz ${l.name}`);
            }
          }
          if (remaining > 0 && locs.length > 0) {
            locs[0].count = Math.max(0, locs[0].count - remaining);
          }
          item.boxes[b] = normalizeBoxLocations(item.boxes[b], item.location);
        }

        const stats = DB.getBoxStats(item);
        item.quantity = stats.completeSets;
        item.lastUpdated = new Date().toISOString();

        itemStore.put(item);

        const pickSummary = pickDetails.length > 0 ? ` [${pickDetails.join(', ')}]` : '';
        logStore.add({
          itemId: item.id,
          sku: item.sku,
          itemName: item.name,
          changeType: 'out',
          changeAmount: -issueQty,
          resultingQty: item.quantity,
          note: (note || 'Izdaja artikla kupcu') + ` (-${issueQty}x komplet${pickSummary}, preostalo: ${item.quantity})`,
          timestamp: new Date().toISOString()
        });

        resolve(item);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  },

  async getAllLogs() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('logs', 'readonly');
      const store = tx.objectStore('logs');
      const req = store.getAll();
      req.onsuccess = () => {
        const logs = req.result || [];
        logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        resolve(logs);
      };
      req.onerror = () => reject(req.error);
    });
  },

  async clearLogs() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('logs', 'readwrite');
      const store = tx.objectStore('logs');
      const req = store.clear();
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  },

  async seedDemoData() {
    const demoItems = [
      // 1-škatelni artikli (popolni)
      { 
        sku: '3725150', 
        name: 'Garden chair FJELLERUP', 
        category: 'Vrtno pohištvo', 
        location: 'Regal V-04', 
        quantity: 24, 
        minQuantity: 8, 
        unit: 'kos', 
        boxInfo: 'Box 1/1', 
        boxTotal: 1,
        boxes: { 1: { count: 24, location: 'Regal V-04' } },
        piecesPerBox: 4, 
        notes: 'W56 x H93 x D66 cm, Natural' 
      },
      { 
        sku: '3651003', 
        name: 'Mirror SANDAGER 3 pcs/pk oak', 
        category: 'Ogledala & Dekor', 
        location: 'Regal O-02', 
        quantity: 15, 
        minQuantity: 6, 
        unit: 'kos', 
        boxInfo: 'Box 1/1', 
        boxTotal: 1,
        boxes: { 1: { count: 15, location: 'Regal O-02' } },
        piecesPerBox: 1, 
        notes: 'Ø45/55/70 oak (komplet 3 ogledal)' 
      },
      { 
        sku: '3690565', 
        name: 'Mirror BALSLEV 35x127 w.oak', 
        category: 'Ogledala & Dekor', 
        location: 'Regal O-04', 
        quantity: 16, 
        minQuantity: 8, 
        unit: 'kos', 
        boxInfo: 'Box 1/1', 
        boxTotal: 1,
        boxes: { 1: { count: 16, location: 'Regal O-04' } },
        piecesPerBox: 4, 
        notes: 'W35xH127xD2 cm, Warm oak' 
      },
      { 
        sku: '3690514', 
        name: 'Dining chair ADSLEV beige/n.oak', 
        category: 'Stoli & Mize', 
        location: 'Regal S-02', 
        quantity: 12, 
        minQuantity: 4, 
        unit: 'kos', 
        boxInfo: 'Box 1/1', 
        boxTotal: 1,
        boxes: { 1: { count: 12, location: 'Regal S-02' } },
        piecesPerBox: 2, 
        notes: 'W59 x H82 x D59 cm' 
      },

      // Več-škatelni artikli: POPOLNI KOMPLETI
      {
        sku: '3600520',
        name: 'Jedilna miza SKOVLUNDE 90x200 hrast',
        category: 'Stoli & Mize',
        location: 'Regal M-02 / M-03',
        quantity: 8,
        minQuantity: 2,
        unit: 'garnitura',
        boxInfo: 'Box 1/2',
        boxTotal: 2,
        boxes: {
          1: { count: 8, location: 'Regal M-02 (plošča)' },
          2: { count: 8, location: 'Regal M-03 (noge & okovje)' }
        },
        piecesPerBox: 1,
        notes: 'Garnitura iz 2 škatel'
      },
      {
        sku: '3681401',
        name: 'Garderobna omara TARP 3 vrata bela',
        category: 'Omarice & Mizice',
        location: 'Regal G-01 / G-02 / G-03',
        quantity: 3,
        minQuantity: 2,
        unit: 'garnitura',
        boxInfo: 'Box 1/3',
        boxTotal: 3,
        boxes: {
          1: { count: 3, location: 'Regal G-01 (stranice)' },
          2: { count: 3, location: 'Regal G-02 (police)' },
          3: { count: 3, location: 'Regal G-03 (vrata z ogledalom)' }
        },
        piecesPerBox: 1,
        notes: 'Velika omara 150x200 cm, 3 škatle'
      },

      // Več-škatelni artikli: NEPOPOLNE ŠKATLE (samo en del škatel / manjkajo deli)
      {
        sku: '3698710',
        name: 'Posteljni okvir ABILD 160x200 hrast',
        category: 'Vzmetnice & Nadvložki',
        location: 'Regal P-01 / P-02',
        quantity: 2,
        minQuantity: 2,
        unit: 'garnitura',
        boxInfo: 'Box 1/2',
        boxTotal: 2,
        boxes: {
          1: { count: 5, location: 'Regal P-01 (vzglavje)' },
          2: { count: 2, location: 'Regal P-02 (okvir & stranice)' }
        },
        piecesPerBox: 1,
        notes: '⚠️ 2 cela kompleta, 3x Box 1/2 je viška (manjka 3x Box 2/2)'
      },
      {
        sku: '3620095',
        name: 'Pisarniška miza TAMHOLT bela/hrast',
        category: 'Omarice & Mizice',
        location: 'Regal D-05',
        quantity: 0,
        minQuantity: 2,
        unit: 'garnitura',
        boxInfo: 'Box 1/2',
        boxTotal: 2,
        boxes: {
          1: { count: 4, location: 'Regal D-05 (mizna plošča)' },
          2: { count: 0, location: 'Ni na zalogi' }
        },
        piecesPerBox: 1,
        notes: '⚠️ 0 celih kompletov! Na zalogi 4x Box 1/2, manjka 4x Box 2/2'
      },

      // Artikli s skeniranega računa kupca (s prikazom delitve škatel na več regalov)
      {
        sku: '3618930',
        name: 'Predalnik LIMFJORDEN 4 predali bela',
        category: 'Omarice & Mizice',
        location: 'Regal P-04 / Regal P-09 / Regal P-05',
        quantity: 6,
        minQuantity: 2,
        unit: 'garnitura',
        boxInfo: 'Box 1/2',
        boxTotal: 2,
        boxes: {
          1: {
            count: 6,
            location: 'Regal P-04 (4 kos) / Regal P-09 (2 kos)',
            locations: [
              { name: 'Regal P-04 (ogrodje & stranice)', count: 4, isPrimary: true },
              { name: 'Regal P-09 (preliv/rezerva)', count: 2, isPrimary: false }
            ]
          },
          2: {
            count: 6,
            location: 'Regal P-05 (predali & vodila)',
            locations: [
              { name: 'Regal P-05 (predali & vodila)', count: 6, isPrimary: true }
            ]
          }
        },
        piecesPerBox: 1,
        notes: 'JYSK Predalnik LIMFJORDEN (Škatla 1/2 razdeljena na P-04 in P-09 rezervo)'
      },
      {
        sku: '3670619',
        name: 'DIVERSES',
        category: 'Splošno',
        location: 'Regal D-01',
        quantity: 8,
        minQuantity: 2,
        unit: 'kos',
        boxInfo: 'Box 1/1',
        boxTotal: 1,
        boxes: {
          1: {
            count: 8,
            location: 'Regal D-01 (polica 2)',
            locations: [
              { name: 'Regal D-01 (polica 2)', count: 8, isPrimary: true }
            ]
          }
        },
        piecesPerBox: 1,
        notes: 'Razna oprema DIVERSES'
      }
    ];

    for (const item of demoItems) {
      await this.addItem(item);
    }
    return true;
  },

  /**
   * Preveri in po potrebi zagotovi obstoj artiklov z računa, da se takoj prikažejo pravilni regali
   */
  async ensureReceiptDemoItems() {
    const limfjorden = {
      sku: '3618930',
      name: 'Predalnik LIMFJORDEN 4 predali bela',
      category: 'Omarice & Mizice',
      location: 'Regal P-04 / Regal P-09 / Regal P-05',
      quantity: 6,
      minQuantity: 2,
      unit: 'garnitura',
      boxInfo: 'Box 1/2',
      boxTotal: 2,
      boxes: {
        1: {
          count: 6,
          location: 'Regal P-04 (4 kos) / Regal P-09 (2 kos)',
          locations: [
            { name: 'Regal P-04 (ogrodje & stranice)', count: 4, isPrimary: true },
            { name: 'Regal P-09 (preliv/rezerva)', count: 2, isPrimary: false }
          ]
        },
        2: {
          count: 6,
          location: 'Regal P-05 (predali & vodila)',
          locations: [
            { name: 'Regal P-05 (predali & vodila)', count: 6, isPrimary: true }
          ]
        }
      },
      piecesPerBox: 1,
      notes: 'JYSK Predalnik LIMFJORDEN (Škatla 1/2 razdeljena na P-04 in P-09 rezervo)'
    };

    const diverses = {
      sku: '3670619',
      name: 'DIVERSES',
      category: 'Splošno',
      location: 'Regal D-01',
      quantity: 8,
      minQuantity: 2,
      unit: 'kos',
      boxInfo: 'Box 1/1',
      boxTotal: 1,
      boxes: {
        1: {
          count: 8,
          location: 'Regal D-01 (polica 2)',
          locations: [
            { name: 'Regal D-01 (polica 2)', count: 8, isPrimary: true }
          ]
        }
      },
      piecesPerBox: 1,
      notes: 'Razna oprema DIVERSES'
    };

    const existing1 = await this.getItemBySKU(limfjorden.sku);
    if (!existing1) {
      await this.addItem(limfjorden);
    } else if (!existing1.boxes[1]?.locations || existing1.boxes[1].locations.length < 2) {
      existing1.boxes = limfjorden.boxes;
      existing1.location = limfjorden.location;
      await this.updateItem(existing1);
    }

    const existing2 = await this.getItemBySKU(diverses.sku);
    if (!existing2) {
      await this.addItem(diverses);
    }
  },

  /**
   * Uveljavi rezultate inventurnega popisa v IndexedDB (posodobi zalogo postavk in zabeleži v dnevnik logs)
   * @param {Array} auditEntries - Seznam { itemId, boxNum, locName, bookQty, countedQty, isCounted }
   */
  async applyAuditResults(auditEntries) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['items', 'logs'], 'readwrite');
      const itemStore = tx.objectStore('items');
      const logStore = tx.objectStore('logs');

      const getReq = itemStore.getAll();
      getReq.onsuccess = () => {
        const allItems = getReq.result || [];
        const itemMap = new Map();
        allItems.forEach(i => itemMap.set(i.id, normalizeItemBoxes(i)));

        let modifiedItemsCount = 0;
        let totalAdjustments = 0;
        const modifiedItemIds = new Set();

        for (const entry of auditEntries) {
          if (!entry.isCounted) continue;
          const book = Number(entry.bookQty) || 0;
          const counted = Math.max(0, Number(entry.countedQty) || 0);
          const diff = counted - book;
          if (diff === 0) continue;

          const item = itemMap.get(Number(entry.itemId));
          if (!item) continue;

          const bNum = Number(entry.boxNum) || 1;
          if (!item.boxes[bNum]) continue;

          const bObj = item.boxes[bNum];
          const locs = bObj.locations || [];
          const cleanLoc = String(entry.locName || '').trim().toLowerCase();
          const targetLoc = locs.find(l => l.name.trim().toLowerCase() === cleanLoc);

          if (targetLoc) {
            targetLoc.count = counted;
          } else if (locs.length > 0) {
            locs[0].count = counted;
          } else {
            locs.push({
              name: entry.locName || item.location || 'Brez lokacije',
              count: counted,
              isPrimary: true
            });
          }

          // Posodobi seštevek škatle in lokacije
          item.boxes[bNum] = normalizeBoxLocations(bObj, entry.locName || item.location || 'Brez lokacije');

          // Preračun celih kompletov
          const stats = this.getBoxStats(item);
          item.quantity = stats.completeSets;
          item.lastUpdated = new Date().toISOString();

          logStore.add({
            itemId: item.id,
            sku: item.sku,
            itemName: item.name,
            changeType: 'audit',
            changeAmount: diff,
            resultingQty: item.quantity,
            note: `Inventura: Škatla ${bNum}/${item.boxTotal} (${entry.locName || 'Privzeta lokacija'}) knjižno ${book} -> prešteto ${counted} (razlika: ${diff > 0 ? '+' : ''}${diff})`,
            timestamp: new Date().toISOString()
          });

          modifiedItemIds.add(item.id);
          totalAdjustments++;
        }

        // Shranimo posodobljene artikle
        modifiedItemIds.forEach(id => {
          const item = itemMap.get(id);
          if (item) {
            itemStore.put(item);
            modifiedItemsCount++;
          }
        });

        tx.oncomplete = () => resolve({
          success: true,
          modifiedItemsCount,
          totalAdjustments
        });
        tx.onerror = () => reject(tx.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  },

  /**
   * Pametno združi prejeto sinhronizacijsko pošiljko (Quick Share / Nearby Share)
   * - Samodejno doda vse nove artikle s policami in škatlami
   * - Samodejno posodobi obstoječa stanja (vključno z vsemi izvedenimi izdajami)
   * - Združi dnevnik premikov brez podvajanja
   */
  async mergeSyncData(syncPayload) {
    if (!syncPayload || !Array.isArray(syncPayload.items)) {
      throw new Error('Neveljavna datoteka za sinhronizacijo.');
    }

    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['items', 'logs'], 'readwrite');
      const itemStore = tx.objectStore('items');
      const logStore = tx.objectStore('logs');

      const getItemsReq = itemStore.getAll();
      const getLogsReq = logStore.getAll();

      let existingItems = [];
      let existingLogs = [];
      let readyCount = 0;

      const onReady = () => {
        readyCount++;
        if (readyCount < 2) return;

        const itemMap = new Map();
        existingItems.forEach(i => itemMap.set(String(i.sku).trim(), normalizeItemBoxes(i)));

        let addedCount = 0;
        let updatedCount = 0;
        let decreasedCount = 0;
        const addedItemNames = [];

        for (const incoming of syncPayload.items) {
          if (!incoming || !incoming.sku) continue;
          const skuKey = String(incoming.sku).trim();
          const normIncoming = normalizeItemBoxes(incoming);

          if (!itemMap.has(skuKey)) {
            // Popolnoma nov artikel!
            delete normIncoming.id;
            itemStore.add(normIncoming);
            addedCount++;
            addedItemNames.push(normIncoming.name || normIncoming.sku);
          } else {
            // Obstoječ artikel: posodobimo stanja na policah in škatlah
            const localItem = itemMap.get(skuKey);
            const oldQty = localItem.quantity;

            localItem.name = normIncoming.name || localItem.name;
            localItem.category = normIncoming.category || localItem.category;
            localItem.boxTotal = normIncoming.boxTotal || localItem.boxTotal;
            localItem.boxInfo = normIncoming.boxInfo || localItem.boxInfo;
            localItem.unit = normIncoming.unit || localItem.unit;
            localItem.notes = normIncoming.notes || localItem.notes;
            localItem.location = normIncoming.location || localItem.location;
            localItem.boxes = normIncoming.boxes;
            localItem.quantity = normIncoming.quantity;
            localItem.lastUpdated = normIncoming.lastUpdated || new Date().toISOString();

            itemStore.put(localItem);
            updatedCount++;
            if (localItem.quantity < oldQty) {
              decreasedCount++;
            }
          }
        }

        // Združitev zgodovine premikov (dnevnik)
        const existingTimestamps = new Set(existingLogs.map(l => l.timestamp));
        let addedLogsCount = 0;

        if (Array.isArray(syncPayload.logs)) {
          for (const incomingLog of syncPayload.logs) {
            if (!incomingLog || !incomingLog.timestamp) continue;
            if (!existingTimestamps.has(incomingLog.timestamp)) {
              delete incomingLog.id;
              logStore.add(incomingLog);
              existingTimestamps.add(incomingLog.timestamp);
              addedLogsCount++;
            }
          }
        }

        tx.oncomplete = () => {
          resolve({
            addedCount,
            updatedCount,
            decreasedCount,
            addedLogsCount,
            addedItemNames,
            totalIncoming: syncPayload.items.length
          });
        };
        tx.onerror = () => reject(tx.error);
      };

      getItemsReq.onsuccess = () => {
        existingItems = getItemsReq.result || [];
        onReady();
      };
      getItemsReq.onerror = () => reject(getItemsReq.error);

      getLogsReq.onsuccess = () => {
        existingLogs = getLogsReq.result || [];
        onReady();
      };
      getLogsReq.onerror = () => reject(getLogsReq.error);
    });
  }
};
