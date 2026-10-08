import { createDeps } from '../../src/deps.js';
import { handleLink } from '../../src/handlers/link.js';

export default async (req, context) => handleLink(createDeps(), req, context.params.code);
export const config = { path: '/r/:code' };
