const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = html.slice(html.indexOf('        function prunePitchTrash()'), html.indexOf('        async function revertStory('));
const unpick = html.slice(html.indexOf('        async function unpickPitch('), html.indexOf('        async function deletePitch('));
function harness(options = {}) {
    const entry = { id: 'old', story: { slug: 'Council', pitchId: 'pitch', script: 'Saved copy' }, orderIndex: 0 };
    const state = { currentBulletinId: 'room', localMode: false, storiesMap: {}, pitchesMap: {}, meta: { order: ['marker-line'] }, ui: { trash: [entry] } };
    const calls = [], errors = [];
    const context = vm.createContext({ state, canMutate: () => true, render() {},
        showError: e => errors.push(e), confirmAction: async () => true,
        conferenceAction: async () => options.dropResult ?? true,
        DB: { errorMessage: e => e.message, restoreStory: async (...args) => {
            calls.push(args);
            if (options.gate) await options.gate;
            if (options.error) throw new Error(options.error);
        } },
    });
    vm.runInContext(source + unpick, context);
    return { context, state, calls, errors, entry };
}
test('rejected stale rescue removes the button without creating a ghost', async () => {
    const h = harness({ error: 'That story can no longer be restored.' });
    await h.context.rescueStory('old');
    assert.equal(h.state.ui.trash.length, 0);
    assert.deepEqual(h.state.storiesMap, {});
    assert.deepEqual(h.state.meta.order, ['marker-line']);
    assert.equal(h.errors.length, 1);
});
test('transient restore failure keeps recovery available and leaves rundown unchanged', async () => {
    const h = harness({ error: 'Network unavailable' });
    await h.context.rescueStory('old');
    assert.equal(h.state.ui.trash[0], h.entry);
    assert.equal(h.entry.restoring, false);
    assert.deepEqual(h.state.storiesMap, {});
});
test('connected restore waits for server sync and preserves a newer synced row', async () => {
    let release;
    const h = harness({ gate: new Promise(resolve => { release = resolve; }) });
    const pending = h.context.rescueStory('old');
    await h.context.rescueStory('old');
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.state.storiesMap, {});
    const synced = { script: 'Newer server version' };
    h.state.storiesMap.old = synced;
    h.state.meta.order.unshift('old');
    release(); await pending;
    assert.equal(h.state.storiesMap.old, synced);
    assert.equal(h.state.meta.order.filter(id => id === 'old').length, 1);
    assert.equal(h.state.ui.trash.length, 0);
});
test('late restore does not change another newsroom', async () => {
    let release;
    const h = harness({ gate: new Promise(resolve => { release = resolve; }) });
    const pending = h.context.rescueStory('old');
    h.state.currentBulletinId = 'other';
    const otherTrash = h.state.ui.trash = [];
    release(); await pending;
    assert.equal(h.state.ui.trash, otherTrash);
    assert.deepEqual(h.state.storiesMap, {});
});
test('local demo still restores its saved copy', async () => {
    const h = harness(); h.state.localMode = true;
    await h.context.rescueStory('old');
    assert.equal(h.state.storiesMap.old.script, 'Saved copy');
    assert.equal(h.state.meta.order[0], 'old');
    assert.equal(h.state.ui.trash.length, 0);
});
for (const pitch of [{ status: 'pitched', storyId: null }, { status: 'picked', storyId: 'new' }]) {
    test(`pitch sync removes obsolete recovery: ${JSON.stringify(pitch)}`, () => {
        const h = harness(); h.state.pitchesMap.pitch = pitch;
        h.context.prunePitchTrash();
        assert.equal(h.state.ui.trash.length, 0);
    });
}
test('pitch sync preserves ordinary trash and still-picked stories', () => {
    const h = harness();
    h.state.pitchesMap.pitch = { status: 'picked', storyId: 'old' };
    h.state.ui.trash.push({ id: 'manual', story: {} });
    h.context.prunePitchTrash();
    assert.equal(h.state.ui.trash.length, 2);
});
test('successful Drop clears its Rescue entry even if pitch refresh was missed', async () => {
    const h = harness(); h.state.pitchesMap.pitch = { storyId: 'old' };
    await h.context.unpickPitch('pitch');
    assert.equal(h.state.ui.trash.length, 0);
});
test('failed Drop preserves Rescue', async () => {
    const h = harness({ dropResult: false }); h.state.pitchesMap.pitch = { storyId: 'old' };
    await h.context.unpickPitch('pitch');
    assert.equal(h.state.ui.trash.length, 1);
});
