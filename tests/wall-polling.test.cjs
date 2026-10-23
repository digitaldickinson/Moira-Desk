const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
for (const file of ['tutor.html', 'admin.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const source = html.slice(html.indexOf("document.addEventListener('visibilitychange'"), html.indexOf('function renderWall()'));
    function harness() {
        const calls = [], listeners = {}, renders = [];
        const document = { visibilityState: 'visible', addEventListener: (name, fn) => { listeners[name] = fn; } };
        const wall = { ids: ['room'], sig: '' };
        const context = vm.createContext({ wall, document, Date, JSON,
            rpc: (name, args) => new Promise((resolve, reject) => calls.push({ name, args, resolve, reject })),
            renderWall: () => renders.push(context.wall.data),
        });
        vm.runInContext(source, context);
        return { context, wall, document, listeners, calls, renders };
    }
    test(`${file}: hidden tabs skip polls and returning refreshes immediately`, async () => {
        const h = harness(); h.document.visibilityState = 'hidden';
        await h.context.pollWall(true); await h.context.pollWall();
        assert.equal(h.calls.length, 0);
        h.document.visibilityState = 'visible'; h.listeners.visibilitychange();
        assert.equal(h.calls.length, 1);
        h.calls[0].resolve(['fresh']); await new Promise(setImmediate);
        assert.deepEqual(h.wall.data, ['fresh']);
    });
    test(`${file}: timer ticks skip active requests, then resume after failure`, async () => {
        const h = harness();
        const first = h.context.pollWall(true);
        await h.context.pollWall(true);
        assert.equal(h.calls.length, 1);
        h.calls[0].reject(new Error('Offline')); await first;
        assert.equal(h.wall.inFlight, 0);
        const next = h.context.pollWall(true);
        assert.equal(h.calls.length, 2);
        h.calls[1].resolve(['recovered']); await next;
        assert.deepEqual(h.wall.data, ['recovered']);
    });
    test(`${file}: note refresh supersedes an older poll without timer overlap`, async () => {
        const h = harness(); const old = h.context.pollWall(true);
        const fresh = h.context.pollWall();
        h.calls[1].resolve(['new note']); await fresh;
        await h.context.pollWall(true);
        assert.equal(h.calls.length, 2);
        h.calls[0].resolve(['old note']); await old;
        assert.deepEqual(h.wall.data, ['new note']);
        assert.equal(h.renders.length, 1);
        assert.equal(h.wall.inFlight, 0);
    });
    test(`${file}: closed or replaced walls ignore pending responses`, async () => {
        const h = harness(); const pending = h.context.pollWall();
        h.context.wall = { ids: ['another room'] };
        h.calls[0].resolve(['old wall']); await pending;
        assert.equal(h.renders.length, 0);
        h.context.wall = null; h.listeners.visibilitychange();
        assert.equal(h.calls.length, 1);
    });
}
