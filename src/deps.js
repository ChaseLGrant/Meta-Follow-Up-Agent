import { loadConfig } from './config.js';
import { getDb } from './db.js';
import { createTwilioClient } from './sms.js';

// Real dependencies for production. Tests build their own (in-memory DB, fake Twilio, fixed clock).
export function createDeps(env = process.env) {
  const config = loadConfig(env);
  return {
    config,
    db: getDb(config),
    sms: createTwilioClient(config),
    fetch: (...a) => fetch(...a),
    now: () => new Date(),
  };
}
