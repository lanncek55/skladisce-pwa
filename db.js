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
          note: 'Začetni vnos artikla',
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
      quantity: Number(item.quantity) || 0,
      minQuantity: Number(item.minQuantity) || 0,
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
      { sku: 'VIJ-M8-40', name: 'Vijak M8x40 pocinkan', category: 'Pritrdilni material', location: 'Regal A-01', quantity: 250, minQuantity: 50, unit: 'kos', notes: 'Standardni jekleni vijaki DIN 933' },
      { sku: 'MAT-M8', name: 'Matica M8 samozaporna', category: 'Pritrdilni material', location: 'Regal A-02', quantity: 18, minQuantity: 40, unit: 'kos', notes: 'Z nylon obročem (kritična zaloga!)' },
      { sku: 'TRAK-LEP-50', name: 'Pakirni lepilni trak 50mm', category: 'Embalaža', location: 'Polica B-01', quantity: 34, minQuantity: 15, unit: 'kos', notes: 'Rjav trak za kartone' },
      { sku: 'SKAT-S', name: 'Kartonska škatla tip S (30x20x15)', category: 'Embalaža', location: 'Paleta P-12', quantity: 5, minQuantity: 20, unit: 'kos', notes: 'Zaloga pod minimumom' },
      { sku: 'ROK-MEH-L', name: 'Zaščitne delovne rokavice (vel. L)', category: 'Osebna zaščita', location: 'Regal C-04', quantity: 42, minQuantity: 10, unit: 'par', notes: 'Lateks premaz' },
      { sku: 'MAZ-WD40-400', name: 'Sprej WD-40 400ml', category: 'Maziva & Kemija', location: 'Regal D-01', quantity: 12, minQuantity: 6, unit: 'kos', notes: 'Univerzalno mazivo' }
    ];

    for (const item of demoItems) {
      await this.addItem(item);
    }
    return true;
  }
};
