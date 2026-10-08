import { createDeps } from '../../src/deps.js';
import { handleTwilioInbound } from '../../src/handlers/twilio.js';

export default async (req) => handleTwilioInbound(createDeps(), req);
export const config = { path: '/hooks/twilio/inbound' };
