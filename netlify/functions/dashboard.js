import { createDeps } from '../../src/deps.js';
import { handleDashboard } from '../../src/dashboard.js';

export default async (req) => handleDashboard(createDeps(), req);
export const config = { path: '/dashboard' };
