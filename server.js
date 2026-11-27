// Order – serveur complet : comptes SMS, base SQLite, Wi-Fi, points, paiements.
// Lancer : npm i && cp .env.example .env && npm start   (Node 22.13+)
import express from 'express';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { waveCreate, waveStatus, omCreate, omStatus } from './payments.js';

const { SECRET = 'dev-secret', DATA_KEY, SMS_CLIENT_AUTH, SMS_SENDER, PORT = 3000 } = process.env;
const KEY = crypto.createHash('sha256').update(DATA_KEY || SECRET).digest();
const COST = 15, OWNER_GAIN = 3, GAIN = 3, DAILY_CAP = 15, RADIUS = 10000;
const PACKS = { 100: 500, 500: 2000, 1000: 3500 }; // points -> FCFA
const BOX = { lat: [12.5, 12.75], lon: [-8.15, -7.85] }; // zone Bamako

const db = new DatabaseSync(process.env.DB_FILE || 'data.db');
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, phone TEXT UNIQUE NOT NULL, name TEXT, sid TEXT, created INTEGER);
CREATE TABLE IF NOT EXISTS otps(phone TEXT PRIMARY KEY, hash TEXT, exp INTEGER, tries INTEGER DEFAULT 0, sent INTEGER);
CREATE TABLE IF NOT EXISTS wifis(id INTEGER PRIMARY KEY, owner INTEGER REFERENCES users(id), name TEXT, type TEXT, quarter TEXT,
  lat REAL, lon REAL, code TEXT, active INTEGER DEFAULT 1, created INTEGER);
CREATE TABLE IF NOT EXISTS unlocks(user INTEGER, wifi INTEGER, PRIMARY KEY(user, wifi));
CREATE TABLE IF NOT EXISTS reports(user INTEGER, wifi INTEGER, PRIMARY KEY(user, wifi));
CREATE TABLE IF NOT EXISTS ledger(id INTEGER PRIMARY KEY, user INTEGER, delta INTEGER, reason TEXT, ref TEXT UNIQUE, created INTEGER);
CREATE TABLE IF NOT EXISTS payments(id TEXT PRIMARY KEY, user INTEGER, points INTEGER, amount INTEGER, provider TEXT, ref TEXT, status TEXT);`);
try { db.exec('ALTER TABLE wifis ADD COLUMN bssid TEXT'); } catch {} // identifiant technique du routeur
const all = (s, ...a) => db.prepare(s).all(...a), one = (s, ...a) => db.prepare(s).get(...a), run = (s, ...a) => db.prepare(s).run(...a);
const balance = (u) => one('SELECT COALESCE(SUM(delta),0) b FROM ledger WHERE user=?', u).b;
const credit = (u, d, reason, ref = null) => run('INSERT OR IGNORE INTO ledger(user,delta,reason,ref,created) VALUES(?,?,?,?,?)', u, d, reason, ref, Date.now());
const tx = (fn) => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
const fail = (status, msg) => Object.assign(new Error(msg), { status });

// Chiffrement des codes Wi-Fi (AES-256-GCM)
const enc = (t) => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const b = Buffer.concat([c.update(t, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), b]).toString('base64'); };
const dec = (s) => { const b = Buffer.from(s, 'base64'), d = crypto.createDecipheriv('aes-256-gcm', KEY, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'); };

// Sessions signées (30 jours)
const sig = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
const makeToken = (uid, sid) => { const p = Buffer.from(JSON.stringify({ uid, sid, exp: Date.now() + 30 * 864e5 })).toString('base64url'); return p + '.' + sig(p); };
const auth = (req, _res, next) => {
  try { const [p, s] = (req.get('authorization') || '').replace('Bearer ', '').split('.');
    if (!p || sig(p) !== s) throw 0; const d = JSON.parse(Buffer.from(p, 'base64url')); if (d.exp < Date.now()) throw 0;
    if (one('SELECT sid FROM users WHERE id=?', d.uid)?.sid !== d.sid) throw 0; // une seule session par numéro
    req.u = d.uid; next();
  } catch { next(fail(401, 'Session expirée ou ouverte sur un autre téléphone. Reconnecte-toi.')); }
};

// SMS (Orange SMS API). Sans identifiants : le code est écrit dans la console.
async function sendSms(phone, text) {
  if (!SMS_CLIENT_AUTH) return console.log(`[SMS test] ${phone} : ${text}`);
  const t = (await (await fetch('https://api.orange.com/oauth/v3/token', { method: 'POST',
    headers: { Authorization: SMS_CLIENT_AUTH, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' })).json()).access_token;
  const from = 'tel:' + SMS_SENDER;
  const r = await fetch(`https://api.orange.com/smsmessaging/v1/outbound/${encodeURIComponent(from)}/requests`, { method: 'POST',
    headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
    body: JSON.stringify({ outboundSMSMessageRequest: { address: 'tel:' + phone, senderAddress: from, outboundSMSTextMessage: { message: text } } }) });
  if (!r.ok) throw fail(502, 'Envoi du SMS impossible');
}
const normPhone = (p = '') => { const s = String(p).replace(/[\s.-]/g, ''); const m = s.match(/^(?:\+223|00223)?(\d{8})$/); if (!m) throw fail(400, 'Numéro malien invalide (8 chiffres).'); return '+223' + m[1]; };
const hashOtp = (phone, code) => crypto.createHash('sha256').update(phone + code + SECRET).digest('hex');
const meters = (a, b, c, d) => { const r = Math.PI / 180, x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2; return Math.round(12742000 * Math.asin(Math.sqrt(x))); };

