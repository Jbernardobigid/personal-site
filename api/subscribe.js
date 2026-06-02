// api/subscribe.js — Vercel serverless function
// Adds a newsletter subscriber to the Resend Audience.
// Secrets are read from the environment (never hardcoded):
//   RESEND_API_KEY      — Resend API key (send/contacts scope)
//   RESEND_AUDIENCE_ID  — the default Resend audience id
// The on-site form (#newsletter-form in index.html) POSTs { email } here.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// In-memory rate limiter: max 5 requests per IP per 15 minutes.
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const ipHits = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const entry = ipHits.get(ip) || { count: 0, resetAt: now + RATE_WINDOW_MS };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + RATE_WINDOW_MS;
  }
  entry.count += 1;
  ipHits.set(ip, entry);
  return entry.count > RATE_LIMIT;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).json({ ok: false, error: 'Muitas tentativas. Tente de novo em alguns minutos.' });
  }

  const apiKey = process.env.RESEND_API_KEY;
  const audienceId = process.env.RESEND_AUDIENCE_ID;
  if (!apiKey || !audienceId) {
    console.error('subscribe: missing RESEND_API_KEY or RESEND_AUDIENCE_ID');
    return res.status(500).json({ ok: false, error: 'Serviço indisponível no momento.' });
  }

  // Body may arrive already parsed (object) or as a raw string, depending on
  // how the request was sent. Normalize to an object.
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  // Honeypot: a hidden field real users never see. If it's filled, it's a bot —
  // return a fake success so the bot doesn't learn anything, and skip Resend.
  if (typeof body.company === 'string' && body.company.trim() !== '') {
    return res.status(200).json({ ok: true });
  }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return res.status(400).json({ ok: false, error: 'Email inválido.' });
  }

  try {
    const r = await fetch(`https://api.resend.com/audiences/${audienceId}/contacts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, unsubscribed: false }),
    });

    if (r.ok) {
      return res.status(200).json({ ok: true });
    }

    const detail = await r.text();
    // An already-subscribed email isn't an error — treat it as success.
    if (r.status === 409 || /already|exists|duplicate/i.test(detail)) {
      return res.status(200).json({ ok: true });
    }

    console.error('subscribe: Resend error', r.status, detail);
    return res.status(502).json({ ok: false, error: 'Não foi possível inscrever agora. Tente de novo.' });
  } catch (err) {
    console.error('subscribe: fetch failed', err);
    return res.status(502).json({ ok: false, error: 'Não foi possível inscrever agora. Tente de novo.' });
  }
}
