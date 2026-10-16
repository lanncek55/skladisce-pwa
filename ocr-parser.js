/**
 * ocr-parser.js - Specializiran razčlenjevalnik etiket in napisov na skladiščnih škatlah (JYSK in splošna skladišča)
 */

const WarehouseLabelParser = {
  /**
   * Zazna in razčleni trgovski račun (npr. JYSK račun z več artikli)
   * @param {string} rawText
   * @returns {Object|null}
   */
  parseReceipt(rawText) {
    if (!rawText || typeof rawText !== 'string') return null;
    const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

    const receiptKeywords = /racun|ra[cč]un|st\.?\s*ra[cč]|št\.?\s*ra[cč]|blagajn|skupaj|ddv|tovarni[sš]ka|bre[zž]ice|celov[sš]ka|prevzem|eft|trgovina\s*d\.?o\.?o/i;
    const hasKeyword = receiptKeywords.test(rawText);

    const receiptNoMatch = rawText.match(/(?:št\.?|st\.?)\s*ra[cč](?:un)?(?:\/storno)?[\s.:]*([0-9a-zA-Z\-]+)/i);
    const receiptNo = receiptNoMatch ? receiptNoMatch[1] : '';

    const dateMatch = rawText.match(/datum[\s.:]*([0-9\.\/]+(?:\s+[0-9:]+)?)/i);
    const receiptDate = dateMatch ? dateMatch[1] : '';

    const barcodeMatch = rawText.match(/\b([0-9]{16,24})\b/);
    const barcode = barcodeMatch ? barcodeMatch[1] : '';

    const itemsMap = new Map();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      const artMatch = line.match(/(?:artikel|art\.?|šifra|sifra|koda)?[\s.:]*\b([0-9]{7})\b/i);
      const hasArtWord = /(?:artikel|art\.?|šifra|sifra|koda)/i.test(line);
      const priceMatch = line.match(/([0-9]+[.,][0-9]{2})\s*(?:€|e|eur)?/i);

      if (artMatch && (hasArtWord || (priceMatch && hasKeyword))) {
        const sku = artMatch[1];

        let name = '';
        if (i > 0) {
          const prev = lines[i - 1];
          if (!receiptKeywords.test(prev) && !prev.match(/artikel|cena|popust|koda|količina/i) && prev.length > 2) {
            name = prev;
          }
        }
        if (!name) {
          const cleanedLine = line.replace(/(?:artikel|art\.?|šifra|sifra|koda)/gi, '').replace(sku, '').replace(/[0-9]+[.,][0-9]{2}\s*(?:€|e|eur)?/gi, '').trim();
          if (cleanedLine.length > 3) name = cleanedLine;
        }
        if (!name) name = 'Artikel ' + sku;

        let qty = 1;
        const qtyMatch = line.match(/([0-9]+)\s*(?:x|kom|kos|pcs)\b/i);
        if (qtyMatch) {
          qty = parseInt(qtyMatch[1], 10) || 1;
        }

        const price = priceMatch ? priceMatch[1] : '';

        if (itemsMap.has(sku)) {
          const existing = itemsMap.get(sku);
          existing.qty += qty;
        } else {
          itemsMap.set(sku, { sku, name, qty, price });
        }
      }
    }

    const items = Array.from(itemsMap.values());
    const isReceipt = (hasKeyword && items.length > 0) || items.length >= 2;

    if (!isReceipt) return null;

    return {
      isReceipt: true,
      receiptNo: receiptNo || (barcode ? barcode.substring(0, 10) : 'RAČUN-' + Date.now().toString().slice(-4)),
      receiptDate: receiptDate || new Date().toLocaleDateString('sl-SI'),
      barcode: barcode,
      items: items,
      rawText: rawText
    };
  },

  /**
   * Glavna funkcija za analizo surovega OCR besedila
   * @param {string} rawText - Besedilo prebrano s škatle ali računa
   * @returns {Object} Rezultat z artiklom, škatlo in količino ALI razčlenjen račun
   */
  parse(rawText) {
    if (!rawText || typeof rawText !== 'string') {
      return {
        articleNumber: '',
        name: '',
        boxCurrent: 1,
        boxTotal: 1,
        quantityInBox: 1,
        rawText: ''
      };
    }

    // 0. Preveri ali gre za trgovski račun kupca
    const receiptData = this.parseReceipt(rawText);
    if (receiptData && receiptData.isReceipt) {
      return receiptData;
    }

    const lines = rawText
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l.length > 0);

    let articleNumber = '';
    let name = '';
    let boxCurrent = 1;
    let boxTotal = 1;
    let quantityInBox = null;

    let articleLineIdx = -1;

    // Pomožna funkcija za čiščenje pogostih OCR zamenjav števk (O->0, I/l->1)
    function sanitizeNum7(s) {
      if (!s) return '';
      return s.replace(/O/gi, '0').replace(/[Il]/g, '1');
    }

    // 1. ISKANJE ŠTEVILKE ARTIKLA (Prva 7-mestna številka)
    // Primeri:
    // "JYSK product no.: 3725150 / 88225001" -> 3725150
    // "Art. no: 3651003 / 85823001" -> 3651003
    // "3610115 - Pedestal LYNGVIG" -> 3610115
    // "Article: 3759803" -> 3759803
    // "Product no.: 3726157/93121001" -> 3726157
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const labelMatch = line.match(/(?:product\s*(?:no\.?|number)?|article|art\.?\s*(?:no\.?|st\.?|št\.?)?|artikel|item|sku|vare[\s.:]*nr)[\s.:]*([0-9OIl]{7})\b/i);
      if (labelMatch) {
        const cleaned = sanitizeNum7(labelMatch[1]);
        if (/^[0-9]{7}$/.test(cleaned)) {
          articleNumber = cleaned;
          articleLineIdx = i;
          break;
        }
      }
    }

    // Če nismo našli z oznako, poiščemo vzorec "7_števk / xxxxx" ali "7_števk - ime"
    if (!articleNumber) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const slashMatch = line.match(/\b([0-9OIl]{7})\s*[\/|\-]/);
        if (slashMatch) {
          const cleaned = sanitizeNum7(slashMatch[1]);
          if (/^[0-9]{7}$/.test(cleaned)) {
            articleNumber = cleaned;
            articleLineIdx = i;
            break;
          }
        }
      }
    }

    // Fallback: katerakoli 7-mestna številka (pazimo, da ni order no z 10 števkami)
    if (!articleNumber) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/order|barcode|batch|ean|tel|datum/i.test(line)) continue;
        const any7 = line.match(/\b([0-9]{7})\b/);
        if (any7) {
          articleNumber = any7[1];
          articleLineIdx = i;
          break;
        }
      }
    }

    // 2. ISKANJE IMENA ARTIKLA
    // Vgrajen katalog znanih skladiščnih artiklov (iz etiket) kot takojšnja referenca
    const knownCatalog = {
      '3651003': { name: 'Mirror SANDAGER 3 pcs/pk oak', pieces: 3, box: 'Box 1/1' },
      '3690514': { name: 'Dining chair ADSLEV beige/n.oak', pieces: 2, box: 'Box 1/1' },
      '3690565': { name: 'Mirror BALSLEV 35x127 w.oak', pieces: 4, box: 'Box 1/1' },
      '3725150': { name: 'Garden chair FJELLERUP', pieces: 4, box: 'Box 1/1' },
      '3759803': { name: 'Stacking chair LARVIK grey', pieces: 24, box: 'Box 1/1' },
      '4334604': { name: 'ULVIK 50x70 cm', pieces: 12, box: 'Box 1/1' },
      '4318500': { name: 'PIL VANSE foam 30x47', pieces: 8, box: 'Box 1/1' },
      '3650189': { name: 'Pouffe AARS Dark Sand', pieces: 3, box: 'Box 1/1' },
      '3446278': { name: 'TM VINGAN 160x200cm', pieces: 1, box: 'Box 1/1' },
      '3610115': { name: 'Pedestal LYNGVIG Ø35 d.oak', pieces: 1, box: 'Box 1/1' },
      '3726157': { name: 'JYSK Artikel 3726157', pieces: 1, box: 'Box 1/1' }
    };

    // Pomožna funkcija za zaznavanje šuma ali dimenzij (npr. "al li Bes Poi 4 " fin," ali "Ø45/55/70")
    function isNoisyOrDimensionLine(str) {
      if (!str || str.length < 3) return true;
      if (/["]/.test(str)) return true;
      if (/\b\d+\s*[\/|\\]\s*\d+\s*[\/|\\]\s*\d+/.test(str)) return true;
      if (/\b\d+\s*x\s*\d+/i.test(str) && !/mirror|chair|pouffe|pedestal/i.test(str)) return true;
      if (/gross\s*weight|batch|order|barcode|colli|made\s*in/i.test(str)) return true;
      const words = str.split(/\s+/).filter(w => w.length > 0);
      const shortWords = words.filter(w => w.length <= 3);
      if (words.length >= 3 && (shortWords.length / words.length) >= 0.5) return true;
      if (/\b[a-z]{1,2}\s+[a-z]{1,2}\b/i.test(str) && !/tm|w\d|h\d/i.test(str)) return true;
      return false;
    }

    // A) Izrecna oznaka "product text" ali "product name"
    for (const line of lines) {
      const textMatch = line.match(/(?:product\s*text|article\s*name)[\s.:]+(.+)/i);
      if (textMatch && textMatch[1].trim().length > 2 && !isNoisyOrDimensionLine(textMatch[1])) {
        name = textMatch[1].trim();
        break;
      }
    }

    // B) Iskanje ključnih besed skladiščnega pohištva in izdelkov
    if (!name) {
      const furnitureKeywords = /mirror|chair|stol|miza|table|pouffe|pedestal|ulvik|sandager|fjellerup|larvik|vingan|vanse|aars|lyngvig|foam|pillow|vzglavnik|omara|polica/i;
      for (const line of lines) {
        if (furnitureKeywords.test(line) && !isNoisyOrDimensionLine(line)) {
          name = line.replace(/^[0-9\s\-\:\.\/]+/, '').trim();
          break;
        }
      }
    }

    // C) Pregled vrstice neposredno po številki artikla
    if (!name && articleNumber && articleLineIdx !== -1) {
      const artLine = lines[articleLineIdx];
      const parts = artLine.split(/[\-\:]/);
      if (parts.length > 1 && parts[1].trim().length > 3 && !isNoisyOrDimensionLine(parts[1])) {
        name = parts.slice(1).join('-').trim();
      } else if (articleLineIdx + 1 < lines.length) {
        const candidate = lines[articleLineIdx + 1];
        if (!isNoisyOrDimensionLine(candidate)) {
          name = candidate;
        }
      }
    }

    // D) Če OCR vrne nerazumljivo besedilo, preveri katalog po 7-mestni kodi
    if ((!name || isNoisyOrDimensionLine(name)) && articleNumber && knownCatalog[articleNumber]) {
      name = knownCatalog[articleNumber].name;
    }

    if (name) {
      name = name.replace(/^[\s\:\-\.\/]+/, '').trim();
    }

    // 3. ISKANJE PODATKOV O ŠKATLAH (Box X/Y ali Colli X/Y)
    // Pomembno: Da ne prebere podatkov sosednje škatle na paleti, najprej iščemo v neposredni bližini najdene šifre artikla!
    const boxPattern = /\b(?:box|colli|karton|package|pkg)[\s.:]*([0-9]+)\s*(?:[\/|\\]|\b(?:of|von)\b)\s*([0-9]+)(?:[\s.:]+([0-9]+)\s*(?:pcs\.?|kom|kos)?)?/i;

    const nearbyLines = [];
    if (articleLineIdx !== -1) {
      const start = Math.max(0, articleLineIdx - 2);
      const end = Math.min(lines.length - 1, articleLineIdx + 4);
      for (let i = start; i <= end; i++) nearbyLines.push(lines[i]);
    }

    // Najprej preveri bližnje vrstice iste škatle
    for (const line of (nearbyLines.length > 0 ? nearbyLines : lines)) {
      const boxMatch = line.match(boxPattern);
      if (boxMatch) {
        boxCurrent = parseInt(boxMatch[1], 10);
        boxTotal = parseInt(boxMatch[2], 10);
        if (boxMatch[3]) {
          quantityInBox = parseInt(boxMatch[3], 10);
        }
        break;
      }
    }

    // Fallback: če v bližini nismo našli, preveri ostale vrstice
    if (boxTotal === 1 && boxCurrent === 1 && nearbyLines.length > 0) {
      for (const line of lines) {
        const boxMatch = line.match(boxPattern);
        if (boxMatch) {
          boxCurrent = parseInt(boxMatch[1], 10);
          boxTotal = parseInt(boxMatch[2], 10);
          if (boxMatch[3]) {
            quantityInBox = parseInt(boxMatch[3], 10);
          }
          break;
        }
      }
    }

    // 4. KOLIČINA KOSOV V ŠKATLI (Quantity / Colli size / manjših škatel)
    // A) Izrecna oznaka v eni vrstici npr. "Quantity: 4 pcs", "Colli Size 24", "QTY: 4", "Kosov: 4", "Menge: 4"
    for (const line of lines) {
      const qtyLabelMatch = line.match(/(?:quantity|colli\s*size|qty|menge|koli[cč]ina|kosov)[\s.:]*([0-9]+)\s*(?:pcs\.?|kom|kos)?/i);
      if (qtyLabelMatch) {
        quantityInBox = parseInt(qtyLabelMatch[1], 10);
        break;
      }
    }

    // B) Če je oznaka "Quantity:" in številka v dveh vrsticah (npr. dvostolpčna postavitev)
    if (!quantityInBox) {
      const fullText = lines.join(' ');
      const multilineMatch = fullText.match(/(?:quantity|colli\s*size|qty|menge|koli[cč]ina|kosov)[\s.:]*([0-9]+)\s*(?:pcs\.?|kom|kos)?/i);
      if (multilineMatch) {
        quantityInBox = parseInt(multilineMatch[1], 10);
      }
    }

    // C) Oznaka pakiranja tipa "3 pcs/pk", "4 pcs/pack", "4 kom/pak", "4 pcs / ctn", "4 pcs/box"
    if (!quantityInBox) {
      for (const line of lines) {
        const pkMatch = line.match(/\b([0-9]+)\s*(?:pcs|kom|kos)\s*[\/|\\]\s*(?:pk|pack|karton|ctn|box|komplet)\b/i);
        if (pkMatch) {
          quantityInBox = parseInt(pkMatch[1], 10);
          break;
        }
      }
    }

    // D) Samostojna vrstica z zgolj količino npr. "4 pcs" ali "12 pcs" ali "4 kom" (ki ni vrstica z imenom)
    if (!quantityInBox) {
      for (const line of lines) {
        if (line !== name) {
          const standalonePcsMatch = line.match(/^([0-9]+)\s*(?:pcs\.?|kom|kos)\b/i);
          if (standalonePcsMatch) {
            quantityInBox = parseInt(standalonePcsMatch[1], 10);
            break;
          }
        }
      }
    }

    // E) Preveri katalog znanih artiklov, če je šifra znana
    if ((!quantityInBox || quantityInBox === 1) && articleNumber && knownCatalog[articleNumber] && knownCatalog[articleNumber].pieces) {
      quantityInBox = knownCatalog[articleNumber].pieces;
    }

    // Če količina še vedno ni bila najdena, je privzeto 1 kos na škatlo
    if (quantityInBox === null || isNaN(quantityInBox) || quantityInBox <= 0) {
      quantityInBox = 1;
    }

    // Lep format imena
    if (!name && articleNumber) {
      name = `Artikel ${articleNumber}`;
    }

    return {
      articleNumber,
      name,
      boxCurrent,
      boxTotal,
      quantityInBox,
      rawText
    };
  }
};

// Izvoz za modul ali globalni objekt v brskalniku
if (typeof window !== 'undefined') {
  window.WarehouseLabelParser = WarehouseLabelParser;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = WarehouseLabelParser;
}
