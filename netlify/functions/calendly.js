import { createDeps } from '../../src/deps.js';
import { handleCalendlyWebhook } from '../../src/handlers/calendly.js';

export default async (req) => handleCalendlyWebhook(createDeps(), req);
export const config = { path: '/hooks/calendly' };
