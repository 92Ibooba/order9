// Appels aux API Wave et Orange Money (extrait de la version précédente)
const { WAVE_API_KEY, OM_CLIENT_AUTH, OM_MERCHANT_KEY, OM_CURRENCY = 'XOF', BASE_URL = 'http://localhost:3000' } = process.env;
// ---------- Wave (https://docs.wave.com/checkout) ----------
export const waveCreate = async (p) => {
  const r = await fetch('https://api.wave.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${WAVE_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': p.id },
    body: JSON.stringify({ amount: String(p.amount), currency: 'XOF', client_reference: p.id,
      success_url: `${BASE_URL}/?paid=${p.id}`, error_url: `${BASE_URL}/?failed=${p.id}` }),
  });
  if (!r.ok) throw new Error('Wave ' + r.status);
  const s = await r.json();
  p.ref = s.id;
  return s.wave_launch_url; // à ouvrir dans le navigateur, pas dans une webview
};
export const waveStatus = async (p) => {
  const r = await fetch('https://api.wave.com/v1/checkout/sessions/' + p.ref, { headers: { Authorization: `Bearer ${WAVE_API_KEY}` } });
  const s = await r.json();
  if (s.payment_status === 'succeeded') return 'paid';
  return s.payment_status === 'cancelled' || s.checkout_status === 'expired' ? 'failed' : 'pending';
};

// ---------- Orange Money Web Payment (marchands uniquement ; vérifie les chemins dans ta doc Orange) ----------
export const OM = 'https://api.orange.com/orange-money-webpay/ml/v1';
export const omToken = async () => {
  const r = await fetch('https://api.orange.com/oauth/v3/token', {
    method: 'POST', headers: { Authorization: OM_CLIENT_AUTH, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials' });
  return (await r.json()).access_token;
};
export const omCreate = async (p) => {
  const r = await fetch(OM + '/webpayment', {
    method: 'POST', headers: { Authorization: 'Bearer ' + (await omToken()), 'Content-Type': 'application/json' },
    body: JSON.stringify({ merchant_key: OM_MERCHANT_KEY, currency: OM_CURRENCY, order_id: p.id, amount: p.amount,
      return_url: `${BASE_URL}/?paid=${p.id}`, cancel_url: `${BASE_URL}/?failed=${p.id}`,
      notif_url: `${BASE_URL}/api/webhooks/orange`, lang: 'fr', reference: 'Order' }) });
  const s = await r.json();
  if (!s.payment_url) throw new Error('Orange Money ' + JSON.stringify(s));
  p.ref = s.pay_token;
  return s.payment_url;
};
export const omStatus = async (p) => {
  const r = await fetch(OM + '/transactionstatus', {
    method: 'POST', headers: { Authorization: 'Bearer ' + (await omToken()), 'Content-Type': 'application/json' },
    body: JSON.stringify({ order_id: p.id, amount: p.amount, pay_token: p.ref }) });
  const s = (await r.json()).status;
  return s === 'SUCCESS' ? 'paid' : ['FAILED', 'EXPIRED'].includes(s) ? 'failed' : 'pending';
};

