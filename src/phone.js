// US phone normalization to E.164 (+15555555555). Returns null if it can't be a US mobile/landline.
export function toE164(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  if (d.length !== 10) return null;
  if (/^[01]/.test(d) || /^\d{3}[01]/.test(d)) return null; // invalid area code / exchange
  return '+1' + d;
}