const app = express();
app.use(express.json({ limit: '10kb' }));
app.use(express.static('public'));
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

// ---------- Compte ----------
// Un numéro = un compte, et une seule session ouverte à la fois (la dernière connexion remplace l'ancienne).
const gate = (phone, mode, name) => {
  const u = one('SELECT id FROM users WHERE phone=?', phone);
  if (mode === 'signup') {
    if (u) throw fail(409, 'Ce numéro a déjà un compte. Connecte-toi.');
    if (!name || name.trim().length < 2 || name.trim().length > 30) throw fail(400, 'Choisis un nom de 2 à 30 caractères.');
  } else if (!u) throw fail(404, 'Aucun compte avec ce numéro. Crée un compte.');
};
app.post('/api/auth/request', h(async (req, res) => {
  const phone = normPhone(req.body.phone); gate(phone, req.body.mode, req.body.name);
  const old = one('SELECT sent FROM otps WHERE phone=?', phone);
  if (old && Date.now() - old.sent < 60000) throw fail(429, 'Attends une minute avant de redemander un code.');
  const code = String(crypto.randomInt(100000, 1000000));
  run('INSERT OR REPLACE INTO otps(phone,hash,exp,tries,sent) VALUES(?,?,?,0,?)', phone, hashOtp(phone, code), Date.now() + 10 * 60000, Date.now());
  await sendSms(phone, `Order : ton code est ${code}. Valable 10 minutes.`);
  res.json({ ok: true });
}));
app.post('/api/auth/verify', h(async (req, res) => {
  const phone = normPhone(req.body.phone), { mode, name } = req.body; gate(phone, mode, name);
  const o = one('SELECT * FROM otps WHERE phone=?', phone);
  if (!o || o.exp < Date.now() || o.tries >= 5) throw fail(400, 'Code expiré. Demande-en un nouveau.');
  if (o.hash !== hashOtp(phone, String(req.body.code || ''))) { run('UPDATE otps SET tries=tries+1 WHERE phone=?', phone); throw fail(400, 'Code incorrect.'); }
  run('DELETE FROM otps WHERE phone=?', phone);
  const sid = crypto.randomUUID(); let id;
  if (mode === 'signup') {
    id = Number(run('INSERT INTO users(phone,name,sid,created) VALUES(?,?,?,?)', phone, name.trim(), sid, Date.now()).lastInsertRowid);
    credit(id, 20, 'Bonus de bienvenue', 'welcome:' + id);
  } else { id = one('SELECT id FROM users WHERE phone=?', phone).id; run('UPDATE users SET sid=? WHERE id=?', sid, id); }
  res.json({ token: makeToken(id, sid) });
}));
app.get('/api/me', auth, h(async (req, res) =>
  res.json({ name: one('SELECT name FROM users WHERE id=?', req.u).name, balance: balance(req.u), history: all('SELECT reason, delta FROM ledger WHERE user=? ORDER BY id DESC LIMIT 30', req.u) })));

