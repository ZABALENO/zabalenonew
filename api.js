/* Klient API – náhrada původního claude.use('db'). Zachovává stejné rozhraní
   (collection/doc, onSnapshot, set, delete), ale data jdou přes /api do PostgreSQL.
   Relativní adresy 'api/...' fungují na kořeni domény i pod podcestou. */
async function api(m, u, b) {
  const r = await fetch('api/' + u, { method: m, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || 'Chyba ' + r.status); e.status = r.status; throw e; }
  return j;
}
const MAP = { tasks: 'production', notifs: 'notifications' }, subs = {};
async function pull(k) {
  try {
    const j = await api('GET', MAP[k] || k);
    (subs[k] || []).forEach(cb => cb(k === 'settings' ? { exists: true, data: () => j } : { docs: j.map(d => ({ id: d.id, data: () => d })) }));
  } catch (e) { if (e.status === 401) location.reload(); }      // 403 (partner nesmí číst finance) se tiše ignoruje
}
let es;
const refresh = () => Object.keys(subs).forEach(pull);
const sub = k => cb => {
  (subs[k] = subs[k] || []).push(cb); pull(k);
  if (!es && window.EventSource) { es = new EventSource('api/events'); es.onmessage = refresh; es.onopen = refresh; }   // živé změny
};
const dbShim = {
  collection: k => ({ onSnapshot: sub(k) }),
  doc: p => {
    const [k, id] = p.split('/');
    return {
      onSnapshot: sub('settings'),
      set: d => k === 'settings' ? api('PUT', 'settings', d) : k === 'notifs' ? api('PUT', 'notifications/' + id + '/read')
        : k === 'tasks' ? api('PUT', 'production/' + id, { status: d.status }) : api('PUT', k + '/' + id, d),
      delete: () => api('DELETE', k + '/' + id)
    };
  }
};
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

function loginView() {
  const $ = s => document.querySelector(s);
  $('#view').innerHTML = `<div class="panel" style="max-width:380px;margin:60px auto;padding:22px"><h3 style="padding:0 0 10px">ZABALENO – přihlášení</h3>
    <form id="lf"><label>Email</label><input type="email" id="le" autocomplete="username" required><label>Heslo</label><input type="password" id="lp" autocomplete="current-password" required>
    <div id="lerr"></div><p><button class="btn gold" type="submit">Přihlásit se</button></p></form></div>`;
  $('#lf').onsubmit = async e => {
    e.preventDefault();
    try { await api('POST', 'login', { email: $('#le').value, password: $('#lp').value }); location.reload(); }
    catch (x) { $('#lerr').innerHTML = '<div class="err">' + x.message + '</div>'; }
  };
}
