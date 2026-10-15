# Skladišče PWA (Offline Warehouse Inventory Management)

Sodobna, lahka in popolnoma samostojna mobilna spletna aplikacija (**Progressive Web App**) za upravljanje z zalogo skladišča na telefonu, optimizirana za delovanje **brez internetne povezave (100% offline)**.

---

## ✨ Ključne funkcionalnosti

- 📶 **100% Offline delovanje**: Podatki se varno shranjujejo lokalno v brskalniku prek **IndexedDB**. Service Worker poskrbi, da aplikacija deluje kjerkoli (tudi v kletnih prostorih skladišča brez mobilnega signala).
- 📱 **Optimizirano za telefon**: Zgrajeno z mislijo na mobilne naprave – navigacija na spodnjem robu, veliki gumbi za hitro dodajanje/odvzemanje kosov, prilagojeno za enoročno uporabo.
- 📦 **Natančno vodenje zaloge**:
  - Naziv artikla, koda / SKU / črtna koda
  - Natančna lokacija v skladišču (npr. *Regal B, Polica 3*)
  - Minimalna količina z avtomatskimi opozorili ob pomanjkanju
  - Enota mere (kos, kg, m, škatla, paleta itd.)
- 🔍 **Čitalnik črtnih kod & QR kod**: Integrirana podpora za skeniranje s kamero telefona (kjer brskalnik podpira Barcode Detection API) ali hitro ročno iskanje po kodi.
- 🚚 **Prevzem in Izdaja**: Hitri vnos premikov (+ / -) z beleženjem opomb.
- 📝 **Dnevnik premikov (Zgodovina)**: Pregled vseh preteklih premikov blaga s časovnim žigom.
- 💾 **Izvoz in Uvoz podatkov**:
  - Izvoz v **CSV** (združljivo z Excelom / preglednicami)
  - Izvoz in uvoz celotne varnostne kopije v **JSON**
- 🚀 **Enostavna namestitev (PWA)**: Aplikacijo lahko neposredno v brskalniku na telefonu namestite kot ikono na domači zaslon ("Dodaj na začetni zaslon").

---

## 🚀 Zagon in testiranje

Ker gre za statično spletno aplikacijo, za zagon ne potrebujete zunanjih knjižnic ali namestitve paketov.

### 1. Lokalni zagon
V mapi projekta zaženite lokalni strežnik:

Z Node.js (npx):
```bash
npx serve .
```

Ali s Pythonom:
```bash
python -m http.server 8080
```

Nato v brskalniku odprite:
[http://localhost:8080](http://localhost:8080)

---

## 📱 Namestitev na telefon

1. Aplikacijo naložite na GitHub Pages ali jo zaženite na lokalnem omrežju.
2. Odprite jo na telefonu v brskalniku Chrome (Android) ali Safari (iOS).
3. Izberite meni brskalnika in kliknite **"Namesti aplikacijo"** oz. **"Dodaj na domači zaslon"** (*Add to Home Screen*).
4. Aplikacija se bo odprla v celozaslonskem načinu in bo delovala tudi povsem brez povezave!

---

## 🔗 Povezava z GitHubom

Za prenos tega repozitorija na svoj GitHub račun:

1. Na [GitHub.com](https://github.com/new) ustvarite nov prazen repozitorij (npr. z imenom `skladisce-pwa`).
2. V terminalu zaženite ukaza:
```bash
git remote add origin https://github.com/lanncek55/skladisce-pwa.git
git branch -M main
git push -u origin main
```
