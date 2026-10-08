// Structured JSON logs (visible in Netlify → Functions → Logs). Never log full phone numbers,
// emails, or message bodies — use mask() for identifiers.

export function maskPhone(p) {
  if (!p) return p;
  return String(p).replace(/\d(?=\d{4})/g, '•');
}

function write(level, msg, fields) {
  const line = JSON.stringify({ level, msg, ...fields, t: new Date().toISOString() });
  if (level === 'error') console.error(line);
  else if (process.env.NODE_ENV !== 'test' && !process.env.QUIET_LOGS) console.log(line);
}

export const log = {
  info: (msg, f = {}) => write('info', msg, f),
  warn: (msg, f = {}) => write('warn', msg, f),
  error: (msg, f = {}) => write('error', msg, f),
};
