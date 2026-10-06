/* ZABALENO – backend (Express + PostgreSQL).
   Oprávnění se kontrolují TADY na serveru, ne v prohlížeči. */
'use strict';
const express = require('express'), { Pool } = require('pg'), bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const { DATABASE_URL, JWT_SECRET } = process.env;
if (!DATABASE_URL || !JWT_SECRET) { console.error('Chybí DATABASE_URL nebo JWT_SECRET'); process.exit(1); }
const pool = new Pool({ connectionString: DATABASE_URL, ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false } });

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }), cookieParser());

const bad = (m, s = 400) => Object.assign(new Error(m), { status: s });
const w = f => (q, s, n) => f(q, s, n).catch(n);                 // zachytí chyby async handlerů
async function tx(fn) {                                          // vše nebo nic
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

/* ---- autentizace: JWT v httpOnly cookie, hesla bcrypt ---- */
const auth = (q, s, n) => { try { q.user = jwt.verify(q.cookies.zt, JWT_SECRET); n(); } catch { s.status(401).json({ error: 'Nejste přihlášena' }); } };
const admin = (q, s, n) => q.user.role === 'admin' ? n() : s.status(403).json({ error: 'Nedostatečná oprávnění' });
const fails = new Map();                                         // jednoduchá ochrana proti hádání hesla
app.post('/api/login', w(async (q, s) => {
  const f = fails.get(q.ip) || { n: 0, t: Date.now() };
  if (Date.now() - f.t > 9e5) { f.n = 0; f.t = Date.now(); }
  if (f.n >= 10) throw bad('Příliš mnoho pokusů, zkuste to za 15 minut.', 429);
  const { email, password } = q.body || {};
  const u = (await pool.query('select * from users where email=$1', [String(email || '').trim().toLowerCase()])).rows[0];
  if (!u || !(await bcrypt.compare(String(password || ''), u.password_hash))) { fails.set(q.ip, { n: f.n + 1, t: f.t }); throw bad('Nesprávný email nebo heslo', 401); }
  fails.delete(q.ip);
  s.cookie('zt', jwt.sign({ id: u.id, role: u.role, name: u.name }, JWT_SECRET, { expiresIn: '30d' }),
    { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 30 * 864e5 });
  s.json({ ok: 1 });
}));
app.post('/api/logout', (q, s) => { s.clearCookie('zt'); s.json({ ok: 1 }); });
app.get('/api/me', auth, (q, s) => s.json({ name: q.user.name, role: q.user.role }));

/* ---- živé aktualizace (Server-Sent Events): klient dostane jen „change“ a data si načte sám podle svých práv ---- */
const clients = new Set(), bump = () => clients.forEach(r => r.write('data: change\n\n'));
app.get('/api/events', auth, (q, s) => {
  s.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); s.flushHeaders();
  clients.add(s); const h = setInterval(() => s.write(': ping\n\n'), 25000);
  q.on('close', () => { clearInterval(h); clients.delete(s); });
});

/* ---- pomocné funkce ---- */
const notify = (c, to, text) => c.query('insert into notifications(id,to_role,text,ts) values($1,$2,$3,$4)', [crypto.randomUUID(), to, text, Date.now()]);
const itemDoc = i => ({ pid: i.product_id, pname: i.pname, qty: i.qty, price: +i.price, cost: +i.cost, my: +i.my_share, partner: +i.partner_share, vars: i.vars || {} });
const group = (rows, k) => rows.reduce((m, r) => ((m[r[k]] = m[r[k]] || []).push(itemDoc(r)), m), {});
async function putItems(c, table, fk, id, items) {               // table/fk jsou konstanty z kódu, ne vstup uživatele
  await c.query(`delete from ${table} where ${fk}=$1`, [id]);
  for (const [i, t] of items.entries()) {
    if (!(Number.isInteger(+t.qty) && +t.qty > 0 && +t.price >= 0 && +t.cost >= 0)) throw bad('Neplatná položka (množství nebo cena)');
    await c.query(`insert into ${table}(${fk},pos,product_id,pname,qty,price,cost,my_share,partner_share,vars)
      values($1,$2,(select id from products where id=$3),$4,$5,$6,$7,$8,$9,$10)`,
      [id, i, t.pid || null, t.pname, t.qty, t.price, t.cost, t.my, t.partner, t.vars ? JSON.stringify(t.vars) : null]);
  }
}

