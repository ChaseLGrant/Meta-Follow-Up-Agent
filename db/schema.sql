-- The Athlete Market — follow-up agent schema (Postgres / Supabase).
-- Safe to run more than once.

-- gen_random_uuid() is built in to Postgres 13+ (Supabase runs 15+).

-- One row per family. Deduplicated by phone (and by email when there is no phone).
create table if not exists leads (
  id                    uuid primary key default gen_random_uuid(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  received_at           timestamptz not null,

  parent_first          text,
  parent_last           text,
  phone_e164            text,
  email                 text,
  athlete_first         text,
  athlete_last          text,
  sport                 text,
  grad_year             text,
  city_state            text,
  timezones             text[] not null default '{}',   -- recipient time zone(s) for quiet hours

  lead_source           text,
  campaign              jsonb not null default '{}',    -- utm_*, fbclid, gclid, landing_url, referrer
  form_answers          jsonb not null default '{}',    -- status, timeline, budget, notes, ...
  submission_count      int not null default 1,

  -- Consent + opt-out
  sms_consent           boolean not null default false,
  sms_consent_evidence  jsonb,
  do_not_text           boolean not null default false,
  opted_out_at          timestamptz,

  -- Conversation facts (status is derived from these, see src/status.js)
  status                text not null default 'NEW',
  first_text_sent_at    timestamptz,
  first_delivered_at    timestamptz,
  sms_failed            boolean not null default false,
  sequence_completed_at timestamptz,
  replied_at            timestamptz,
  last_message_at       timestamptz,
  last_message_preview  text,
  last_message_direction text,

  -- Booking
  booking_status        text not null default 'NOT_BOOKED', -- NOT_BOOKED, BOOKED, CANCELED, SHOWED, NO_SHOW
  booked_at             timestamptz,
  appointment_at        timestamptz,
  calendly_invitee_uri  text,
  calendly_reschedule_url text,
  rescheduled_count     int not null default 0,

  -- Calendar link tracking
  link_code             text not null unique,
  link_clicks           int not null default 0,
  first_click_at        timestamptz,

  -- Sales outcome (entered by Chase on the dashboard)
  closed_won            boolean not null default false,
  closed_at             timestamptz
);

create unique index if not exists leads_phone_uniq on leads (phone_e164) where phone_e164 is not null;
create index if not exists leads_email_idx on leads (lower(email));
create index if not exists leads_received_idx on leads (received_at desc);
create index if not exists leads_invitee_idx on leads (calendly_invitee_uri);

-- Every SMS in or out, plus scheduled (not yet sent) automation messages.
create table if not exists messages (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  lead_id        uuid references leads(id) on delete cascade,
  direction      text not null,              -- 'out' | 'in'
  kind           text not null,              -- initial, fu1, fu2, booking_confirm, reply
  to_phone       text,
  from_phone     text,
  body           text not null,
  status         text not null,              -- scheduled, sending, sent, delivered, failed, undelivered,
                                             -- canceled, simulated, blocked_test_mode, received
  scheduled_for  timestamptz,
  claimed_at     timestamptz,
  sent_at        timestamptz,
  attempts       int not null default 0,
  provider_sid   text unique,
  error_code     text,
  error_message  text
);

-- The automated sequence can only ever exist once per lead.
create unique index if not exists messages_sequence_uniq on messages (lead_id, kind)
  where kind in ('initial', 'fu1', 'fu2');
create index if not exists messages_due_idx on messages (scheduled_for) where status = 'scheduled';
create index if not exists messages_lead_idx on messages (lead_id, created_at);

-- Audit trail: consent captured, texts sent, opt-outs, bookings, manual changes.
create table if not exists lead_events (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  lead_id    uuid references leads(id) on delete cascade,
  type       text not null,
  detail     jsonb not null default '{}'
);
create index if not exists lead_events_lead_idx on lead_events (lead_id, at);

-- Webhook idempotency: each provider event is processed at most once.
create table if not exists webhook_events (
  source       text not null,
  external_id  text not null,
  received_at  timestamptz not null default now(),
  primary key (source, external_id)
);

-- Notifications sent to Chase. dedupe_key stops repeat alerts for the same thing.
create table if not exists owner_alerts (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  kind        text not null,
  dedupe_key  text unique,
  lead_id     uuid references leads(id) on delete set null,
  body        text not null,
  delivery    jsonb not null default '{}'
);

-- Lock everything down: the app connects as the database owner from the server.
-- With RLS on and no policies, Supabase's public anon key can read nothing.
alter table leads          enable row level security;
alter table messages       enable row level security;
alter table lead_events    enable row level security;
alter table webhook_events enable row level security;
alter table owner_alerts   enable row level security;

-- Failed dashboard logins (simple brute-force protection).
create table if not exists auth_failures (
  at  timestamptz not null default now(),
  ip  text not null
);
create index if not exists auth_failures_ip_idx on auth_failures (ip, at);
alter table auth_failures enable row level security;
