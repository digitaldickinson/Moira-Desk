// External Playwright only; no live accounts or network calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.MOIRA_PLAYWRIGHT_MODULE || 'playwright');
const source = fs.readFileSync(path.join(__dirname, '..', 'prompt.html'), 'utf8');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  async function open(options = {}) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(options => {
      const script = 'Hello *world*.\n[STRAP: Name | Job title]\n[CLIP:0:12 Interview | SOT | LW: Thank you]\n[CAM 2]\n<script>bad()</script>\n' + 'More script for the presenter.\n'.repeat(35);
      const rows = [
        { id: 'a1', slug: 'First story', script, duration: 50, format: 'PKG' },
        { id: 'seg', slug: 'Weather', type: 'segment' },
        { id: 'a2', slug: 'Second story', script: 'Second script\n'.repeat(20), duration: 30, format: 'OVO' },
        { id: 'float', slug: 'Floated story', script: 'Skip me', is_floated: true },
        { id: 'below', slug: 'Below line', script: 'Skip me too' },
      ];
      const order = ['a1', 'seg', 'a2', 'float', 'marker-line', 'below'];
      window.mock = { rows, order, channels: [], holds: {}, releases: {}, reads: [], signedIn: options.signedIn !== false };
      if (options.badPrefs) localStorage.setItem('moiradesk_prompt_prefs', JSON.stringify({ speed: 'broken', fontScale: -20, mirrorY: 'yes' }));
      if (options.local) localStorage.setItem('moiradesk_local_room_bulletin-local', JSON.stringify({ meta: { order }, storiesMap: Object.fromEntries(rows.map(r => [r.id, { ...r, isFloated: !!r.is_floated }])) }));
      const read = async (table, id) => {
        mock.reads.push({ table, id });
        const result = table === 'bulletins' ? { data: { order_ids: id === 'room-a' ? order : ['b1'] } }
          : { data: id === 'room-a' ? rows : [{ id: 'b1', slug: 'Other newsroom', script: 'Other script' }] };
        if (mock.holds[id]) await new Promise(resolve => { (mock.releases[id] ||= []).push(resolve); });
        return result;
      };
      window.createClientMock = () => ({
        auth: {
          getSession: async () => ({ data: { session: mock.signedIn ? { user: { id: 'student' } } : null } }),
          onAuthStateChange: fn => { mock.authEvent = fn; },
        },
        rpc: async name => { if (name !== 'my_newsrooms') throw Error('Unexpected RPC ' + name); return { data: [{ newsroom_id: 'room-a', newsroom_name: 'Newsroom A' }, { newsroom_id: 'room-b', newsroom_name: 'Newsroom B' }] }; },
        from: table => ({ select: () => ({ eq: (_, id) => ({ maybeSingle: () => read(table, id), then: (resolve, reject) => read(table, id).then(resolve, reject) }) }) }),
        channel: () => { const ch = { callbacks: [], on(_, filter, fn) { this.callbacks.push({ table: filter.table, fn }); return this; }, subscribe() { return this; } }; mock.channels.push(ch); return ch; },
        removeChannel: ch => { ch.removed = true; },
      });
    }, options);
    const html = source.replace(/import \{ createClient \} from "[^"]+";/, 'const createClient = window.createClientMock;')
      .replace('boot().catch', 'window.testPrompt = { state, prefs, openRoom, incoming, jumpTo, setPlaying, act, parseTag, scriptHtml, anchorPoint, render };\nboot().catch');
    await page.route('**/*', route => route.request().url().startsWith('http://localhost:4174/')
      ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto(`http://localhost:4174/prompt.html?room=${options.local ? 'bulletin-local' : 'room-a'}`);
    return page;
  }
  try {
    const page = await open();
    await page.locator('[data-story="a1"]').waitFor();
    assert.deepEqual(await page.locator('[data-story]').evaluateAll(els => els.map(e => e.dataset.story)), ['a1', 'a2']);
    assert.equal(await page.locator('.segment').textContent(), 'Weather');
    assert.equal(await page.locator('.script strong').first().textContent(), 'world');
    assert.ok((await page.locator('.pill.clip').textContent()).includes('0:12'));
    assert.ok((await page.locator('.pill.clip .lw').textContent()).includes('Thank you'));
    assert.equal(await page.locator('.script script').count(), 0);
    assert.equal((await page.locator('.script').first().textContent()).includes('Job title'), false);

    // Scrolling defers edits until pause; lock heartbeats do not redraw text.
    await page.locator('[data-act="play"]').click();
    await page.waitForFunction(() => document.querySelector('#stage').scrollTop > 80);
    const node = await page.locator('[data-story="a1"]').elementHandle();
    await page.evaluate(() => mock.channels.at(-1).callbacks.find(c => c.table === 'stories').fn({ eventType: 'UPDATE', new: { ...mock.rows[0], locked_at: 999 } }));
    assert.equal(await node.evaluate(el => el.isConnected), true);
    await page.evaluate(() => mock.channels.at(-1).callbacks.find(c => c.table === 'stories').fn({ eventType: 'UPDATE', new: { ...mock.rows[0], script: mock.rows[0].script.replace('Hello', 'Updated') } }));
    assert.ok((await page.locator('.script').first().textContent()).startsWith('Hello'));
    assert.equal(await page.locator('#updated').isVisible(), true);
    await page.evaluate(() => testPrompt.setPlaying(false));
    assert.ok((await page.locator('.script').first().textContent()).startsWith('Updated'));

    // Mirroring keeps the script visible and navigation in logical story order.
    await page.evaluate(() => { testPrompt.act('mirror-y'); testPrompt.jumpTo('a2', false); });
    const before = await page.evaluate(() => ({ scroll: document.querySelector('#stage').scrollTop, current: testPrompt.state.currentId, top: document.querySelector('[data-story="a2"]').getBoundingClientRect().bottom }));
    assert.equal(before.current, 'a2');
    assert.ok(Math.abs(before.top - 900 * .64 - 4) < 8, 'flipped heading stays at the mirrored reading line');
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => testPrompt.state.currentId), 'a2');
    await page.evaluate(() => testPrompt.act('mirror-x'));
    assert.ok(Math.abs(await page.locator('#stage').evaluate(el => el.scrollTop) - before.scroll) < 2);
    await page.evaluate(() => { testPrompt.act('mirror-y'); testPrompt.act('mirror-x'); testPrompt.jumpTo('a1', false); });
    await page.locator('[data-act="fullscreen"]').click();
    await page.waitForFunction(() => !!document.fullscreenElement);
    assert.equal(await page.evaluate(() => !!document.fullscreenElement), true);
    await page.screenshot({ path: '/private/tmp/moira-prompter.png' });
    await page.evaluate(() => document.exitFullscreen());

    // Switching rooms out of order cannot replace the latest room's content.
    await page.evaluate(() => { mock.holds['room-a'] = true; testPrompt.openRoom('room-a'); });
    await page.waitForFunction(() => mock.releases['room-a']?.length === 2);
    await page.evaluate(() => testPrompt.openRoom('room-b'));
    await page.locator('[data-story="b1"]').waitFor();
    await page.evaluate(() => mock.releases['room-a'].splice(0).forEach(resolve => resolve()));
    await page.waitForTimeout(50);
    assert.equal(await page.locator('[data-story="a1"]').count(), 0);
    assert.equal(await page.evaluate(() => testPrompt.state.roomId), 'room-b');

    // Sign-out clears content and cancels outstanding loads and old live events.
    await page.evaluate(() => { testPrompt.openRoom('room-a'); });
    await page.waitForFunction(() => mock.releases['room-a']?.length === 2);
    await page.evaluate(() => { mock.authEvent('SIGNED_OUT', null); mock.releases['room-a'].splice(0).forEach(resolve => resolve()); mock.channels[0].callbacks[0].fn({ eventType: 'UPDATE', new: mock.rows[0] }); });
    await page.getByRole('heading', { name: 'Open your newsroom first' }).waitFor();
    assert.equal(await page.locator('[data-story]').count(), 0);
    assert.deepEqual(await page.evaluate(() => Object.keys(testPrompt.state.stories)), []);
    assert.equal(await page.evaluate(() => mock.channels.every(c => c.removed)), true);

    const local = await open({ local: true, badPrefs: true });
    await local.locator('[data-story="a1"]').waitFor();
    assert.equal(await local.evaluate(() => testPrompt.prefs.speed), 40);
    assert.equal(await local.evaluate(() => testPrompt.prefs.fontScale), .4);
    assert.equal(await local.evaluate(() => testPrompt.prefs.mirrorY), false);
    await local.setViewportSize({ width: 390, height: 844 });
    assert.equal(await local.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await local.evaluate(() => dispatchEvent(new StorageEvent('storage', { key: 'moiradesk_local_room_bulletin-local', newValue: null })));
    await local.getByRole('heading', { name: 'Open your newsroom first' }).waitFor();
    const signedOut = await open({ signedIn: false });
    await signedOut.getByRole('heading', { name: 'Open your newsroom first' }).waitFor();
    assert.equal(await signedOut.evaluate(() => mock.reads.length), 0);
    assert.deepEqual(errors, []);
    console.log('PASS: script cues/escaping, rundown filtering, scroll/pause, deferred updates, lock heartbeat filtering, both mirrors, story navigation, fullscreen, stale room loads, sign-out, local storage and mobile layout');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
