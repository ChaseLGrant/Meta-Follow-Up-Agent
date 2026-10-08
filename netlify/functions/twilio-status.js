import { createDeps } from '../../src/deps.js';
import { handleTwilioStatus } from '../../src/handlers/twilio.js';

export default async (req) => handleTwilioStatus(createDeps(), req);
export const config = { path: '/hooks/twilio/status' };
