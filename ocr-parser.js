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
   * Glavna AI funkcija za analizo etiket škatel in trgovskih računov
   * Podpira strukturirane bloke Google ML Kita (blocks) ali surovo besedilo (rawText).
   * 
   * Značilnosti:
   * 1. Stroga zaščita pred naključnimi 7-mestnimi številkami (zavrže izolirane številke brez skladiščnega konteksta)
   * 2. Prostorska izolacija ene škatle (če sta v kadru 2 škatli, se podatki ne pomešajo, ampak se izbere tista bližje vizirju)
   * 3. Neodvisnost od kota (podpira poljubno rotacijo znakov, ki jo zazna ML Kit)
   * 
   * @param {string} rawText - Besedilo prebrano s škatle ali računa
   * @param {Array} [blocks=null] - Strukturirani bloki teksta z bounding boxi iz ML Kita
   * @param {Object} [options={}] - Dodatne možnosti (npr. knownSkus, imageCenter)
   * @returns {Object} Rezultat z artiklom, škatlo in količino ALI razčlenjen račun
   */
  parse(rawText, blocks = null, options = {}) {
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

    // Vgrajen referenčni katalog pogostih artiklov
    const knownCatalog = {
      '3651003': { name: 'Mirror SANDAGER 3 pcs/pk oak', pieces: 3, box: 'Box 1/1' },
      '3690514': { name: 'Dining chair ADSLEV beige/n.oak', pieces: 2, box: 'Box 1/1' },
      '3690565': { name: 'Mirror BALSLEV 35x127 w.oak', pieces: 4, box: 'Box 1/1' },
      '3725150': { name: 'Garden chair FJELLERUP', pieces: 4, box: 'Box 1/1' },
      '37251550': { name: 'Garden chair FJELLERUP', pieces: 4, box: 'Box 1/1' },
      '3725155': { name: 'Garden chair FJELLERUP', pieces: 4, box: 'Box 1/1' },
      '3759803': { name: 'Stacking chair LARVIK grey', pieces: 24, box: 'Box 1/1' },
      '4334604': { name: 'ULVIK 50x70 cm', pieces: 12, box: 'Box 1/1' },
      '4318500': { name: 'PIL VANSE foam 30x47', pieces: 8, box: 'Box 1/1' },
      '3650189': { name: 'Pouffe AARS Dark Sand', pieces: 3, box: 'Box 1/1' },
      '3446278': { name: 'TM VINGAN 160x200cm', pieces: 1, box: 'Box 1/1' },
      '3610115': { name: 'Pedestal LYNGVIG Ø35 d.oak', pieces: 1, box: 'Box 1/1' },
      '3726157': { name: 'JYSK Artikel 3726157', pieces: 1, box: 'Box 1/1' },
      '3618930': { name: 'Predalnik LIMFJORDEN 4 predali bela', pieces: 1, box: 'Box 1/1' },
      '3670619': { name: 'DIVERSES', pieces: 1, box: 'Box 1/1' }
    };

    function sanitizeNum(s) {
      if (!s) return '';
      return s.replace(/O/gi, '0').replace(/[Il]/g, '1');
    }

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

    const boxPattern = /\b(?:box|colli|karton|package|pkg)[\s.:]*([0-9]+)\s*(?:[\/|\\]|\b(?:of|von)\b)\s*([0-9]+)(?:[\s.:]+([0-9]+)\s*(?:pcs\.?|kom|kos)?)?/i;

    // AI KANDIDATI ZA ETIKETO ŠKATLE
    // Vsak kandidat predstavlja eno izolirano etiketo (preprečuje zlivanje sosednjih škatel na paleti)
    const candidates = [];

    // A. Če imamo strukturirane bloke iz Google ML Kita
    if (Array.isArray(blocks) && blocks.length > 0) {
      for (const blk of blocks) {
        const blkText = blk.rawValue || blk.text || '';
        if (!blkText) continue;
        const blkLines = blkText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        if (blkLines.length === 0) continue;

        let center = null;
        if (blk.boundingBox) {
          const b = blk.boundingBox;
          const left = b.left ?? b.x ?? 0;
          const top = b.top ?? b.y ?? 0;
          const width = b.width ?? (b.right ? b.right - left : 0);
          const height = b.height ?? (b.bottom ? b.bottom - top : 0);
          center = { x: left + width / 2, y: top + height / 2 };
        }

        candidates.push({
          lines: blkLines,
          fullText: blkText,
          center
        });
      }
    }

    // B. Vedno vključimo celotno besedilo kot krovnega kandidata (za primere večstolpčnih etiket, kjer so oznake v enem bloku, vrednosti pa v drugem)
    const allLines = rawText
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l.length > 0);

    candidates.push({
      lines: allLines,
      fullText: rawText,
      center: null
    });

    // AI TOČKOVANJE IN EVALVACIJA VSAKEGA KANDIDATA
    // Strogo pravilo proti naključnim številkam:
    // Izolirana 7 ali 8 mestna številka BREZ oznake, brez JYSK kosa/katalog ujemanja ali Box konteksta ima oceno 0 in se ZAVRNE!
    const evaluatedCandidates = [];

    for (const cand of candidates) {
      const cLines = cand.lines;
      let sku = '';
      let skuScore = 0;
      let candArticleIdx = -1;

      // 1. Iskanje SKU po nivojih zanesljivosti:
      // Nivo 1 (+95): Izrecna oznaka (Product no, Art. no, Artikel, Item, SKU, Vare nr)
      for (let i = 0; i < cLines.length; i++) {
        const line = cLines[i];
        if (/(?:product\s*(?:no\.?|number)?|article|art\.?\s*(?:no\.?|st\.?|št\.?|nr\.?)?|artikel|item|sku|vare[\s.:]*nr|koda|šifra)/i.test(line)) {
          // A) V isti vrstici
          const inlineM = line.match(/\b([0-9OIl]{7,8})\b/);
          if (inlineM) {
            const cleaned = sanitizeNum(inlineM[1]);
            if (/^[0-9]{7,8}$/.test(cleaned)) {
              sku = cleaned;
              skuScore = 95;
              candArticleIdx = i;
              break;
            }
          }
          // B) V naslednjih 1-6 vrsticah (za večstolpčne ali zlomljene etikete)
          for (let j = i + 1; j <= Math.min(cLines.length - 1, i + 6); j++) {
            const nextL = cLines[j];
            if (/barcode|ean|batch|order|tel|phone|kg|cm|natural|color/i.test(nextL)) continue;
            const nextM = nextL.match(/\b([0-9OIl]{7,8})\b/);
            if (nextM) {
              const cleaned = sanitizeNum(nextM[1]);
              if (/^[0-9]{7,8}$/.test(cleaned)) {
                sku = cleaned;
                skuScore = 95;
                candArticleIdx = j;
                break;
              }
            }
          }
          if (sku) break;
        }
      }

      // Nivo 2 (+90): Standardni JYSK vzorec "7-8 števk / 3-10 števk" (npr. 37251550 / 8822 ali 3725150 / 88225001)
      if (!sku) {
        for (let i = 0; i < cLines.length; i++) {
          const line = cLines[i];
          const slashM = line.match(/\b([0-9OIl]{7,8})\s*[\/|\\]\s*[0-9]{3,10}\b/);
          if (slashM) {
            const cleaned = sanitizeNum(slashM[1]);
            if (/^[0-9]{7,8}$/.test(cleaned)) {
              sku = cleaned;
              skuScore = 90;
              candArticleIdx = i;
              break;
            }
          }
        }
      }

      // Nivo 3 (+85): 7 ali 8 števk, ki se ujemajo z bazo skladišča ali znanim katalogom
      if (!sku) {
        for (let i = 0; i < cLines.length; i++) {
          const line = cLines[i];
          if (/order|barcode|batch|ean|tel|datum/i.test(line)) continue;
          const allNums = line.match(/\b([0-9]{7,8})\b/g);
          if (allNums) {
            for (const testNum of allNums) {
              if (knownCatalog[testNum] || options?.knownSkus?.has?.(testNum)) {
                sku = testNum;
                skuScore = 85;
                candArticleIdx = i;
                break;
              }
              // Preveri 7-mestno predpono če je v bazi shranjena 7-mestna
              if (testNum.length === 8) {
                const sub7 = testNum.substring(0, 7);
                if (knownCatalog[sub7] || options?.knownSkus?.has?.(sub7)) {
                  sku = sub7;
                  skuScore = 85;
                  candArticleIdx = i;
                  break;
                }
              }
            }
          }
          if (sku) break;
        }
      }

      // Nivo 4 (+75): 7 ali 8 števk neposredno pred nazivom artikla (npr. "3610115 - Pedestal")
      if (!sku) {
        for (let i = 0; i < cLines.length; i++) {
          const line = cLines[i];
          const nameM = line.match(/\b([0-9OIl]{7,8})\s*[\-\–]\s*[A-Z][a-zA-Z]/);
          if (nameM) {
            const cleaned = sanitizeNum(nameM[1]);
            if (/^[0-9]{7,8}$/.test(cleaned)) {
              sku = cleaned;
              skuScore = 75;
              candArticleIdx = i;
              break;
            }
          }
        }
      }

      // Nivo 5 (+50): 7 ali 8 števk z jasnim kontekstom Box X/Y ali količine v isti etiketi
      if (!sku) {
        const hasBoxNearby = cLines.some(l => boxPattern.test(l));
        const hasQtyNearby = cLines.some(l => /(?:quantity|colli\s*size|qty|pcs|kom|kos)/i.test(l));
        if (hasBoxNearby || hasQtyNearby) {
          for (let i = 0; i < cLines.length; i++) {
            const line = cLines[i];
            if (/order|barcode|batch|ean|tel|datum|phone|gsm/i.test(line)) continue;
            const anyM = line.match(/\b([0-9]{7,8})\b/);
            if (anyM) {
              sku = anyM[1];
              skuScore = 50;
              candArticleIdx = i;
              break;
            }
          }
        }
      }

      // Če SKU nima zadostnega skladiščnega potrdila (je npr. le naključna številka), ga zavrnemo!
      if (!sku || skuScore < 50) {
        continue;
      }

      // 2. Podatki o škatli (Box X/Y) - IŠČEMO IZKLJUČNO ZNOTRAJ TE ETIKETE
      let bCurrent = 1;
      let bTotal = 1;
      let qInBox = null;
      let boxScore = 0;

      for (const line of cLines) {
        const bMatch = line.match(boxPattern);
        if (bMatch) {
          bCurrent = parseInt(bMatch[1], 10) || 1;
          bTotal = parseInt(bMatch[2], 10) || 1;
          if (bMatch[3]) {
            qInBox = parseInt(bMatch[3], 10);
          }
          boxScore = 30;
          break;
        }
      }

      // 3. Količina kosov v škatli (izrecne oznake)
      if (!qInBox) {
        for (const line of cLines) {
          const qMatch = line.match(/(?:quantity|colli\s*size|qty|menge|koli[cč]ina|kosov)[\s.:]*([0-9]+)\s*(?:pcs\.?|kom|kos)?/i);
          if (qMatch) {
            qInBox = parseInt(qMatch[1], 10);
            break;
          }
        }
      }
      if (!qInBox) {
        for (const line of cLines) {
          const pkMatch = line.match(/\b([0-9]+)\s*(?:pcs|kom|kos)\s*[\/|\\]\s*(?:pk|pack|karton|ctn|box|komplet)\b/i);
          if (pkMatch) {
            qInBox = parseInt(pkMatch[1], 10);
            break;
          }
        }
      }
      if (!qInBox) {
        for (const line of cLines) {
          const standMatch = line.match(/^([0-9]+)\s*(?:pcs\.?|kom|kos)\b/i);
          if (standMatch) {
            qInBox = parseInt(standMatch[1], 10);
            break;
          }
        }
      }
      if (!qInBox && knownCatalog[sku]?.pieces) {
        qInBox = knownCatalog[sku].pieces;
      }
      if (!qInBox || isNaN(qInBox) || qInBox <= 0) {
        qInBox = 1;
      }

      // 4. Naziv artikla
      let prodName = '';
      for (const line of cLines) {
        const textMatch = line.match(/(?:product\s*text|article\s*name)[\s.:]+(.+)/i);
        if (textMatch && textMatch[1].trim().length > 2 && !isNoisyOrDimensionLine(textMatch[1])) {
          prodName = textMatch[1].trim();
          break;
        }
      }
      if (!prodName) {
        const furnitureKeywords = /mirror|chair|stol|miza|table|pouffe|pedestal|ulvik|sandager|fjellerup|larvik|vingan|vanse|aars|lyngvig|foam|pillow|vzglavnik|omara|polica|predalnik/i;
        for (const line of cLines) {
          if (furnitureKeywords.test(line) && !isNoisyOrDimensionLine(line)) {
            prodName = line.replace(/^[0-9\s\-\:\.\/]+/, '').trim();
            break;
          }
        }
      }
      if (!prodName && candArticleIdx !== -1 && candArticleIdx + 1 < cLines.length) {
        const nextLine = cLines[candArticleIdx + 1];
        if (!isNoisyOrDimensionLine(nextLine)) {
          prodName = nextLine;
        }
      }
      if (!prodName && knownCatalog[sku]) {
        prodName = knownCatalog[sku].name;
      }
      if (!prodName) {
        prodName = `Artikel ${sku}`;
      }

      // 5. Prostorska bližina centru (če imamo koordinate blokov iz ML Kita)
      let distPenalty = 0;
      if (cand.center && options?.imageCenter) {
        const dx = cand.center.x - options.imageCenter.x;
        const dy = cand.center.y - options.imageCenter.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const maxDist = Math.max(1, options.imageCenter.x);
        distPenalty = Math.min(25, (dist / maxDist) * 25);
      }

      const totalScore = skuScore + boxScore - distPenalty;

      evaluatedCandidates.push({
        articleNumber: sku,
        name: prodName,
        boxCurrent: bCurrent,
        boxTotal: bTotal,
        quantityInBox: qInBox,
        score: totalScore,
        rawText: cand.fullText
      });
    }

    if (evaluatedCandidates.length === 0) {
      return {
        articleNumber: '',
        name: '',
        boxCurrent: 1,
        boxTotal: 1,
        quantityInBox: 1,
        rawText
      };
    }

    // Izberi zmagovalnega kandidata z najvišjo oceno (najbolj zanesljiva etiketa najbližje vizirju)
    evaluatedCandidates.sort((a, b) => b.score - a.score);
    const best = evaluatedCandidates[0];

    return {
      articleNumber: best.articleNumber,
      name: best.name,
      boxCurrent: best.boxCurrent,
      boxTotal: best.boxTotal,
      quantityInBox: best.quantityInBox,
      rawText: best.rawText
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
