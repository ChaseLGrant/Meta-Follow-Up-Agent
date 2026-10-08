import { createDeps } from '../../src/deps.js';
import { runScheduler } from '../../src/scheduler.js';
import { log } from '../../src/log.js';

export default async () => {
  try {
    await runScheduler(createDeps());
  } catch (e) {
    log.error('scheduler_crashed', { error: e.message });
  }
  return new Response('ok');
};
export const config = { schedule: '*/5 * * * *' };