// ---------- Wi-Fi ----------
app.get('/api/wifis', auth, h(async (req, res) => {
  const lat = +req.query.lat, lon = +req.query.lon;
  const rows = all(`SELECT w.*, EXISTS(SELECT 1 FROM unlocks u WHERE u.user=? AND u.wifi=w.id) un,
    (SELECT COUNT(*) FROM unlocks WHERE wifi=w.id) ok FROM wifis w WHERE active=1`, req.u);
  res.json(rows.map((w) => { const mine = w.owner === req.u, open = mine || !!w.un;
    return { id: w.id, name: w.name, type: w.type, quarter: w.quarter, lat: w.lat, lon: w.lon, mine, unlocked: open,
      code: open ? dec(w.code) : null, confirmations: w.ok, distance: meters(lat, lon, w.lat, w.lon) }; })
    .filter((w) => w.distance <= RADIUS).sort((a, b) => a.distance - b.distance));
}));
app.post('/api/wifis', auth, h(async (req, res) => {
  const { name, type, quarter, lat, lon, code, consent } = req.body;
  const bssid = req.body.bssid ? String(req.body.bssid).toLowerCase().slice(0, 17) : null;
  if (consent !== true) throw fail(400, 'Tu dois avoir l’autorisation de partager ce Wi-Fi.');
  if (!name?.trim() || !code?.trim() || name.length > 60 || code.length > 64) throw fail(400, 'Nom ou code invalide.');
  if (!(lat > BOX.lat[0] && lat < BOX.lat[1] && lon > BOX.lon[0] && lon < BOX.lon[1])) throw fail(400, 'Le Wi-Fi doit être situé à Bamako.');
  if ((bssid && one('SELECT id FROM wifis WHERE active=1 AND bssid=?', bssid)) ||
      one('SELECT id FROM wifis WHERE active=1 AND lower(name)=lower(?) AND abs(lat-?)<.0005 AND abs(lon-?)<.0005', name.trim(), lat, lon))
    throw fail(409, 'Ce Wi-Fi est déjà enregistré.');
  // Points : 3 par Wi-Fi ajouté, plafonnés à 15 par jour (le jour UTC est celui du Mali). Ajouter plus reste possible, sans points.
  const day = Math.floor(Date.now() / 864e5) * 864e5;
  const earned = one("SELECT COALESCE(SUM(delta),0) s FROM ledger WHERE user=? AND reason LIKE 'Wi-Fi ajouté%' AND created>=?", req.u, day).s;
  const gain = Math.max(0, Math.min(GAIN, DAILY_CAP - earned));
  tx(() => { const r = run('INSERT INTO wifis(owner,name,type,quarter,lat,lon,code,bssid,created) VALUES(?,?,?,?,?,?,?,?,?)',
    req.u, name.trim(), String(type || 'Autre').slice(0, 20), String(quarter || '').slice(0, 60), lat, lon, enc(code.trim()), bssid, Date.now());
    if (gain) credit(req.u, gain, 'Wi-Fi ajouté : ' + name.trim(), 'add:' + r.lastInsertRowid); });
  res.json({ balance: balance(req.u), gain, capReached: earned + gain >= DAILY_CAP });
}));
// Détection : l'application Android envoie les réseaux vus par le téléphone ; on répond enregistré / non enregistré.
app.post('/api/scan', auth, h(async (req, res) => {
  const lat = +req.body.lat, lon = +req.body.lon, seen = new Set(), out = [];
  for (const n of (Array.isArray(req.body.networks) ? req.body.networks : []).slice(0, 100)) {
    const ssid = String(n?.ssid || '').trim().slice(0, 60), bssid = String(n?.bssid || '').toLowerCase().slice(0, 17);
    if (!ssid || seen.has(bssid || ssid)) continue; seen.add(bssid || ssid);
    const w = (bssid && one('SELECT id FROM wifis WHERE active=1 AND bssid=?', bssid)) ||
      one('SELECT id FROM wifis WHERE active=1 AND lower(name)=lower(?) AND abs(lat-?)<.005 AND abs(lon-?)<.005', ssid, lat, lon);
    out.push({ ssid, bssid, level: Number(n.level) || null, status: w ? 'registered' : 'unregistered', wifiId: w ? w.id : null });
  }
  res.json(out);
}));
app.post('/api/wifis/:id/unlock', auth, h(async (req, res) => {
  const out = tx(() => {
    const w = one('SELECT * FROM wifis WHERE id=? AND active=1', req.params.id);
    if (!w) throw fail(404, 'Ce Wi-Fi n’existe plus.');
    if (w.owner === req.u || one('SELECT 1 x FROM unlocks WHERE user=? AND wifi=?', req.u, w.id)) throw fail(409, 'Déjà débloqué.');
    if (balance(req.u) < COST) throw fail(402, `Il te manque ${COST - balance(req.u)} points.`);
    run('INSERT INTO unlocks(user,wifi) VALUES(?,?)', req.u, w.id);
    credit(req.u, -COST, 'Débloqué : ' + w.name, `unlock:${req.u}:${w.id}`);
    credit(w.owner, OWNER_GAIN, 'Ton Wi-Fi a été utilisé : ' + w.name, `use:${req.u}:${w.id}`);
    return dec(w.code);
  });
  res.json({ code: out, balance: balance(req.u) });
}));
app.post('/api/wifis/:id/report', auth, h(async (req, res) => {
  run('INSERT OR IGNORE INTO reports(user,wifi) VALUES(?,?)', req.u, req.params.id);
  if (one('SELECT COUNT(*) n FROM reports WHERE wifi=?', req.params.id).n >= 3) run('UPDATE wifis SET active=0 WHERE id=?', req.params.id);
  res.json({ ok: true });
}));
app.delete('/api/wifis/:id', auth, h(async (req, res) => {
  if (!run('UPDATE wifis SET active=0 WHERE id=? AND owner=?', req.params.id, req.u).changes) throw fail(404, 'Introuvable.');
  res.json({ ok: true });
}));

