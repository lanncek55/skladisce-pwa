/**
 * db.js - Normaliziran IndexedDB modul za vodenje zalog skladišča
 * Razdeljen na 3 vitke tabele:
 * 1. articles (Šifrant artiklov - ključ je SKU)
 * 2. stock_locations (Ploščata zaloga po škatlah in regalih)
 * 3. logs (Zgodovina premikov in izdaj)
 */

const DB_NAME = 'SkladisceDB';
const DB_VERSION = 3; // Popolnoma sveža, vitka 3-tabelna arhitektura (articles, stock_locations, logs)

let dbInstance = null;

function openDB() {
  if (dbInstance) return Promise.resolve(dbInstance);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      // Popolnoma odstranimo staro zapleteno tabelo 'items'
      if (db.objectStoreNames.contains('items')) {
        db.deleteObjectStore('items');
      }

      // 1. Tabela artiklov (Katalog / Šifrant artiklov)
      if (!db.objectStoreNames.contains('articles')) {
        const articleStore = db.createObjectStore('articles', { keyPath: 'sku' });
        articleStore.createIndex('name', 'name', { unique: false });
        articleStore.createIndex('category', 'category', { unique: false });
      }

      // 2. Tabela lokacij in zaloge (Ploščata zaloga po škatlah in regalih)
      if (!db.objectStoreNames.contains('stock_locations')) {
        const stockStore = db.createObjectStore('stock_locations', { keyPath: 'id' });
        stockStore.createIndex('sku', 'sku', { unique: false });
        stockStore.createIndex('shelf', 'shelf', { unique: false });
        stockStore.createIndex('boxNum', 'boxNum', { unique: false });
      }

      // 3. Tabela premikov (Zgodovina / Dnevnik)
      if (!db.objectStoreNames.contains('logs')) {
        const logStore = db.createObjectStore('logs', { keyPath: 'id', autoIncrement: true });
        logStore.createIndex('sku', 'sku', { unique: false });
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

  /**
   * Sestavi enoten objekt artikla iz tabele 'articles' in pripadajočih vrstic 'stock_locations'
   */
  buildItemFromArticleAndStocks(art, stocks = []) {
    const sku = String(art.sku || '').trim();
    const boxTotal = Math.max(1, parseInt(art.boxTotal, 10) || 1);
    const boxes = {};
    const boxCounts = [];

    const byBox = new Map();
    for (let b = 1; b <= boxTotal; b++) byBox.set(b, []);
    for (const s of stocks) {
      const bNum = Math.min(boxTotal, Math.max(1, parseInt(s.boxNum, 10) || 1));
      if (!byBox.has(bNum)) byBox.set(bNum, []);
      byBox.get(bNum).push(s);
    }

    let primaryShelf = 'Brez lokacije';

    for (let b = 1; b <= boxTotal; b++) {
      const locList = byBox.get(b) || [];
      const formattedLocs = locList.map(l => ({
        name: l.shelf || 'Brez lokacije',
        count: Math.max(0, Number(l.count) || 0),
        isPrimary: !!l.isPrimary
      }));

      if (formattedLocs.length === 0) {
        formattedLocs.push({ name: 'Brez lokacije', count: 0, isPrimary: true });
      }

      const totalCount = formattedLocs.reduce((sum, l) => sum + l.count, 0);
      boxCounts.push(totalCount);

      const activePrimary = formattedLocs.find(l => l.isPrimary) || formattedLocs[0];
      if (b === 1 && activePrimary && activePrimary.name !== 'Brez lokacije') {
        primaryShelf = activePrimary.name;
      }

      const summary = formattedLocs.length <= 1
        ? (formattedLocs[0]?.name || 'Brez lokacije')
        : formattedLocs.map(l => `${l.name} (${l.count} kos)`).join(' / ');

      boxes[b] = {
        count: totalCount,
        location: summary,
        locations: formattedLocs
      };
    }

    const completeSets = (boxTotal > 1) ? Math.min(...boxCounts) : (boxCounts[0] || 0);

    return {
      id: sku, // SKU je primarni identifikator artikla
      sku: sku,
      name: art.name || `Artikel ${sku}`,
      category: art.category || 'Splošno',
      boxTotal: boxTotal,
      boxInfo: `Box 1/${boxTotal}`,
      minQuantity: Number(art.minQuantity) || 0,
      unit: art.unit || (boxTotal > 1 ? 'garnitura' : 'kos'),
      notes: art.notes || '',
      lastUpdated: art.lastUpdated || new Date().toISOString(),
      location: primaryShelf,
      quantity: completeSets,
      boxes: boxes
    };
  },

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

  /**
   * Vrne vse artikle s popolnimi podatki o zalogah po regalih
   */
  async getAllItems() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['articles', 'stock_locations'], 'readonly');
      const articleStore = tx.objectStore('articles');
      const stockStore = tx.objectStore('stock_locations');

      const articlesReq = articleStore.getAll();
      const stockReq = stockStore.getAll();

      let articles = [];
      let stocks = [];
      let ready = 0;

      const finish = () => {
        ready++;
        if (ready < 2) return;

        const stockMap = new Map();
        for (const s of stocks) {
          const sku = String(s.sku || '').trim();
          if (!stockMap.has(sku)) stockMap.set(sku, []);
          stockMap.get(sku).push(s);
        }

        const items = articles.map(art => {
          const sku = String(art.sku || '').trim();
          const artStocks = stockMap.get(sku) || [];
          return DB.buildItemFromArticleAndStocks(art, artStocks);
        });

        resolve(items);
      };

      articlesReq.onsuccess = () => { articles = articlesReq.result || []; finish(); };
      articlesReq.onerror = () => reject(articlesReq.error);

      stockReq.onsuccess = () => { stocks = stockReq.result || []; finish(); };
      stockReq.onerror = () => reject(stockReq.error);
    });
  },

  async getItemById(id) {
    if (!id) return null;
    return this.getItemBySKU(String(id).trim());
  },

  async getItemBySKU(sku) {
    if (!sku) return null;
    const cleanSku = String(sku).trim();
    const db = await openDB();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(['articles', 'stock_locations'], 'readonly');
      const articleStore = tx.objectStore('articles');
      const stockStore = tx.objectStore('stock_locations');

      const artReq = articleStore.get(cleanSku);
      const stockIndex = stockStore.index('sku');
      const stockReq = stockIndex.getAll(cleanSku);

      let article = null;
      let stocks = [];
      let ready = 0;

      const finish = () => {
        ready++;
        if (ready < 2) return;
        if (!article) {
          resolve(null);
          return;
        }
        resolve(DB.buildItemFromArticleAndStocks(article, stocks));
      };

      artReq.onsuccess = () => { article = artReq.result || null; finish(); };
      artReq.onerror = () => reject(artReq.error);

      stockReq.onsuccess = () => { stocks = stockReq.result || []; finish(); };
      stockReq.onerror = () => reject(stockReq.error);
    });
  },

  /**
   * Dodajanje ali združevanje artikla (SKU je enolični ključ)
   */
  async addItem(itemData) {
    const cleanSku = String(itemData.sku || '').trim();
    if (!cleanSku) throw new Error('Šifra artikla (SKU) je obvezna.');

    const db = await openDB();
    const boxTotal = Math.max(1, parseInt(itemData.boxTotal, 10) || 1);

    return new Promise((resolve, reject) => {
      const tx = db.transaction(['articles', 'stock_locations', 'logs'], 'readwrite');
      const artStore = tx.objectStore('articles');
      const stockStore = tx.objectStore('stock_locations');
      const logStore = tx.objectStore('logs');

      const checkReq = artStore.get(cleanSku);
      checkReq.onsuccess = () => {
        const existing = checkReq.result;
        const wasMerged = !!existing;

        const artRecord = {
          sku: cleanSku,
          name: String(itemData.name || '').trim() || (existing ? existing.name : `Artikel ${cleanSku}`),
          category: String(itemData.category || 'Splošno').trim(),
          boxTotal: Math.max(boxTotal, existing ? existing.boxTotal : 1),
          minQuantity: Number(itemData.minQuantity) || (existing ? existing.minQuantity : 0),
          unit: String(itemData.unit || (boxTotal > 1 ? 'garnitura' : 'kos')).trim(),
          notes: String(itemData.notes || '').trim() || (existing ? existing.notes : ''),
          lastUpdated: new Date().toISOString()
        };

        artStore.put(artRecord);

        if (itemData.boxes && typeof itemData.boxes === 'object') {
          for (let b = 1; b <= artRecord.boxTotal; b++) {
            const bData = itemData.boxes[b];
            if (!bData) continue;
            const locs = (Array.isArray(bData.locations) && bData.locations.length > 0)
              ? bData.locations
              : [{ name: bData.location || itemData.location || 'Brez lokacije', count: bData.count || 0, isPrimary: true }];

            for (const loc of locs) {
              const shelfName = String(loc.name || 'Brez lokacije').trim();
              const locId = `${cleanSku}_b${b}_${shelfName}`;

              const getLocReq = stockStore.get(locId);
              getLocReq.onsuccess = () => {
                const prev = getLocReq.result;
                const newCount = prev ? (prev.count + (Number(loc.count) || 0)) : (Number(loc.count) || 0);
                stockStore.put({
                  id: locId,
                  sku: cleanSku,
                  boxNum: b,
                  shelf: shelfName,
                  count: Math.max(0, newCount),
                  isPrimary: !!loc.isPrimary,
                  lastUpdated: new Date().toISOString()
                });
              };
            }
          }
        } else {
          const shelfName = String(itemData.location || 'Brez lokacije').trim();
          const locId = `${cleanSku}_b1_${shelfName}`;
          const count = Number(itemData.quantity) || 0;
          stockStore.put({
            id: locId,
            sku: cleanSku,
            boxNum: 1,
            shelf: shelfName,
            count: count,
            isPrimary: true,
            lastUpdated: new Date().toISOString()
          });
        }

        logStore.add({
          sku: cleanSku,
          itemName: artRecord.name,
          changeType: wasMerged ? 'in' : 'create',
          changeAmount: Number(itemData.quantity) || 0,
          resultingQty: Number(itemData.quantity) || 0,
          note: wasMerged ? 'Združitev zaloge ob ponovnem vnosu' : `Začetni vnos (${artRecord.boxTotal} škatel)`,
          timestamp: new Date().toISOString()
        });

        tx.oncomplete = () => {
          resolve({ id: cleanSku, sku: cleanSku, wasMerged });
        };
        tx.onerror = () => reject(tx.error);
      };
      checkReq.onerror = () => reject(checkReq.error);
    });
  },

  /**
   * Posodobitev obstoječega artikla
   */
  async updateItem(itemData) {
    const cleanSku = String(itemData.sku || '').trim();
    if (!cleanSku) throw new Error('Šifra artikla (SKU) je obvezna.');

    const db = await openDB();
    const boxTotal = Math.max(1, parseInt(itemData.boxTotal, 10) || 1);

    return new Promise((resolve, reject) => {
      const tx = db.transaction(['articles', 'stock_locations'], 'readwrite');
      const artStore = tx.objectStore('articles');
      const stockStore = tx.objectStore('stock_locations');

      const artRecord = {
        sku: cleanSku,
        name: String(itemData.name || '').trim(),
        category: String(itemData.category || 'Splošno').trim(),
        boxTotal: boxTotal,
        minQuantity: Number(itemData.minQuantity) || 0,
        unit: String(itemData.unit || (boxTotal > 1 ? 'garnitura' : 'kos')).trim(),
        notes: String(itemData.notes || '').trim(),
        lastUpdated: new Date().toISOString()
      };
      artStore.put(artRecord);

      const stockIndex = stockStore.index('sku');
      const getExistingStocks = stockIndex.getAll(cleanSku);

      getExistingStocks.onsuccess = () => {
        const existingStocks = getExistingStocks.result || [];
        existingStocks.forEach(s => stockStore.delete(s.id));

        if (itemData.boxes && typeof itemData.boxes === 'object') {
          for (let b = 1; b <= boxTotal; b++) {
            const bData = itemData.boxes[b];
            if (!bData) continue;
            const locs = (Array.isArray(bData.locations) && bData.locations.length > 0)
              ? bData.locations
              : [{ name: bData.location || itemData.location || 'Brez lokacije', count: bData.count || 0, isPrimary: true }];

            locs.forEach((loc, idx) => {
              const shelfName = String(loc.name || 'Brez lokacije').trim();
              stockStore.put({
                id: `${cleanSku}_b${b}_${shelfName}`,
                sku: cleanSku,
                boxNum: b,
                shelf: shelfName,
                count: Math.max(0, Number(loc.count) || 0),
                isPrimary: loc.isPrimary !== undefined ? !!loc.isPrimary : (idx === 0),
                lastUpdated: new Date().toISOString()
              });
            });
          }
        } else {
          const shelfName = String(itemData.location || 'Brez lokacije').trim();
          stockStore.put({
            id: `${cleanSku}_b1_${shelfName}`,
            sku: cleanSku,
            boxNum: 1,
            shelf: shelfName,
            count: Number(itemData.quantity) || 0,
            isPrimary: true,
            lastUpdated: new Date().toISOString()
          });
        }
      };

      tx.oncomplete = () => resolve(cleanSku);
      tx.onerror = () => reject(tx.error);
    });
  },

  async deleteItem(sku) {
    const cleanSku = String(sku).trim();
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['articles', 'stock_locations', 'logs'], 'readwrite');
      const artStore = tx.objectStore('articles');
      const stockStore = tx.objectStore('stock_locations');
      const logStore = tx.objectStore('logs');

      const artReq = artStore.get(cleanSku);
      artReq.onsuccess = () => {
        const art = artReq.result;
        if (art) {
          logStore.add({
            sku: cleanSku,
            itemName: art.name,
            changeType: 'delete',
            changeAmount: 0,
            resultingQty: 0,
            note: 'Izbris artikla iz zaloge',
            timestamp: new Date().toISOString()
          });
          artStore.delete(cleanSku);
        }

        const stockIndex = stockStore.index('sku');
        const stocksReq = stockIndex.getAll(cleanSku);
        stocksReq.onsuccess = () => {
          (stocksReq.result || []).forEach(s => stockStore.delete(s.id));
        };
      };

      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  },

  /**
   * Sprememba zaloge posamezne škatle na regalu
   */
  async adjustStock(sku, delta, note = '', type = 'adjust', boxNum = null, shelf = null) {
    const cleanSku = String(sku).trim();
    const db = await openDB();
    const bNum = boxNum ? Math.max(1, parseInt(boxNum, 10)) : 1;

    return new Promise((resolve, reject) => {
      const tx = db.transaction(['articles', 'stock_locations', 'logs'], 'readwrite');
      const artStore = tx.objectStore('articles');
      const stockStore = tx.objectStore('stock_locations');
      const logStore = tx.objectStore('logs');

      const artReq = artStore.get(cleanSku);
      artReq.onsuccess = () => {
        const art = artReq.result;
        if (!art) {
          reject(new Error(`Artikel s šifro ${cleanSku} ne obstaja.`));
          return;
        }

        const stockIndex = stockStore.index('sku');
        const stocksReq = stockIndex.getAll(cleanSku);

        stocksReq.onsuccess = () => {
          const stocks = stocksReq.result || [];
          const boxStocks = stocks.filter(s => s.boxNum === bNum);

          let targetStock = null;
          if (shelf) {
            const cleanShelf = String(shelf).trim();
            targetStock = boxStocks.find(s => s.shelf.toLowerCase() === cleanShelf.toLowerCase());
            if (!targetStock) {
              targetStock = {
                id: `${cleanSku}_b${bNum}_${cleanShelf}`,
                sku: cleanSku,
                boxNum: bNum,
                shelf: cleanShelf,
                count: 0,
                isPrimary: boxStocks.length === 0,
                lastUpdated: new Date().toISOString()
              };
              stocks.push(targetStock);
            }
          } else {
            targetStock = boxStocks.find(s => s.isPrimary) || boxStocks[0];
            if (!targetStock) {
              targetStock = {
                id: `${cleanSku}_b${bNum}_Regal Glavni`,
                sku: cleanSku,
                boxNum: bNum,
                shelf: 'Regal Glavni',
                count: 0,
                isPrimary: true,
                lastUpdated: new Date().toISOString()
              };
              stocks.push(targetStock);
            }
          }

          if (delta >= 0) {
            targetStock.count += Number(delta);
          } else {
            let toRemove = Math.abs(Number(delta));
            if (targetStock.count >= toRemove) {
              targetStock.count -= toRemove;
            } else {
              toRemove -= targetStock.count;
              targetStock.count = 0;
              for (const other of boxStocks) {
                if (other !== targetStock && other.count > 0 && toRemove > 0) {
                  const take = Math.min(other.count, toRemove);
                  other.count -= take;
                  toRemove -= take;
                  stockStore.put(other);
                }
              }
            }
          }

          targetStock.lastUpdated = new Date().toISOString();
          stockStore.put(targetStock);

          const updatedItem = DB.buildItemFromArticleAndStocks(art, stocks);

          logStore.add({
            sku: cleanSku,
            itemName: art.name,
            boxNum: bNum,
            shelf: targetStock.shelf,
            changeType: type,
            changeAmount: Number(delta),
            resultingQty: updatedItem.quantity,
            note: (note || (delta >= 0 ? 'Prevzem škatle' : 'Izdaja škatle')) + (art.boxTotal > 1 ? ` (Šk. ${bNum}/${art.boxTotal} @ ${targetStock.shelf})` : ` (@ ${targetStock.shelf})`),
            timestamp: new Date().toISOString()
          });

          tx.oncomplete = () => resolve(updatedItem);
        };
      };
      artReq.onerror = () => reject(artReq.error);
    });
  },

  /**
   * Izdaja celotne garniture (odšteje škatle iz vseh potrebnih regalov)
   */
  async issueCompleteItem(sku, qty = 1, note = '') {
    const cleanSku = String(sku).trim();
    const issueQty = Math.max(1, Number(qty) || 1);
    const db = await openDB();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(['articles', 'stock_locations', 'logs'], 'readwrite');
      const artStore = tx.objectStore('articles');
      const stockStore = tx.objectStore('stock_locations');
      const logStore = tx.objectStore('logs');

      const artReq = artStore.get(cleanSku);
      artReq.onsuccess = () => {
        const art = artReq.result;
        if (!art) {
          reject(new Error(`Artikel s šifro ${cleanSku} ne obstaja.`));
          return;
        }

        const boxTotal = Math.max(1, art.boxTotal || 1);
        const stockIndex = stockStore.index('sku');
        const stocksReq = stockIndex.getAll(cleanSku);

        stocksReq.onsuccess = () => {
          const stocks = stocksReq.result || [];
          const pickDetails = [];

          for (let b = 1; b <= boxTotal; b++) {
            let remaining = issueQty;
            const boxStocks = stocks.filter(s => s.boxNum === b);
            for (const s of boxStocks) {
              if (remaining <= 0) break;
              if (s.count > 0) {
                const take = Math.min(s.count, remaining);
                s.count -= take;
                remaining -= take;
                s.lastUpdated = new Date().toISOString();
                stockStore.put(s);
                pickDetails.push(`Šk.${b}: ${take}x iz ${s.shelf}`);
              }
            }
          }

          const updatedItem = DB.buildItemFromArticleAndStocks(art, stocks);

          logStore.add({
            sku: cleanSku,
            itemName: art.name,
            changeType: 'out',
            changeAmount: -issueQty,
            resultingQty: updatedItem.quantity,
            note: (note || 'Izdaja po računu') + ` (-${issueQty}x garnitura [${pickDetails.join(', ')}], preostalo: ${updatedItem.quantity})`,
            timestamp: new Date().toISOString()
          });

          tx.oncomplete = () => resolve(updatedItem);
        };
      };
      artReq.onerror = () => reject(artReq.error);
    });
  },

  /**
   * Premestitev zaloge posamezne škatle med dvema regaloma (brez spremembe celotne zaloge)
   */
  async moveStock(sku, boxNum, fromShelf, toShelf, amount, note = '') {
    const cleanSku = String(sku).trim();
    const bNum = Math.max(1, parseInt(boxNum, 10) || 1);
    const moveQty = Math.max(1, parseInt(amount, 10) || 1);
    const fromS = String(fromShelf).trim();
    const toS = String(toShelf).trim();

    if (!fromS || !toS) throw new Error('Izvorna in ciljna lokacija sta obvezni.');
    if (fromS.toLowerCase() === toS.toLowerCase()) throw new Error('Izvorna in ciljna lokacija ne moreta biti enaki.');

    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['articles', 'stock_locations', 'logs'], 'readwrite');
      const artStore = tx.objectStore('articles');
      const stockStore = tx.objectStore('stock_locations');
      const logStore = tx.objectStore('logs');

      const artReq = artStore.get(cleanSku);
      artReq.onsuccess = () => {
        const art = artReq.result;
        if (!art) {
          reject(new Error(`Artikel s šifro ${cleanSku} ne obstaja.`));
          return;
        }

        const fromId = `${cleanSku}_b${bNum}_${fromS}`;
        const toId = `${cleanSku}_b${bNum}_${toS}`;

        const fromReq = stockStore.get(fromId);
        fromReq.onsuccess = () => {
          const fromLoc = fromReq.result;
          if (!fromLoc || fromLoc.count < moveQty) {
            reject(new Error(`Na lokaciji "${fromS}" ni dovolj zaloge (na voljo: ${fromLoc ? fromLoc.count : 0}, premakniti želite: ${moveQty}).`));
            return;
          }

          fromLoc.count -= moveQty;
          fromLoc.lastUpdated = new Date().toISOString();
          stockStore.put(fromLoc);

          const toReq = stockStore.get(toId);
          toReq.onsuccess = () => {
            const toLoc = toReq.result || {
              id: toId,
              sku: cleanSku,
              boxNum: bNum,
              shelf: toS,
              count: 0,
              isPrimary: false,
              lastUpdated: new Date().toISOString()
            };

            toLoc.count += moveQty;
            toLoc.lastUpdated = new Date().toISOString();
            stockStore.put(toLoc);

            logStore.add({
              sku: cleanSku,
              itemName: art.name,
              boxNum: bNum,
              shelf: `${fromS} ➔ ${toS}`,
              changeType: 'adjust',
              changeAmount: 0,
              resultingQty: 0,
              note: (note || 'Premestitev med regali') + ` (${moveQty}x Šk.${bNum} iz ${fromS} na ${toS})`,
              timestamp: new Date().toISOString()
            });
          };
        };
      };

      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
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

  /**
   * Izbriše vse artikle in zaloge po regalih iz skladišča
   */
  async clearAllItems() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['articles', 'stock_locations', 'logs'], 'readwrite');
      const artStore = tx.objectStore('articles');
      const stockStore = tx.objectStore('stock_locations');
      const logStore = tx.objectStore('logs');

      artStore.clear();
      stockStore.clear();

      logStore.add({
        sku: 'SYS-CLEAR',
        itemName: 'Baza artiklov izpraznjena',
        changeType: 'delete',
        changeAmount: 0,
        resultingQty: 0,
        note: 'Izbris vseh artiklov in lokacij iz skladišča',
        timestamp: new Date().toISOString()
      });

      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  },

  /**
   * Uveljavi rezultate inventure v stock_locations
   */
  async applyAuditResults(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return { totalAdjustments: 0 };
    const db = await openDB();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(['articles', 'stock_locations', 'logs'], 'readwrite');
      const stockStore = tx.objectStore('stock_locations');
      const logStore = tx.objectStore('logs');

      let adjustments = 0;

      for (const entry of entries) {
        if (!entry.isCounted) continue;
        const counted = Math.max(0, parseInt(entry.countedQty, 10) || 0);
        const book = Math.max(0, parseInt(entry.bookQty, 10) || 0);
        const diff = counted - book;
        if (diff === 0) continue;

        const locId = `${entry.sku}_b${entry.boxNum}_${entry.locName}`;
        stockStore.put({
          id: locId,
          sku: entry.sku,
          boxNum: entry.boxNum,
          shelf: entry.locName,
          count: counted,
          isPrimary: true,
          lastUpdated: new Date().toISOString()
        });

        logStore.add({
          sku: entry.sku,
          itemName: entry.name,
          boxNum: entry.boxNum,
          shelf: entry.locName,
          changeType: 'adjust',
          changeAmount: diff,
          resultingQty: counted,
          note: `Inventurna izravnava (knjižno: ${book}, prešteto: ${counted}, razlika: ${diff > 0 ? '+' : ''}${diff})`,
          timestamp: new Date().toISOString()
        });

        adjustments++;
      }

      tx.oncomplete = () => resolve({ totalAdjustments: adjustments });
      tx.onerror = () => reject(tx.error);
    });
  },

  /**
   * Deduplikacija artiklov (v normalizirani bazi je SKU primarni ključ)
   */
  async deduplicateItems() {
    return {
      mergedGroupsCount: 0,
      removedDuplicatesCount: 0,
      affectedSkus: []
    };
  },

  async seedDemoData() {
    const demoArticles = [
      {
        sku: '3600123',
        name: 'Vrtni stol MELLBY jeklo/tekstilen črna',
        category: 'Vrtno pohištvo',
        boxTotal: 1,
        minQuantity: 4,
        unit: 'kos',
        shelf: 'Regal A-01',
        count: 12,
        notes: 'Enodelni stol, zložljiv'
      },
      {
        sku: '3600456',
        name: 'Vrtna miza SANDVIG Š82xD140 siva',
        category: 'Vrtno pohištvo',
        boxTotal: 1,
        minQuantity: 2,
        unit: 'kos',
        shelf: 'Regal A-03',
        count: 1,
        notes: 'Zadnji kos na zalogi'
      },
      {
        sku: '3651003',
        name: 'Garderobna omara TARP 3 vrata bela',
        category: 'Pohištvo',
        boxTotal: 3,
        minQuantity: 1,
        unit: 'garnitura',
        notes: 'Velika omara 150x200 cm, 3 škatle',
        boxes: [
          { boxNum: 1, shelf: 'Regal G-01 (ogrodje)', count: 3 },
          { boxNum: 2, shelf: 'Regal G-02 (police)', count: 3 },
          { boxNum: 3, shelf: 'Regal G-03 (vrata z ogledalom)', count: 3 }
        ]
      },
      {
        sku: '3698710',
        name: 'Posteljni okvir ABILD 160x200 hrast',
        category: 'Vzmetnice & Nadvložki',
        boxTotal: 2,
        minQuantity: 2,
        unit: 'garnitura',
        notes: '⚠️ 2 cela kompleta, 3x Box 1/2 je viška (manjka 3x Box 2/2)',
        boxes: [
          { boxNum: 1, shelf: 'Regal P-01 (vzglavje)', count: 5 },
          { boxNum: 2, shelf: 'Regal P-02 (okvir & stranice)', count: 2 }
        ]
      },
      {
        sku: '3618930',
        name: 'Predalnik LIMFJORDEN 4 predali bela',
        category: 'Pohištvo',
        boxTotal: 2,
        minQuantity: 2,
        unit: 'garnitura',
        notes: 'JYSK Predalnik LIMFJORDEN (Škatla 1/2 razdeljena na P-04 in P-09 rezervo)',
        boxes: [
          { boxNum: 1, shelf: 'Regal P-04 (ogrodje)', count: 4 },
          { boxNum: 1, shelf: 'Regal P-09 (rezerva)', count: 2 },
          { boxNum: 2, shelf: 'Regal P-05 (predali)', count: 6 }
        ]
      },
      {
        sku: '3670619',
        name: 'DIVERSES',
        category: 'Splošno',
        boxTotal: 1,
        minQuantity: 2,
        unit: 'kos',
        shelf: 'Regal D-01',
        count: 8,
        notes: 'Pomožni artikel za račune'
      }
    ];

    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['articles', 'stock_locations', 'logs'], 'readwrite');
      const artStore = tx.objectStore('articles');
      const stockStore = tx.objectStore('stock_locations');
      const logStore = tx.objectStore('logs');

      demoArticles.forEach(item => {
        artStore.put({
          sku: item.sku,
          name: item.name,
          category: item.category,
          boxTotal: item.boxTotal,
          minQuantity: item.minQuantity,
          unit: item.unit,
          notes: item.notes,
          lastUpdated: new Date().toISOString()
        });

        if (item.boxes) {
          item.boxes.forEach((b, idx) => {
            stockStore.put({
              id: `${item.sku}_b${b.boxNum}_${b.shelf}`,
              sku: item.sku,
              boxNum: b.boxNum,
              shelf: b.shelf,
              count: b.count,
              isPrimary: idx === 0,
              lastUpdated: new Date().toISOString()
            });
          });
        } else {
          stockStore.put({
            id: `${item.sku}_b1_${item.shelf}`,
            sku: item.sku,
            boxNum: 1,
            shelf: item.shelf,
            count: item.count,
            isPrimary: true,
            lastUpdated: new Date().toISOString()
          });
        }

        logStore.add({
          sku: item.sku,
          itemName: item.name,
          changeType: 'create',
          changeAmount: item.count || 0,
          resultingQty: item.count || 0,
          note: `Začetni vzorčni vnos`,
          timestamp: new Date().toISOString()
        });
      });

      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  },

  async ensureReceiptDemoItems() {
    const requiredSKUs = ['3618930', '3670619'];
    for (const sku of requiredSKUs) {
      const item = await this.getItemBySKU(sku);
      if (!item) {
        await this.seedDemoData();
        break;
      }
    }
  },

  /**
   * Izvoz celotne baze za varnostno kopijo ali BLE sinhronizacijo
   */
  async exportBackup() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['articles', 'stock_locations', 'logs'], 'readonly');
      const artReq = tx.objectStore('articles').getAll();
      const stockReq = tx.objectStore('stock_locations').getAll();
      const logReq = tx.objectStore('logs').getAll();

      let articles = [], stockLocations = [], logs = [];
      let ready = 0;

      const finish = async () => {
        ready++;
        if (ready < 3) return;
        const items = await DB.getAllItems();
        resolve({
          version: 2,
          createdAt: new Date().toISOString(),
          articles,
          stockLocations,
          items, // Za nazaj združljivo branje
          logs
        });
      };

      artReq.onsuccess = () => { articles = artReq.result || []; finish(); };
      artReq.onerror = () => reject(artReq.error);

      stockReq.onsuccess = () => { stockLocations = stockReq.result || []; finish(); };
      stockReq.onerror = () => reject(stockReq.error);

      logReq.onsuccess = () => { logs = logReq.result || []; finish(); };
      logReq.onerror = () => reject(logReq.error);
    });
  },

  async importBackup(data) {
    if (!data) throw new Error('Neveljavna datoteka za uvoz.');
    return this.mergeSyncData(data);
  },

  /**
   * Sinhronizacija podatkov med telefoni (BLE ali datoteka)
   */
  async mergeSyncData(syncPayload) {
    if (!syncPayload) throw new Error('Neveljavna datoteka za sinhronizacijo.');

    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['articles', 'stock_locations', 'logs'], 'readwrite');
      const artStore = tx.objectStore('articles');
      const stockStore = tx.objectStore('stock_locations');
      const logStore = tx.objectStore('logs');

      let addedCount = 0;
      let updatedCount = 0;
      let decreasedCount = 0;
      const addedItemNames = [];

      const incomingArticles = syncPayload.articles || [];
      const incomingStocks = syncPayload.stockLocations || [];
      const incomingItems = syncPayload.items || [];

      // Če ima payload stari format items:
      if (incomingItems.length > 0 && incomingArticles.length === 0) {
        for (const item of incomingItems) {
          const sku = String(item.sku || '').trim();
          if (!sku) continue;
          const boxTotal = Math.max(1, parseInt(item.boxTotal, 10) || 1);
          incomingArticles.push({
            sku: sku,
            name: item.name || `Artikel ${sku}`,
            category: item.category || 'Splošno',
            boxTotal: boxTotal,
            minQuantity: Number(item.minQuantity) || 0,
            unit: item.unit || (boxTotal > 1 ? 'garnitura' : 'kos'),
            notes: item.notes || '',
            lastUpdated: item.lastUpdated || new Date().toISOString()
          });

          if (item.boxes) {
            for (let b = 1; b <= boxTotal; b++) {
              const bData = item.boxes[b];
              if (!bData) continue;
              const locs = bData.locations || [{ name: bData.location || item.location || 'Brez lokacije', count: bData.count || 0, isPrimary: true }];
              locs.forEach(l => {
                incomingStocks.push({
                  id: `${sku}_b${b}_${l.name}`,
                  sku: sku,
                  boxNum: b,
                  shelf: l.name,
                  count: Number(l.count) || 0,
                  isPrimary: !!l.isPrimary,
                  lastUpdated: item.lastUpdated || new Date().toISOString()
                });
              });
            }
          }
        }
      }

      for (const art of incomingArticles) {
        if (!art || !art.sku) continue;
        artStore.put(art);
        addedCount++;
        addedItemNames.push(art.name || art.sku);
      }

      for (const st of incomingStocks) {
        if (!st || !st.id || !st.sku) continue;
        stockStore.put(st);
        updatedCount++;
      }

      let addedLogsCount = 0;
      if (Array.isArray(syncPayload.logs)) {
        const getLogsReq = logStore.getAll();
        getLogsReq.onsuccess = () => {
          const existingTimestamps = new Set((getLogsReq.result || []).map(l => l.timestamp));
          for (const incomingLog of syncPayload.logs) {
            if (!incomingLog || !incomingLog.timestamp) continue;
            if (!existingTimestamps.has(incomingLog.timestamp)) {
              delete incomingLog.id;
              logStore.add(incomingLog);
              existingTimestamps.add(incomingLog.timestamp);
              addedLogsCount++;
            }
          }
        };
      }

      tx.oncomplete = () => {
        resolve({
          addedCount,
          updatedCount,
          decreasedCount,
          addedLogsCount,
          addedItemNames,
          totalIncoming: (incomingArticles.length || incomingItems.length)
        });
      };
      tx.onerror = () => reject(tx.error);
    });
  }
};