/* ---- entity: list / put / del ---- */
const M = {};
M.products = {
  async list() {
    const p = (await pool.query('select * from products order by name')).rows, v = (await pool.query('select * from product_variants order by product_id,pos')).rows;
    return p.map(x => ({ id: x.id, name: x.name, price: +x.price, cost: +x.cost, my: +x.my_share, partner: +x.partner_share, cat: x.category, note: x.note, active: x.active,
      variants: v.filter(y => y.product_id === x.id).map(y => ({ n: y.name, o: y.options })) }));
  },
  async put(c, id, d) {
    if (!String(d.name || '').trim()) throw bad('Zadejte název produktu');
    if (Math.abs(+d.my + +d.partner - 100) > 1e-9) throw bad('Podíly musí dávat dohromady 100 %');
    await c.query(`insert into products(id,name,price,cost,my_share,partner_share,category,note,active) values($1,$2,$3,$4,$5,$6,$7,$8,$9)
      on conflict(id) do update set name=$2,price=$3,cost=$4,my_share=$5,partner_share=$6,category=$7,note=$8,active=$9`,
      [id, d.name.trim(), d.price, d.cost, d.my, d.partner, d.cat || '', d.note || '', d.active !== false]);
    await c.query('delete from product_variants where product_id=$1', [id]);
    for (const [i, v] of (d.variants || []).entries()) await c.query('insert into product_variants(product_id,pos,name,options) values($1,$2,$3,$4)', [id, i, v.n, v.o]);
  },
  del: (c, id) => c.query('delete from products where id=$1', [id])
};
M.orders = {
  async list() {
    const o = (await pool.query(`select *,to_char(order_date,'YYYY-MM-DD') d,to_char(due,'YYYY-MM-DD') dd from orders order by order_date desc,ts desc`)).rows;
    const g = group((await pool.query('select * from order_items order by order_id,pos')).rows, 'order_id');
    return o.map(x => ({ id: x.id, num: x.num, date: x.d, due: x.dd || '', customer: x.customer, contact: x.contact, ship: x.ship, note: x.note, status: x.status, ts: +x.ts, items: g[x.id] || [] }));
  },
  // Jedna transakce: objednávka + položky + výrobní úkol + prodej + upozornění partnerovi.
  async put(c, id, d) {
    if (!String(d.customer || '').trim() || !String(d.num || '').trim() || !Array.isArray(d.items) || !d.items.length || !d.date) throw bad('Neplatná objednávka');
    const isNew = !(await c.query('select 1 from orders where id=$1', [id])).rowCount, due = d.due || '';
    await c.query(`insert into orders(id,num,order_date,due,customer,contact,ship,note,status,ts) values($1,$2,$3,nullif($4,'')::date,$5,$6,$7,$8,$9,$10)
      on conflict(id) do update set num=$2,order_date=$3,due=nullif($4,'')::date,customer=$5,contact=$6,ship=$7,note=$8,status=$9`,
      [id, d.num.trim(), d.date, due, d.customer.trim(), d.contact || '', d.ship || '', d.note || '', d.status || 'nova', d.ts || Date.now()]);
    await putItems(c, 'order_items', 'order_id', id, d.items);
    await c.query(`insert into production_tasks(id,order_id,num,customer,due,note,items,status,ts) values($1,$1,$2,$3,nullif($4,'')::date,$5,$6,'new',$7)
      on conflict(id) do update set num=$2,customer=$3,due=nullif($4,'')::date,note=$5,items=$6`,
      [id, d.num.trim(), d.customer.trim(), due, d.note || '', JSON.stringify(d.items.map(i => ({ pname: i.pname, qty: i.qty, vars: i.vars }))), Date.now()]);
    if (d.status === 'zruseno') await c.query('delete from sales where id=$1', ['o_' + id]);
    else {
      await c.query(`insert into sales(id,order_id,num,sale_date,ts) values($1,$2,$3,$4,$5) on conflict(id) do update set num=$3,sale_date=$4`, ['o_' + id, id, d.num.trim(), d.date, Date.now()]);
      await putItems(c, 'sale_items', 'sale_id', 'o_' + id, d.items);
    }
    if (isNew) await notify(c, 'partner', `Objednávka #${d.num.trim()} čeká na výrobu: ${d.items.map(i => `${i.qty}× ${i.pname}`).join(', ')}.`);
  },
  del: (c, id) => c.query('delete from orders where id=$1', [id])     // kaskádou smaže položky, výrobní úkol i prodej
};
M.sales = {
  async list() {
    const s = (await pool.query(`select *,to_char(sale_date,'YYYY-MM-DD') d from sales order by sale_date desc,ts desc`)).rows;
    const g = group((await pool.query('select * from sale_items order by sale_id,pos')).rows, 'sale_id');
    return s.map(x => ({ id: x.id, oid: x.order_id, num: x.num, date: x.d, ts: +x.ts, lines: g[x.id] || [] }));
  },
  async put(c, id, d) {
    if (!d.date || !Array.isArray(d.lines) || !d.lines.length) throw bad('Neplatný prodej');
    const ex = (await c.query('select order_id from sales where id=$1', [id])).rows[0];
    if (ex && ex.order_id) throw bad('Prodej z objednávky se mění přes objednávku', 409);
    await c.query('insert into sales(id,sale_date,ts) values($1,$2,$3) on conflict(id) do update set sale_date=$2', [id, d.date, d.ts || Date.now()]);
    await putItems(c, 'sale_items', 'sale_id', id, d.lines);
  },
  async del(c, id) {
    const ex = (await c.query('select order_id from sales where id=$1', [id])).rows[0];
    if (ex && ex.order_id) throw bad('Prodej z objednávky se maže přes objednávku', 409);
    await c.query('delete from sales where id=$1', [id]);
  }
};
M.production = {                                                  // partner smí číst a měnit POUZE stav
  async list() {
    return (await pool.query(`select *,to_char(due,'YYYY-MM-DD') dd from production_tasks order by ts desc`)).rows
      .map(t => ({ id: t.id, oid: t.order_id, num: t.num, customer: t.customer, due: t.dd || '', note: t.note, items: t.items, status: t.status, ts: +t.ts }));
  },
  async put(c, id, d) {
    const s = d.status; if (!['new', 'read', 'progress', 'done'].includes(s)) throw bad('Neplatný stav');
    const t = (await c.query('update production_tasks set status=$2 where id=$1 returning num', [id, s])).rows[0]; if (!t) throw bad('Úkol nenalezen', 404);
    const o = (await c.query('select status from orders where id=$1', [id])).rows[0].status;
    const st = s === 'progress' && o === 'nova' ? 'vyroba' : s === 'done' && ['nova', 'vyroba'].includes(o) ? 'vyrobeno' : null;
    if (st) await c.query('update orders set status=$2 where id=$1', [id, st]);
    if (s === 'progress') await notify(c, 'admin', `Výroba objednávky #${t.num} byla zahájena.`);
    if (s === 'done') await notify(c, 'admin', `Objednávka #${t.num} byla dokončena.`);
  }
};

