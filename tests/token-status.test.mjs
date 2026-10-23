import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { tokenExpiryStatus } from '../supabase/functions/send-to-cuez/token-status.ts';
const now = Date.parse('2026-10-23T08:00:00Z');
const jwt = claims => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
const exp = now / 1000 + 4 * 86400;
for (const [name, token, expected] of [
    ['future', jwt({ exp }), 'valid'], ['expired', jwt({ exp: now / 1000 }), 'expired'],
    ['missing', '', 'missing'], ['opaque', 'opaque-token', 'unknown'], ['malformed', 'a.!.b', 'unknown'],
    ['no expiry', jwt({ sub: 'secret user' }), 'unknown'], ['string expiry', jwt({ exp: String(exp) }), 'unknown'],
    ['invalid range', jwt({ exp: 1e99 }), 'unknown'], ['not active', jwt({ exp, nbf: exp - 1 }), 'not-yet-valid'],
]) test(`expiry metadata: ${name}`, () => {
    const result = tokenExpiryStatus(token, now);
    assert.equal(result.status, expected);
    assert.deepEqual(Object.keys(result).sort(), ['checkedAt', 'expiresAt', 'status']);
    assert.equal(result.checkedAt, new Date(now).toISOString());
});
const edgeSource = stripTypeScriptTypes(readFileSync(new URL('../supabase/functions/send-to-cuez/index.ts', import.meta.url), 'utf8').replace(/^import .*;\n/gm, ''), { mode: 'transform' });
function handler({ admin = true, signedIn = true, token = jwt({ exp }), adminError = null } = {}) {
    let serve, reads = 0;
    const context = vm.createContext({ Response, Request, crypto, console, tokenExpiryStatus,
        createClient: () => ({ auth: { getUser: async () => ({ data: signedIn ? { user: { id: 'user' } } : null }) },
            from: table => {
                assert.equal(table, 'admins'); reads++;
                return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: admin ? { user_id: 'user' } : null, error: adminError }) }) }) };
            },
        }),
        Deno: { serve: fn => { serve = fn; }, env: { get: key => ({ CUEZ_BEARER_TOKEN: token, SUPABASE_URL: 'https://example.test', SUPABASE_SERVICE_ROLE_KEY: 'server-only' })[key] } },
    });
    vm.runInContext(edgeSource, context);
    return { run: () => serve(new Request('https://example.test', { method: 'POST', headers: { Authorization: 'Bearer session' }, body: JSON.stringify({ action: 'token-status' }) })), reads: () => reads };
}
test('admin endpoint returns only expiry metadata, including missing token', async () => {
    for (const token of [jwt({ exp, sub: 'private-user', email: 'private@example.test' }), '']) {
        const h = handler({ token }); const res = await h.run();
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.deepEqual(Object.keys(body).sort(), ['checkedAt', 'expiresAt', 'status']);
        assert.equal(h.reads(), 1);
        assert.ok(!JSON.stringify(body).includes('private'));
        if (!token) assert.equal(body.status, 'missing');
    }
});
test('students and unauthenticated callers cannot read token metadata', async () => {
    assert.equal((await handler({ admin: false }).run()).status, 403);
    const h = handler({ signedIn: false });
    assert.equal((await h.run()).status, 401); assert.equal(h.reads(), 0);
    assert.equal((await handler({ adminError: { message: 'Unavailable' } }).run()).status, 500);
});
const html = readFileSync(new URL('../admin.html', import.meta.url), 'utf8');
const uiSource = html.slice(html.indexOf('function cuezTokenPresentation('), html.indexOf('// ── Views'));
function ui(invoke = async () => tokenExpiryStatus(jwt({ exp }), now)) {
    const state = { user: { id: 'admin' }, cuezToken: null, cuezTokenLoading: false, cuezTokenError: false };
    const document = { visibilityState: 'visible', getElementById: () => null };
    const ctx = vm.createContext({ state, document, invokeCuez: invoke, esc: v => String(v) });
    vm.runInContext(uiSource, ctx);
    return { state, document, ctx };
}
test('pill thresholds, server-clock countdown and expired/missing/unknown states', () => {
    const { ctx } = ui();
    for (const [days, tone] of [[4, 'ok'], [3, 'warn'], [2, 'warn'], [1, 'err'], [0, 'err']]) {
        const info = { status: 'valid', checkedAt: new Date(now).toISOString(), expiresAt: new Date(now + days * 86400000).toISOString(), receivedAt: now + 99999999 };
        const result = ctx.cuezTokenPresentation(info, info.receivedAt);
        assert.equal(result.tone, tone);
        if (days === 4) assert.match(result.text, /4 days left/);
        if (days === 0) assert.match(result.text, /expired/);
    }
    for (const status of ['missing', 'not-yet-valid']) assert.equal(ctx.cuezTokenPresentation({ status }, now).tone, 'err');
    assert.equal(ctx.cuezTokenPresentation({ status: 'unknown' }, now).tone, 'warn');
});
test('hidden tabs skip status calls and request failure clears stale green status', async () => {
    let calls = 0;
    const h = ui(async () => { calls++; throw new Error('Offline'); });
    h.document.visibilityState = 'hidden'; await h.ctx.refreshCuezTokenStatus(); assert.equal(calls, 0);
    h.document.visibilityState = 'visible'; h.state.cuezToken = { status: 'valid' };
    await h.ctx.refreshCuezTokenStatus();
    assert.equal(calls, 1); assert.equal(h.state.cuezToken, null); assert.equal(h.state.cuezTokenError, true);
});
test('overlapping checks are skipped and late sign-out responses are ignored', async () => {
    let resolve, calls = 0;
    const h = ui(() => { calls++; return new Promise(r => { resolve = r; }); });
    const pending = h.ctx.refreshCuezTokenStatus();
    await h.ctx.refreshCuezTokenStatus(); assert.equal(calls, 1);
    h.state.user = null; resolve(tokenExpiryStatus(jwt({ exp }), now)); await pending;
    assert.equal(h.state.cuezToken, null);
});
