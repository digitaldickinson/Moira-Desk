// Decode expiry metadata only. This does not verify the signature, revocation
// or Cuez permissions, and must never be used to authorise a request.
export function tokenExpiryStatus(token: string, now = Date.now()) {
  const checkedAt = new Date(now).toISOString();
  const unknown = { status: 'unknown', expiresAt: null, checkedAt };
  if (!token) return { ...unknown, status: 'missing' };
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts.every(Boolean)) return unknown;
    const encoded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')));
    if (typeof payload?.exp !== 'number' || !Number.isFinite(payload.exp)) return unknown;
    const expiry = new Date(payload.exp * 1000);
    if (!Number.isFinite(expiry.getTime())) return unknown;
    const expiresAt = expiry.toISOString();
    if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || !Number.isFinite(payload.nbf))) return unknown;
    if (typeof payload.nbf === 'number' && payload.nbf * 1000 > now) {
      return { status: 'not-yet-valid', expiresAt, checkedAt };
    }
    return { status: expiry.getTime() <= now ? 'expired' : 'valid', expiresAt, checkedAt };
  } catch {
    return unknown;
  }
}
