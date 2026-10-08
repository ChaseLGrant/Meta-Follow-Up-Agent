// The booking link in each text. With click tracking on, the text contains a short link on this
// site (/r/<code>) that counts the click and forwards to Calendly with the parent's name/email
// pre-filled and utm_content=<code>, which Calendly echoes back so we can match the booking.

export function calendlyUrlFor(config, lead) {
  if (!config.calendlyUrl) throw new Error('CALENDLY_URL is not set');
  const u = new URL(config.calendlyUrl);
  const name = [lead.parent_first, lead.parent_last].filter(Boolean).join(' ');
  if (name) u.searchParams.set('name', name);
  if (lead.email) u.searchParams.set('email', lead.email);
  u.searchParams.set('utm_source', 'sms');
  u.searchParams.set('utm_medium', 'follow_up_agent');
  u.searchParams.set('utm_content', lead.link_code);
  return u.toString();
}

export function smsLinkFor(config, lead) {
  if (config.trackLinkClicks && config.publicBaseUrl) return `${config.publicBaseUrl}/r/${lead.link_code}`;
  return calendlyUrlFor(config, lead);
}

// Link-preview bots (iMessage, carriers, social) fetch the link without a human tapping it.
export function isBot(userAgent) {
  return /bot|crawl|spider|preview|facebookexternalhit|slurp|whatsapp|telegram|skype|discord|headless/i.test(
    String(userAgent || ''),
  );
}
