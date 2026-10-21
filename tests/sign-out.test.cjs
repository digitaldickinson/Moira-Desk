const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = html.indexOf('        async function signOutBrowser()');
const end = html.indexOf('        function showView(', start);
assert.ok(start >= 0 && end > start);
const source = html.slice(start, end);

function harness(options = {}) {
    const calls = [];
    const storage = {
        moiradesk_my_name: 'Student', moiradesk_bulletin_id: 'room-a',
        other_app_setting: 'keep',
        removeItem(key) { calls.push(['remove', key]); delete this[key]; },
    };
    const state = {
        signingOut: false, localMode: false,
        rooms: [{ id: 'room-a', name: 'Newsroom A' }],
        ui: { editingStoryId: 'story-a', ...options.ui },
    };
    const context = vm.createContext({
        state, supabaseUser: { id: 'user-a' }, localStorage: storage,
        supabase: {
            from(table) {
                return { select() { return { async eq(field, user) {
                    calls.push(['select', table, field, user]);
                    if (options.queryGate) await options.queryGate;
                    return options.queryError ? { error: new Error('Read failed') } : {
                        data: table === 'bulletins' ? [{ id: 'room-a' }, { id: 'room-b' }] : [
                            { id: 'story-a', locked_by_session: 'tab-a' },
                            { id: 'story-b', locked_by_session: 'tab-b' },
                        ],
                    };
                } }; } };
            },
            async rpc(fn, args) {
                calls.push(['rpc', fn, JSON.parse(JSON.stringify(args))]);
                return { error: options.rpcError === fn ? new Error('Release failed') : null };
            },
            auth: { async signOut(args) {
                calls.push(['signOut', args.scope]);
                if (options.authThrows) throw new Error('Network failed');
                return { error: options.authError ? new Error('Sign-out failed') : null };
            } },
        },
        confirm(message) { calls.push(['confirm', message]); return options.confirm !== false; },
        stopLockRefresh() { calls.push(['stop']); },
        startLockRefresh(id) { calls.push(['restart', id]); },
        render(...parts) { calls.push(['render', ...parts]); },
        showError(message) { calls.push(['error', message]); },
        showNotice(...args) { calls.push(['notice', ...args]); },
        unsubAll() { calls.push(['unsubscribe']); },
        location: { reload() { calls.push(['reload']); } },
    });
    vm.runInContext(source, context);
    return { context, state, calls, storage, run: () => context.signOutBrowser() };
}

test('cancel keeps session, draft and settings', async () => {
    const h = harness({ confirm: false });
    await h.run();
    assert.deepEqual(h.calls.map(c => c[0]), ['confirm']);
    assert.equal(h.state.ui.editingStoryId, 'story-a');
    assert.equal(h.storage.moiradesk_my_name, 'Student');
});

test('releases own roles and locks across rooms before local sign-out', async () => {
    const h = harness();
    await h.run();
    assert.deepEqual(h.calls.filter(c => c[0] === 'rpc'), [
        ['rpc', 'unlock_story', { p_story_id: 'story-a', p_session_id: 'tab-a' }],
        ['rpc', 'unlock_story', { p_story_id: 'story-b', p_session_id: 'tab-b' }],
        ['rpc', 'release_producer', { p_bulletin_id: 'room-a' }],
        ['rpc', 'release_producer', { p_bulletin_id: 'room-b' }],
    ]);
    assert.ok(h.calls.filter(c => c[0] === 'select').every(c => c[3] === 'user-a'));
    assert.equal(h.calls.filter(c => c[0] === 'signOut').length, 1);
    assert.deepEqual(h.calls.find(c => c[0] === 'signOut'), ['signOut', 'local']);
    assert.ok(h.calls.findIndex(c => c[0] === 'signOut') > h.calls.findLastIndex(c => c[0] === 'rpc'));
    assert.equal(h.storage.moiradesk_my_name, undefined);
    assert.equal(h.storage.other_app_setting, 'keep');
    assert.equal(h.context.supabaseUser, null);
    assert.equal(h.context.unsubAll, null);
    assert.deepEqual(h.calls.at(-1), ['reload']);
});

for (const options of [{ queryError: true }, { rpcError: 'unlock_story' }, { rpcError: 'release_producer' }, { authError: true }, { authThrows: true }]) {
    test(`failure preserves draft and settings for retry: ${JSON.stringify(options)}`, async () => {
        const h = harness(options);
        await h.run();
        assert.equal(h.state.signingOut, false);
        assert.equal(h.state.ui.editingStoryId, 'story-a');
        assert.equal(h.storage.moiradesk_my_name, 'Student');
        assert.ok(h.calls.some(c => c[0] === 'error'));
        assert.ok(h.calls.some(c => c[0] === 'restart'));
        assert.ok(!h.calls.some(c => c[0] === 'reload' || c[0] === 'remove'));
        if (options.queryError || options.rpcError) assert.ok(!h.calls.some(c => c[0] === 'signOut'));
    });
}

test('a second click does not run a concurrent logout', async () => {
    let release;
    const queryGate = new Promise(resolve => { release = resolve; });
    const h = harness({ queryGate });
    const pending = h.run();
    await h.run();
    assert.equal(h.calls.filter(c => c[0] === 'confirm').length, 1);
    release();
    await pending;
    assert.equal(h.calls.filter(c => c[0] === 'signOut').length, 1);
});

for (const flag of ['saving', 'pitchBusy', 'cuezSending']) {
    test(`waits for ${flag} before signing out`, async () => {
        const h = harness({ ui: { [flag]: true } });
        await h.run();
        assert.deepEqual(h.calls.map(c => c[0]), ['notice']);
        assert.equal(h.state.ui.editingStoryId, 'story-a');
    });
}