// ---------- Paiements ----------
app.post('/api/payments', auth, h(async (req, res) => {
  const { provider, points } = req.body, amount = PACKS[points];
  if (!amount || !['wave', 'orange'].includes(provider)) throw fail(400, 'Pack ou moyen de paiement invalide.');
  const p = { id: 'wp_' + crypto.randomUUID(), user: req.u, points, amount, provider, ref: null, status: 'pending' };
  const url = provider === 'wave' ? await waveCreate(p) : await omCreate(p);
  run('INSERT INTO payments VALUES(?,?,?,?,?,?,?)', p.id, p.user, p.points, p.amount, p.provider, p.ref, 'pending');
  res.json({ payment_id: p.id, redirect_url: url });
}));
app.get('/api/payments/:id', auth, h(async (req, res) => {
  const p = one('SELECT * FROM payments WHERE id=? AND user=?', req.params.id, req.u);
  if (!p) throw fail(404, 'Introuvable.');
  if (p.status === 'pending') { p.status = p.provider === 'wave' ? await waveStatus(p) : await omStatus(p); run('UPDATE payments SET status=? WHERE id=?', p.status, p.id); }
  if (p.status === 'paid') credit(p.user, p.points, `${p.points} points achetés (${p.provider})`, 'pay:' + p.id); // ref unique = crédité une seule fois
  res.json({ status: p.status, balance: balance(req.u) });
}));
app.post('/api/webhooks/orange', (_req, res) => res.sendStatus(200));

app.use((e, _req, res, _next) => { if (!e.status) console.error(e); res.status(e.status || 500).json({ error: e.status ? e.message : 'Erreur du serveur.' }); });
app.listen(PORT, () => console.log('Order sur le port ' + PORT));
