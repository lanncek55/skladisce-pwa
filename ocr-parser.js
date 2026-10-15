/**
 * ocr-parser.js - Specializiran razčlenjevalnik etiket in napisov na skladiščnih škatlah (JYSK in splošna skladišča)
 */

const WarehouseLabelParser = {
  /**
   * Glavna funkcija za analizo surovega OCR besedila
   * @param {string} rawText - Besedilo prebrano s škatle
   * @returns {Object} Rezultat z artiklom, škatlo in količino
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

    const lines = rawText
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l.length > 0);

    let articleNumber = '';
    let name = '';
    let boxCurrent = 1;
    let boxTotal = 1;
    let quantityInBox = null;

    // 1. ISKANJE ŠTEVILKE ARTIKLA (Prva 7-mestna številka)
    // Primeri:
    // "JYSK product no.: 3725150 / 88225001" -> 3725150
    // "3651003 / 85823001" -> 3651003
    // "3610115 - Pedestal LYNGVIG" -> 3610115
    // "Article: 3759803" -> 3759803
    // "Product no.: 3726157/93121001" -> 3726157
    // "JYSK product number: 4334604" -> 4334604
    for (const line of lines) {
      // Izrecne oznake artikla
      const labelMatch = line.match(/(?:product\s*(?:no\.?|number)|article)[\s.:]*([0-9]{7})(?:[\s\/\-]|$)/i);
      if (labelMatch) {
        articleNumber = labelMatch[1];
        break;
      }
    }

    // Če nismo našli z oznako, poiščemo vzorec "7_števk / xxxxx" ali "7_števk - ime"
    if (!articleNumber) {
      for (const line of lines) {
        const slashMatch = line.match(/\b([0-9]{7})\s*[\/|\-]/);
        if (slashMatch) {
          articleNumber = slashMatch[1];
          break;
        }
      }
    }

    // Fallback: katerakoli 7-mestna številka (pazimo, da ni order no z 10 števkami)
    if (!articleNumber) {
      for (const line of lines) {
        // Izpusti vrstice z "order" ali "barcode" ali "batch"
        if (/order|barcode|batch/i.test(line)) continue;
        const any7 = line.match(/\b([0-9]{7})\b/);
        if (any7) {
          articleNumber = any7[1];
          break;
        }
      }
    }

    // 2. ISKANJE IMENA ARTIKLA
    // Vgrajen katalog znanih skladiščnih artiklov (iz etiket) kot takojšnja referenca
    const knownCatalog = {
      '3651003': { name: 'Mirror SANDAGER 3 pcs/pk oak', pieces: 1, box: 'Box 1/1' },
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
      // Vsebuje narekovaje ali preveč ločil
      if (/["]/.test(str)) return true;
      // Dimenzije / mere / teža: npr. "45/55/70", "D2.75", "160x200", "5,5 kg"
      if (/\b\d+\s*[\/|\\]\s*\d+\s*[\/|\\]\s*\d+/.test(str)) return true;
      if (/\b\d+\s*x\s*\d+/i.test(str) && !/mirror|chair|pouffe|pedestal/i.test(str)) return true;
      if (/gross\s*weight|batch|order|barcode|colli|made\s*in/i.test(str)) return true;
      // Preveč kratkih besedic (posledica OCR šuma) npr. "al li Bes Poi 4 fin"
      const words = str.split(/\s+/).filter(w => w.length > 0);
      const shortWords = words.filter(w => w.length <= 3);
      if (words.length >= 3 && (shortWords.length / words.length) >= 0.5) return true;
      // Združek številk in 2-črkovnih fragmentov
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
          // Očisti morebitne številke na začetku npr. "3610115 - Pedestal..."
          name = line.replace(/^[0-9\s\-\:\.\/]+/, '').trim();
          break;
        }
      }
    }

    // C) Pregled vrstice neposredno po številki artikla
    if (!name && articleNumber) {
      const artIdx = lines.findIndex(l => l.includes(articleNumber));
      if (artIdx !== -1) {
        // Preveri vrstico artikla (npr. "3610115 - Pedestal...")
        const artLine = lines[artIdx];
        const parts = artLine.split(/[\-\:]/);
        if (parts.length > 1 && parts[1].trim().length > 3 && !isNoisyOrDimensionLine(parts[1])) {
          name = parts.slice(1).join('-').trim();
        } else if (artIdx + 1 < lines.length) {
          const candidate = lines[artIdx + 1];
          if (!isNoisyOrDimensionLine(candidate)) {
            name = candidate;
          }
        }
      }
    }

    // D) Če OCR vrne nerazumljivo besedilo, preveri katalog po 7-mestni kodi
    if ((!name || isNoisyOrDimensionLine(name)) && articleNumber && knownCatalog[articleNumber]) {
      name = knownCatalog[articleNumber].name;
    }

    // Očisti ime nepotrebnih pripon, če so bile zajete
    if (name) {
      name = name.replace(/^[\s\:\-\.\/]+/, '').trim();
    }

    // 3. ISKANJE PODATKOV O ŠKATLAH (Box X/Y ali Colli X/Y)
    // Primeri:
    // "Box 1/1"
    // "Box 1/2"
    // "Box 2/2"
    // "Colli 1/2"
    for (const line of lines) {
      // Primeri: "Box 1/1: 2 pcs", "Box 1/1", "Colli 1/2"
      const boxMatch = line.match(/\b(?:box|colli)[\s.:]*([0-9]+)\s*[\/|\\]\s*([0-9]+)(?:[\s.:]+([0-9]+)\s*(?:pcs\.?|kom)?)?/i);
      if (boxMatch) {
        boxCurrent = parseInt(boxMatch[1], 10);
        boxTotal = parseInt(boxMatch[2], 10);
        if (boxMatch[3]) {
          quantityInBox = parseInt(boxMatch[3], 10);
        }
        break;
      }
    }

    // 4. KOLIČINA KOSOV V ŠKATLI (Quantity / Colli size)
    // A) Izrecna oznaka v eni vrstici npr. "Quantity: 4 pcs", "Colli Size 24", "Quantity: 1"
    for (const line of lines) {
      const qtyLabelMatch = line.match(/(?:quantity|colli\s*size)[\s.:]*([0-9]+)\s*(?:pcs\.?)?/i);
      if (qtyLabelMatch) {
        quantityInBox = parseInt(qtyLabelMatch[1], 10);
        break;
      }
    }

    // B) Če je oznaka "Quantity:" in številka v dveh vrsticah (npr. dvostolpčna postavitev)
    if (!quantityInBox) {
      const fullText = lines.join(' ');
      const multilineMatch = fullText.match(/(?:quantity|colli\s*size)[\s.:]*([0-9]+)\s*(?:pcs\.?)?/i);
      if (multilineMatch) {
        quantityInBox = parseInt(multilineMatch[1], 10);
      }
    }

    // C) Samostojna vrstica z zgolj količino npr. "4 pcs" ali "12 pcs" (ki ni vrstica z imenom)
    if (!quantityInBox) {
      for (const line of lines) {
        if (line !== name) {
          const standalonePcsMatch = line.match(/^([0-9]+)\s*(?:pcs\.?|kom)\b/i);
          if (standalonePcsMatch) {
            quantityInBox = parseInt(standalonePcsMatch[1], 10);
            break;
          }
        }
      }
    }

    // D) Preveri katalog znanih artiklov, če je šifra znana
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
