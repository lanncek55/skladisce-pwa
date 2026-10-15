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

const DB = {
  async getAllItems() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('items', 'readonly');
      const store = tx.objectStore('items');
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  },

  async getItemById(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('items', 'readonly');
      const store = tx.objectStore('items');
      const req = store.get(Number(id));
      req.onsuccess = () => resolve(req.result);
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
            found = cursor.value;
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
    const itemData = {
      sku: String(item.sku || '').trim(),
      name: String(item.name || '').trim(),
      category: String(item.category || 'Splošno').trim(),
      location: String(item.location || 'Brez lokacije').trim(),
      quantity: Number(item.quantity) || 0,
      minQuantity: Number(item.minQuantity) || 0,
      unit: String(item.unit || 'kos').trim(),
      boxInfo: String(item.boxInfo || 'Box 1/1').trim(),
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
        // Zabeleži začetni premik
        logStore.add({
          itemId: newId,
          sku: itemData.sku,
          itemName: itemData.name,
          changeType: 'create',
          changeAmount: itemData.quantity,
          resultingQty: itemData.quantity,
          note: `Začetni vnos (${itemData.boxInfo}, ${itemData.piecesPerBox} kos/škatlo)`,
          timestamp: new Date().toISOString()
        });
        resolve(newId);
      };
      req.onerror = () => reject(req.error);
    });
  },

  async updateItem(item) {
    const db = await openDB();
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
      boxInfo: String(item.boxInfo || 'Box 1/1').trim(),
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

  async adjustStock(id, delta, note = '', type = 'adjust') {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['items', 'logs'], 'readwrite');
      const itemStore = tx.objectStore('items');
      const logStore = tx.objectStore('logs');

      const getReq = itemStore.get(Number(id));
      getReq.onsuccess = () => {
        const item = getReq.result;
        if (!item) {
          reject(new Error('Artikel ne obstaja.'));
          return;
        }

        const newQty = Math.max(0, (Number(item.quantity) || 0) + Number(delta));
        item.quantity = newQty;
        item.lastUpdated = new Date().toISOString();

        itemStore.put(item);

        logStore.add({
          itemId: item.id,
          sku: item.sku,
          itemName: item.name,
          changeType: type,
          changeAmount: Number(delta),
          resultingQty: newQty,
          note: note || (delta >= 0 ? 'Prevzem blaga' : 'Izdaja blaga'),
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
      { sku: '3725150', name: 'Garden chair FJELLERUP', category: 'Vrtno pohištvo', location: 'Regal V-04', quantity: 24, minQuantity: 8, unit: 'kos', boxInfo: 'Box 1/1', piecesPerBox: 4, notes: 'W56 x H93 x D66 cm, Natural' },
      { sku: '3651003', name: 'Mirror SANDAGER 3 pcs/pk oak', category: 'Ogledala & Dekor', location: 'Regal O-02', quantity: 15, minQuantity: 6, unit: 'kos', boxInfo: 'Box 1/1', piecesPerBox: 1, notes: 'Ø45/55/70 oak (komplet 3 ogledal)' },
      { sku: '3759803', name: 'Stacking chair LARVIK grey', category: 'Stoli & Mize', location: 'Paleta P-08', quantity: 48, minQuantity: 24, unit: 'kos', boxInfo: 'Box 1/1', piecesPerBox: 24, notes: 'Nakladalni stol, siva barva' },
      { sku: '4334604', name: 'ULVIK vzglavnik 50x70', category: 'Tekstil & Posteljnina', location: 'Regal T-11', quantity: 36, minQuantity: 12, unit: 'kos', boxInfo: 'Box 1/1', piecesPerBox: 12, notes: '50x70 cm, beli' },
      { sku: '4318500', name: 'PIL VANSE foam 30x47', category: 'Tekstil & Posteljnina', location: 'Regal T-12', quantity: 16, minQuantity: 8, unit: 'kos', boxInfo: 'Box 1/1', piecesPerBox: 8, notes: 'Anatomski vzglavnik iz spominske pene' },
      { sku: '3650189', name: 'Pouffe AARS Dark Sand', category: 'Oblazinjeno pohištvo', location: 'Regal S-01', quantity: 9, minQuantity: 3, unit: 'kos', boxInfo: 'Box 1/1', piecesPerBox: 3, notes: '65x65x40 cm' },
      { sku: '3446278', name: 'TM VINGAN 160x200cm', category: 'Vzmetnice & Nadvložki', location: 'Regal M-05', quantity: 4, minQuantity: 2, unit: 'kos', boxInfo: 'Box 1/1', piecesPerBox: 1, notes: 'Nadvložek 160x200x4cm' },
      { sku: '3610115', name: 'Pedestal LYNGVIG Ø35 d.oak', category: 'Omarice & Mizice', location: 'Regal M-08', quantity: 6, minQuantity: 2, unit: 'kos', boxInfo: 'Box 1/1', piecesPerBox: 1, notes: 'Ø35 x H60 cm, temni hrast' }
    ];

    for (const item of demoItems) {
      await this.addItem(item);
    }
    return true;
  }
};
