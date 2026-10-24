import { config } from './config.js';

function formatCause(err: unknown): string {
  if (err && typeof err === 'object' && 'cause' in err && (err as any).cause) {
    return formatCause((err as any).cause);
  }
  if (err instanceof Error) {
    const code = (err as any).code;
    return code ? `${err.message} (${code})` : err.message;
  }
  return String(err);
}

export function safeFetchTarget(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return url.slice(0, 80);
  }
}

export async function httpFetch(
  url: string,
  init?: RequestInit & { label?: string },
): Promise<Response> {
  const label = init?.label || 'fetch';
  const { label: _l, ...rest } = init || {};
  const target = safeFetchTarget(url);

  try {
    return await fetch(url, {
      ...rest,
      signal: rest.signal ?? AbortSignal.timeout(config.fetchTimeoutMs),
    });
  } catch (err) {
    throw new Error(`[${label}] 无法连接 ${target} — ${formatCause(err)}`);
  }
}
