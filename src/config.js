// All settings come from environment variables. Secrets never reach the browser.

function bool(v, dflt) {
  if (v === undefined || v === '') return dflt;
  return /^(1|true|yes|on)$/i.test(String(v));
}
function int(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}
function list(v) {
  return String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(env = process.env) {
  return {
    // Public URL of this follow-up site (no trailing slash), e.g. https://follow-up.theathletemarket.com
    publicBaseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
    databaseUrl: env.DATABASE_URL || '',

    // SMS safety switch:
    //   dry_run (default) — nothing is sent; messages are saved as "simulated"
    //   test              — only numbers in SMS_TEST_ALLOWLIST receive texts
    //   live              — real texts to leads (only after Chase approves go-live)
    smsMode: ['dry_run', 'test', 'live'].includes(env.SMS_MODE) ? env.SMS_MODE : 'dry_run',
    smsTestAllowlist: list(env.SMS_TEST_ALLOWLIST),

    twilio: {
      accountSid: env.TWILIO_ACCOUNT_SID || '',
      authToken: env.TWILIO_AUTH_TOKEN || '',
      messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID || '',
      fromNumber: env.TWILIO_FROM_NUMBER || '',
    },

    calendlyUrl: env.CALENDLY_URL || '',
    calendlySigningKey: env.CALENDLY_WEBHOOK_SIGNING_KEY || '',
    trackLinkClicks: bool(env.TRACK_LINK_CLICKS, true),

    netlifyWebhookSecret: env.NETLIFY_WEBHOOK_SECRET || '', // JWS secret on the form's outgoing webhook
    leadIntakeToken: env.LEAD_INTAKE_TOKEN || '',            // bearer token for any other lead source

    // Notifications to Chase
    ownerName: env.OWNER_NAME || 'Chase',
    ownerPhone: env.OWNER_PHONE || '',
    ownerEmail: env.OWNER_EMAIL || '',
    resendApiKey: env.RESEND_API_KEY || '',
    alertFromEmail: env.ALERT_FROM_EMAIL || '',
    ownerTimezone: env.OWNER_TIMEZONE || 'America/Los_Angeles',

    dashboardPassword: env.DASHBOARD_PASSWORD || '',

    // Compliance + pacing
    quietStartHour: int(env.SEND_WINDOW_START_HOUR, 8), // earliest local hour to text a lead
    quietEndHour: int(env.SEND_WINDOW_END_HOUR, 20),    // texts must go out before this local hour
    followUp1Hours: int(env.FOLLOW_UP_1_HOURS, 24),
    followUp2Hours: int(env.FOLLOW_UP_2_HOURS, 72),
    maxSmsPerHour: int(env.MAX_SMS_PER_HOUR, 60),
    leadSilenceAlertHours: int(env.LEAD_SILENCE_ALERT_HOURS, 48),
    failureAlertThreshold: int(env.FAILURE_ALERT_THRESHOLD, 3),
  };
}