function crud(name, m, ...guards) {
  const ok = id => /^[\w-]{1,64}$/.test(String(id)) ? id : (() => { throw bad('Neplatné ID'); })();
  app.get(`/api/${name}`, auth, ...guards, w(async (q, s) => s.json(await m.list())));
  const up = w(async (q, s) => { await tx(c => m.put(c, ok(q.params.id || q.body.id), q.body || {})); bump(); s.json({ ok: 1 }); });
  app.post(`/api/${name}`, auth, ...guards, up); app.put(`/api/${name}/:id`, auth, ...guards, up);
  if (m.del) app.delete(`/api/${name}/:id`, auth, ...guards, w(async (q, s) => { await tx(c => m.del(c, ok(q.params.id))); bump(); s.json({ ok: 1 }); }));
}
crud('products', M.products, admin); crud('orders', M.orders, admin); crud('sales', M.sales, admin); crud('production', M.production);

app.get('/api/notifications', auth, w(async (q, s) => s.json((await pool.query('select * from notifications where to_role=$1 order by ts desc limit 100', [q.user.role]))
  .rows.map(n => ({ id: n.id, to: n.to_role, text: n.text, ts: +n.ts, read: n.read })))));
app.put('/api/notifications/:id/read', auth, w(async (q, s) => { await pool.query('update notifications set read=true where id=$1 and to_role=$2', [q.params.id, q.user.role]); s.json({ ok: 1 }); }));
app.get('/api/settings', auth, w(async (q, s) => s.json((await pool.query("select value from settings where key='main'")).rows[0]?.value || {})));
app.put('/api/settings', auth, admin, w(async (q, s) => {
  const { me, partner } = q.body || {};
  await pool.query("insert into settings(key,value) values('main',$1) on conflict(key) do update set value=$1", [JSON.stringify({ me: String(me || 'Já').slice(0, 60), partner: String(partner || 'Partner').slice(0, 60) })]);
  bump(); s.json({ ok: 1 });
}));

app.get('/healthz', (q, s) => s.send('ok'));
app.use('/api', (q, s) => s.status(404).json({ error: 'Nenalezeno' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use((e, q, s, n) => {                                         // jednotné ošetření chyb
  const code = e.status || ({ '23505': 409, '23514': 400, '23502': 400, '22P02': 400, '22007': 400 })[e.code] || 500;
  if (code === 500) console.error(e);
  s.status(code).json({ error: code === 500 ? 'Chyba serveru' : e.code === '23505' ? 'Duplicitní hodnota (např. číslo objednávky už existuje)' : e.message });
});

/* ---- start: schéma + první účty z proměnných prostředí ---- */
async function seedUsers() {
  for (const [p, role, name] of [['ADMIN', 'admin', 'Veronika'], ['PARTNER', 'partner', 'Partner']]) {
    const e = process.env[p + '_EMAIL'], pw = process.env[p + '_PASSWORD']; if (!e || !pw) continue;
    await pool.query('insert into users(email,name,role,password_hash) values($1,$2,$3,$4) on conflict(email) do update set password_hash=$4,role=$3',
      [e.trim().toLowerCase(), name, role, await bcrypt.hash(pw, 12)]);
  }
}
(async () => {
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  await seedUsers();
  app.listen(process.env.PORT || 3000, () => console.log('ZABALENO běží'));
})().catch(e => { console.error(e); process.exit(1); });
