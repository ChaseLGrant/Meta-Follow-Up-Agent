// The exact texts Chase approved. Edit wording here only.

function clean(name) {
  const s = String(name || '').trim().split(/\s+/)[0] || '';
  if (!s) return '';
  // "JOHN" / "john" -> "John"; leave mixed case (e.g. "McKenzie") alone
  return s === s.toUpperCase() || s === s.toLowerCase() ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s;
}

function possessive(name) {
  return name + "'s";
}

export function initialText({ parentFirst, athleteFirst, link }) {
  const first = clean(parentFirst) || 'there';
  const athlete = clean(athleteFirst);
  if (athlete) {
    return `Hey ${first} — Chase here with The Athlete Market.

Just got the recruiting info you submitted for ${athlete}.

I'd love to hear a little more about where they're at in the recruiting process and see if we can help.

You can grab a quick call with me here:
${link}

If you'd rather, just text me back here with any questions.

Reply STOP to opt out.`;
  }
  return `Hey ${first} — Chase here with The Athlete Market.

Just got the recruiting information you submitted.

I'd love to hear a little more about where your athlete is at in the recruiting process and see if we can help.

You can grab a quick call with me here:
${link}

If you'd rather, just text me back here with any questions.

Reply STOP to opt out.`;
}

export function followUp1Text({ parentFirst, athleteFirst, link }) {
  const first = clean(parentFirst) || 'there';
  const athlete = clean(athleteFirst) || 'your athlete';
  return `Hey ${first} — just wanted to make sure you got my message yesterday.

I'd be happy to take a look at where ${athlete} is in the recruiting process and see whether there's anything we can help with.

Here's my calendar if you'd like to talk:
${link}`;
}

export function followUp2Text({ parentFirst, athleteFirst, link }) {
  const first = clean(parentFirst) || 'there';
  const athlete = clean(athleteFirst);
  const whose = athlete ? possessive(athlete) : "your athlete's";
  return `Hey ${first} — wanted to follow up one last time about ${whose} recruiting.

If you're still looking for help navigating the college recruiting process, I'd be happy to talk through where things currently stand and what I'd recommend as next steps.

You can grab a time here:
${link}

If now isn't the right time, no problem.`;
}

export function bookingConfirmText({ parentFirst, when, rescheduled }) {
  const first = clean(parentFirst) || 'there';
  return rescheduled
    ? `Got it, ${first} — you're now set for ${when}. Talk soon. — Chase`
    : `You're all set, ${first} — I've got you down for ${when}. Looking forward to talking. — Chase`;
}

export function textForKind(kind, vars) {
  if (kind === 'initial') return initialText(vars);
  if (kind === 'fu1') return followUp1Text(vars);
  if (kind === 'fu2') return followUp2Text(vars);
  throw new Error('Unknown sequence message: ' + kind);
}

export function formatWhen(date, timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}
