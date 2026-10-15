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
    // Primeri:
    // "JYSK product text: Garden chair FJELLERUP"
    // "JYSK product text: ULVIK"
    // "JYSK product text: Pouffe AARS"
    // "Mirror SANDAGER 3 pcs/pk oak" (vrstica takoj za 3651003)
    // "3610115 - Pedestal LYNGVIG Ø35 d.oak"
    // "Stacking chair LARVIK grey"
    for (const line of lines) {
      const textMatch = line.match(/(?:product\s*text|article\s*name)[\s.:]+(.+)/i);
      if (textMatch && textMatch[1].trim().length > 2) {
        name = textMatch[1].trim();
        break;
      }
    }

    // Če ni izrecne oznake "product text":
    if (!name && articleNumber) {
      // Preveri vrstico, ki vsebuje "3610115 - Pedestal..."
      const inlineMatch = lines.find(l => l.includes(articleNumber) && /[\-\:]/.test(l));
      if (inlineMatch) {
        const parts = inlineMatch.split(/[\-\:]/);
        if (parts.length > 1 && parts[1].trim().length > 3) {
          name = parts.slice(1).join('-').trim();
        }
      }
    }

    // Če še vedno ni imena, poiščemo vrstico takoj za številko artikla
    if (!name && articleNumber) {
      const artIdx = lines.findIndex(l => l.includes(articleNumber));
      if (artIdx !== -1 && artIdx + 1 < lines.length) {
        const candidate = lines[artIdx + 1];
        // Preveri, da kandidat ni le tehnična oznaka
        if (!/^(box|colli|batch|order|size|barcode|date|gross)/i.test(candidate) && candidate.length > 3) {
          name = candidate;
        }
      }
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
      const boxMatch = line.match(/\b(?:box|colli)[\s.:]*([0-9]+)\s*[\/|\\]\s*([0-9]+)\b/i);
      if (boxMatch) {
        boxCurrent = parseInt(boxMatch[1], 10);
        boxTotal = parseInt(boxMatch[2], 10);
        break;
      }
    }

    // 4. KOLIČINA KOSOV V ŠKATLI (Quantity / Colli size / pcs)
    // Primeri:
    // "Quantity: 12 pcs" -> 12
    // "Quantity: 8 pcs." -> 8
    // "Quantity: 4 pcs" -> 4
    // "Quantity: 3 pcs" -> 3
    // "Quantity: 1" -> 1
    // "Colli Size 24" -> 24
    // "Mirror SANDAGER 3 pcs/pk oak" -> 3 pcs
    for (const line of lines) {
      // "Quantity: 12 pcs" ali "Quantity: 1"
      const qtyLabelMatch = line.match(/(?:quantity|colli\s*size)[\s.:]*([0-9]+)\s*(?:pcs\.?)?/i);
      if (qtyLabelMatch) {
        quantityInBox = parseInt(qtyLabelMatch[1], 10);
        break;
      }
      // "3 pcs/pk" ali "4 pcs"
      const pcsMatch = line.match(/\b([0-9]+)\s*(?:pcs\/pk|pcs\b)/i);
      if (pcsMatch) {
        quantityInBox = parseInt(pcsMatch[1], 10);
        break;
      }
    }

    // Če količina ni bila specificirana, je privzeta 1 kos
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
