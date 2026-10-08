import crypto from 'node:crypto';

export function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

// Netlify form "outgoing webhook" notifications send X-Webhook-Signature: a JWS (HS256) signed with
// the secret you set, whose payload is { iss: "netlify", sha256: <hex sha256 of the request body> }.
export function verifyNetlifySignature(token, rawBody, secret) {
  if (!token || !secret) return false;
  const parts = String(token).split('.');
  if (parts.length !== 3) return false;
  const expected = b64url(crypto.createHmac('sha256', secret).update(parts[0] + '.' + parts[1]).digest());
  if (!safeEqual(expected, parts[2])) return false;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
    return claims.iss === 'netlify' && safeEqual(claims.sha256, bodyHash);
  } catch {
    return false;
  }
}

export function signNetlify(rawBody, secret) {
  // Used by tests and scripts/send-test-lead.js to simulate Netlify.
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: 'netlify', sha256: crypto.createHash('sha256').update(rawBody).digest('hex'),
  }));
  const sig = b64url(crypto.createHmac('sha256', secret).update(header + '.' + payload).digest());
  return `${header}.${payload}.${sig}`;
}

// Twilio: X-Twilio-Signature = base64(HMAC-SHA1(authToken, fullUrl + sorted(key + value)...))
export function twilioSignature(url, params, authToken) {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return crypto.createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

export function verifyTwilioSignature(signature, url, params, authToken) {
  if (!signature || !authToken) return false;
  return safeEqual(twilioSignature(url, params, authToken), signature);
}

// Calendly: Calendly-Webhook-Signature: t=<unix>,v1=<hex HMAC-SHA256(key, `${t}.${body}`)>
export function calendlySignature(rawBody, key, t) {
  return crypto.createHmac('sha256', key).update(`${t}.${rawBody}`).digest('hex');
}

export function verifyCalendlySignature(header, rawBody, key, nowMs = Date.now(), toleranceSec = 300) {
  if (!header || !key) return false;
  const parts = Object.fromEntries(String(header).split(',').map((p) => p.trim().split('=')));
  if (!parts.t || !parts.v1) return false;
  if (Math.abs(nowMs / 1000 - Number(parts.t)) > toleranceSec) return false;
  return safeEqual(calendlySignature(rawBody, key, parts.t), parts.v1);
}

export function bearerOk(req, token) {
  if (!token) return false;
  const h = req.headers.get('authorization') || '';
  return safeEqual(h, `Bearer ${token}`);
}

export function basicAuthOk(req, password) {
  if (!password) return false;
  const h = req.headers.get('authorization') || '';
  if (!h.startsWith('Basic ')) return false;
  const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
  const pass = decoded.slice(decoded.indexOf(':') + 1);
  return safeEqual(pass, password);
}

export function randomCode(len = 8) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}
