import { createDeps } from '../../src/deps.js';
import { handleLeadWebhook } from '../../src/handlers/leadWebhook.js';

export default async (req) => handleLeadWebhook(createDeps(), req);
export const config = { path: '/hooks/lead' };
