/** Decode JWT payload (no signature verification — for UI only; trust comes from the gateway/backend). */
export function parseJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = base64.length % 4;
    const padded = pad ? base64 + '='.repeat(4 - pad) : base64;
    const json = decodeURIComponent(
      atob(padded)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join(''),
    );
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function uidFromJwtPayload(payload: Record<string, unknown> | null): number | null {
  if (!payload) return null;
  const uid = payload.uid;
  if (typeof uid === 'number' && Number.isFinite(uid)) return uid;
  return null;
}

export function usernameFromJwtPayload(payload: Record<string, unknown> | null): string | null {
  if (!payload) return null;
  const sub = payload.sub;
  return typeof sub === 'string' ? sub : null;
}

export function nameFromJwtPayload(payload: Record<string, unknown> | null): string | null {
  if (!payload) return null;
  const name = payload.name;
  return typeof name === 'string' ? name : null;
}
