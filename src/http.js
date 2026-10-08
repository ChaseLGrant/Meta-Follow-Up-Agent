import { log } from './log.js';

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export const text = (body, status = 200, type = 'text/plain') =>
  new Response(body, { status, headers: { 'Content-Type': `${type}; charset=utf-8` } });

// Wraps a handler: any crash is logged and returns 500 so the provider retries later.
export function safe(name, fn) {
  return async (deps, req, ...rest) => {
    try {
      return await fn(deps, req, ...rest);
    } catch (e) {
      log.error(`${name}_crashed`, { error: e.message, stack: e.stack?.split('\n').slice(0, 4).join(' | ') });
      return json({ ok: false, error: 'internal_error' }, 500);
    }
  };
}
