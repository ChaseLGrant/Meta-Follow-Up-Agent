// Quiet hours: only text a lead between SEND_WINDOW_START_HOUR and SEND_WINDOW_END_HOUR in THEIR
// local time (default 8am–8pm; stricter than the federal 8am–9pm rule and covers states like FL/OK
// that cap at 8pm). Time zone comes from the City/State field on the form. When a state spans
// more than one zone, or the state is unknown, the time must be allowed in EVERY possible zone.

const ET = 'America/New_York', CT = 'America/Chicago', MT = 'America/Denver', PT = 'America/Los_Angeles';
const AZ = 'America/Phoenix', AK = 'America/Anchorage', HI = 'Pacific/Honolulu';

export const CONTINENTAL_US = [ET, CT, MT, AZ, PT];

const STATE_ZONES = {
  AL: [CT], AK: [AK, 'America/Adak'], AZ: [AZ, MT], AR: [CT], CA: [PT], CO: [MT], CT: [ET], DE: [ET],
  DC: [ET], FL: [ET, CT], GA: [ET], HI: [HI], ID: [MT, PT], IL: [CT], IN: [ET, CT], IA: [CT],
  KS: [CT, MT], KY: [ET, CT], LA: [CT], ME: [ET], MD: [ET], MA: [ET], MI: [ET, CT], MN: [CT],
  MS: [CT], MO: [CT], MT: [MT], NE: [CT, MT], NV: [PT, MT], NH: [ET], NJ: [ET], NM: [MT], NY: [ET],
  NC: [ET], ND: [CT, MT], OH: [ET], OK: [CT], OR: [PT, MT], PA: [ET], RI: [ET], SC: [ET],
  SD: [CT, MT], TN: [ET, CT], TX: [CT, MT], UT: [MT], VT: [ET], VA: [ET], WA: [PT], WV: [ET],
  WI: [CT], WY: [MT], PR: ['America/Puerto_Rico'],
};

const STATE_NAMES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY',
  louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'puerto rico': 'PR',
};

// "Carlsbad, CA" / "Austin, Texas" / "TX" -> ['America/Chicago', 'America/Denver']
export function zonesForCityState(cityState) {
  const s = String(cityState || '').trim().toLowerCase().replace(/\.$/, '');
  if (!s) return CONTINENTAL_US;
  const tail = s.split(',').pop().trim().replace(/\./g, '');
  const code = STATE_ZONES[tail.toUpperCase()] ? tail.toUpperCase() : STATE_NAMES[tail];
  if (code) return STATE_ZONES[code];
  const m = s.match(/\b([a-z]{2})$/);
  if (m && STATE_ZONES[m[1].toUpperCase()]) return STATE_ZONES[m[1].toUpperCase()];
  for (const [name, c] of Object.entries(STATE_NAMES)) if (s.endsWith(name)) return STATE_ZONES[c];
  return CONTINENTAL_US;
}

function localMinutes(date, zone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === 'hour').value);
  const m = Number(parts.find((p) => p.type === 'minute').value);
  return h * 60 + m;
}

export function isWithinSendWindow(date, zones, startHour, endHour) {
  const list = zones && zones.length ? zones : CONTINENTAL_US;
  return list.every((z) => {
    const mins = localMinutes(date, z);
    return mins >= startHour * 60 && mins < endHour * 60;
  });
}

// The earliest time >= date that is inside the send window (5-minute resolution).
export function nextSendTime(date, zones, startHour, endHour) {
  if (isWithinSendWindow(date, zones, startHour, endHour)) return new Date(date);
  const step = 5 * 60 * 1000;
  let t = Math.ceil(date.getTime() / step) * step;
  for (let i = 0; i < 12 * 24 * 3; i++, t += step) {
    if (isWithinSendWindow(new Date(t), zones, startHour, endHour)) return new Date(t);
  }
  throw new Error('No valid send window found for zones ' + zones.join(','));
}
