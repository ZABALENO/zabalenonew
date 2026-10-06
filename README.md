# ZABALENO – objednávky, výroba a zisk (GitHub + Render + PostgreSQL)

Vzhled, texty, výpočty, stavy, varianty i import jsou **beze změny** z původního HTML. Změnila se jen datová vrstva: místo `claude.use('db')` a `claude.use('user')` frontend volá vlastní API a data jsou v PostgreSQL.

## Soubory
| Soubor | Účel |
|---|---|
| `public/index.html` | původní aplikace (upravené jen místa s databází, přihlášením a odhlášením) |
| `public/api.js` | klient API; nahrazuje `claude.use('db')`, obsahuje přihlašovací formulář a živé aktualizace |
| `server.js` | Express backend: přihlášení, kontrola rolí, API, transakce |
| `schema.sql` | PostgreSQL tabulky (users, products, product_variants, orders, order_items, sales, sale_items, production_tasks, notifications, settings) |
| `package.json`, `render.yaml`, `.env.example`, `.gitignore` | konfigurace; složku `node_modules` (pokud ji vidíte) **nenahrávejte** |

## Co se změnilo oproti původní aplikaci
- Přihlášení: vlastní (email + heslo, bcrypt, httpOnly cookie). Role `admin` (vidí vše) a `partner` (jen výroba).
- **Role hlídá server**: partner dostane z `/api/sales`, `/api/orders`, `/api/products` chybu 403. Testováno.
- Vytvoření/úprava objednávky je **jedna databázová transakce**: objednávka + položky + výrobní úkol + prodej + upozornění partnerovi. Při chybě se nezapíše nic.
- Změna výrobního stavu (server): upraví i stav objednávky a pošle upozornění adminovi (zahájení, dokončení). Zrušená objednávka ztrácí prodej. Smazání produktu nechá staré objednávky a prodeje.
- Živé aktualizace přes Server-Sent Events (bez Socket.IO): změna se druhému uživateli ukáže do vteřiny bez obnovení.
- Statistiky se dál počítají v prohlížeči z dat v databázi, nic se neukládá zvlášť.
- Dvě drobné odchylky: v Nastavení „Zobrazit jako partner“ vidí admin jen upozornění pro admina (partnerova upozornění vidí jen partner po přihlášení) a hláška o roli Contributor zmizela.

## Nasazení krok za krokem
1. **GitHub:** vytvořte repozitář a nahrajte soubory výše (včetně složky `public`). Nenahrávejte `node_modules`.
2. **Databáze na Renderu:** *New + → PostgreSQL*, název `zabaleno-db`, region stejný jako web, plán podle potřeby. Pozor: bezplatná databáze má omezenou platnost (v době psaní 30 dní), pro trvalá data zvolte placený plán a ověřte aktuální podmínky na render.com/pricing.
3. **Web Service:** *New + → Web Service* → vyberte repozitář. Runtime `Node`, Build Command `npm install`, Start Command `npm start`. Server naslouchá na `process.env.PORT`.
   - Rychlejší cesta: *New + → Blueprint* použije `render.yaml` a vytvoří databázi i službu najednou.
4. **Proměnné (Environment) u Web Service:**
   - `DATABASE_URL` = *Internal Database URL* z karty databáze (nikdy ji nedávejte do kódu)
   - `JWT_SECRET` = dlouhý náhodný text
   - `NODE_ENV` = `production`
   - `ADMIN_EMAIL`, `ADMIN_PASSWORD` = váš účet admin
   - `PARTNER_EMAIL`, `PARTNER_PASSWORD` = účet partnera
5. **Deploy.** Při prvním startu server sám vytvoří tabulky a oba účty (heslo se uloží zahashované). Změnu hesla provedete úpravou proměnné a novým deployem.
6. Otevřete adresu `https://zabaleno.onrender.com` (název dle vaší služby) a přihlaste se.

## Vlastní doména
`https://vpdesign.cz/zabaleno` jako cesta **pod stávajícím webem** Render sám nezvládne (doménu vpdesign.cz obsluhuje váš současný hosting). Dvě možnosti:
- **Doporučeno:** subdoména, např. `zabaleno.vpdesign.cz`. V Renderu *Settings → Custom Domains → Add*, u správce domény přidejte záznam CNAME, který Render ukáže. Aplikace používá relativní adresy `api/...`, takže žádné nastavení v kódu není potřeba.
- Cesta `/zabaleno/`: na hostingu vpdesign.cz nastavte reverzní proxy na adresu z Renderu. Aplikace pod ní funguje (adresa musí končit lomítkem `/zabaleno/`).

## Ověření, že se data ukládají trvale
1. Přihlaste se jako admin, vytvořte produkt a objednávku.
2. V jiném prohlížeči (nebo anonymním okně) se přihlaste jako partner: objednávka je ve Výrobě a upozornění ve zvonku.
3. Partner klikne PŘEČTENO → ZAHÁJIT VÝROBU; admin vidí změnu i upozornění bez obnovení stránky.
4. Zavřete prohlížeč, otevřete znovu a přihlaste se: vše tam je. V Renderu klikněte *Manual Deploy → Restart/Deploy*: data zůstanou, protože jsou v databázi.

## Přenos starých dat
V aplikaci *Nastavení → Import ze staré verze* vložte JSON zálohu (`{"products":[...],"sales":[...]}`), stejně jako dřív. Starý formát s objednávkami se automaticky převést nedá, protože původní aplikace pro ně žádný export neměla.

## Co jsem nedělal / omezení
- Nasazení na samotný Render jsem nezkoušel (nemám k němu přístup). Lokálně jsem ověřil celé API proti skutečné PostgreSQL (přihlášení, role, objednávka → výroba → upozornění, zrušení, smazání produktu).
- Prohlížečové rozhraní jsem v prohlížeči nevyzkoušel, jen zkontroloval syntaxi skriptů.
- Nejsou automatické testy, reset hesla emailem ani dvoufázové přihlášení.
