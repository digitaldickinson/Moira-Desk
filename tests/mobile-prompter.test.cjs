// Browser QA with mocked Supabase and wake locks; no live accounts or writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require(process.env.MOIRA_PLAYWRIGHT_MODULE || 'playwright');
const source = fs.readFileSync(path.join(__dirname, '..', 'prompt_mob.html'), 'utf8');

(async () => {
  const browser = await playwright[process.env.MOIRA_BROWSER || 'chromium'].launch({ headless: true });
  const errors = [];
  async function open(options = {}) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(options => {
      const script = 'Hello *world*.\n[STRAP: Person | Job]\n[CLIP:0:12 Interview | SOT | LW: Thank you]\n[CAM 2]\n<script>bad()</script>\n' + 'More script for the presenter.\n'.repeat(35);
      window.mock = {
        rows: [{ id: 'a1', slug: 'First story', script, format: 'PKG' }, { id: 'seg', slug: 'Weather', type: 'segment' },
          { id: 'a2', slug: 'Second story', script: 'Second script\n'.repeat(20) }, { id: 'float', slug: 'Floated', script: 'Skip me', is_floated: true }, { id: 'below', slug: 'Below line', script: 'Skip me too' }],
        order: ['a1', 'seg', 'a2', 'float', 'marker-line', 'below'],
        rooms: options.returning ? [{ newsroom_id: 'room-a', newsroom_name: 'Newsroom A' }] : [],
        signedIn: !!options.returning, signins: 0, channels: [], reads: [], rpcCalls: [], locks: [], wakeCalls: 0,
        holdWake: !!options.holdWake, denyWake: !!options.denyWake, visibility: 'visible',
      };
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => mock.visibility });
      if (options.fullscreen === 'unsupported') Object.defineProperty(Element.prototype, 'requestFullscreen', { configurable: true, value: undefined });
      if (options.fullscreen === 'denied') Object.defineProperty(Element.prototype, 'requestFullscreen', { configurable: true, value: async () => { throw Error('Not allowed'); } });
      if (options.standalone) Object.defineProperty(navigator, 'standalone', { value: true });
      Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: options.unsupported ? undefined : {
        request: async () => {
          mock.wakeCalls++;
          if (mock.denyWake) throw Error('Not allowed');
          if (mock.holdWake) await new Promise(resolve => { mock.resolveWake = resolve; });
          const lock = new EventTarget(); lock.released = false;
          lock.release = async () => { lock.released = true; lock.dispatchEvent(new Event('release')); };
          mock.locks.push(lock); return lock;
        },
      } });
      if (options.prefs) localStorage.setItem('moiradesk_mobile_prompt_prefs', JSON.stringify(options.prefs));
      const read = async (table, id) => {
        mock.reads.push({ table, id });
        const result = table === 'bulletins' ? { data: mock.revoked ? null : { order_ids: [...mock.order] } } : { data: structuredClone(mock.rows) };
        if (mock.holdReads) await new Promise(resolve => { (mock.resolveReads ||= []).push(resolve); });
        if (mock.offline) throw Error('Offline');
        return result;
      };
      window.createClientMock = () => ({
        auth: {
          getSession: async () => ({ data: { session: mock.signedIn ? { user: { id: 'student' } } : null } }),
          signInAnonymously: async () => { mock.signins++; mock.signedIn = true; return { data: { user: { id: 'student' } } }; },
          onAuthStateChange: fn => { mock.authEvent = fn; },
        },
        rpc: async (name, args) => {
          mock.rpcCalls.push({ name, args });
          if (name === 'my_newsrooms') return { data: mock.rooms };
          if (name === 'join_newsroom') {
            if (args.p_code !== 'ABC123') return { data: [] };
            mock.rooms = [{ newsroom_id: 'room-a', newsroom_name: 'Newsroom A' }]; return { data: mock.rooms };
          }
          throw Error('Unexpected RPC ' + name);
        },
        from: table => ({ select: () => ({ eq: (_, id) => ({ maybeSingle: () => read(table, id), then: (resolve, reject) => read(table, id).then(resolve, reject) }) }) }),
        channel: () => { const ch = { callbacks: [], on(_, filter, fn) { this.callbacks.push({ table: filter.table, fn }); return this; }, subscribe(fn) { this.status = fn; return this; } }; mock.channels.push(ch); return ch; },
        removeChannel: ch => { ch.removed = true; },
      });
    }, options);
    const html = source.replace(/import \{ createClient \} from "[^"]+";/, 'const createClient = window.createClientMock;')
      .replace('boot().catch(e => showError(e.message ||', 'window.testMobile = { state, prefs, refresh, wake };\nboot().catch(e => showError(e.message ||');
    await page.route('**/*', route => route.request().url().startsWith('http://localhost:4174/') ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://localhost:4174/prompt_mob.html');
    return page;
  }
  async function ready(page) { await page.locator('[data-story="a1"]').waitFor(); }
  async function visibility(page, value) { await page.evaluate(value => { mock.visibility = value; document.dispatchEvent(new Event('visibilitychange')); }, value); }
  async function layout(page) {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal overflow');
    const rects = await page.evaluate(() => Object.fromEntries(['topbar', 'stage', 'controls', 'play'].map(id => { const r = document.getElementById(id).getBoundingClientRect(); return [id, { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height }]; })));
    assert.ok(rects.stage.top >= rects.topbar.bottom - 1 && rects.stage.bottom <= rects.controls.top + 1, 'script stays clear of controls');
    assert.ok(rects.stage.height > 80, 'usable script area');
    assert.ok(rects.play.height >= 44 && rects.play.right <= await page.evaluate(() => innerWidth), 'play button fits');
  }
  try {
    const page = await open();
    await page.getByLabel('Newsroom code').waitFor();
    assert.equal(await page.evaluate(() => mock.signins), 0, 'no anonymous identity until joining');
    assert.equal(await page.evaluate(() => mock.reads.length), 0);
    await page.screenshot({ path: '/private/tmp/moira-mobile-join.png' });
    await page.getByLabel('Newsroom code').fill('WRONG'); await page.getByRole('button', { name: 'Open prompter' }).click();
    await page.waitForFunction(() => document.getElementById('join-error').textContent.includes('isn’t recognised'));
    await page.getByLabel('Newsroom code').fill('ABC123'); await page.getByRole('button', { name: 'Open prompter' }).click();
    await ready(page);
    assert.equal(await page.evaluate(() => mock.signins), 1, 'wrong-code retry reuses identity');
    assert.deepEqual(await page.locator('[data-story]').evaluateAll(els => els.map(el => el.dataset.story)), ['a1', 'a2']);
    assert.equal(await page.locator('.segment').textContent(), 'Weather');
    assert.equal(await page.locator('.script strong').first().textContent(), 'world');
    assert.ok((await page.locator('.pill.clip').textContent()).includes('Thank you'));
    assert.equal(await page.locator('.script script').count(), 0);
    assert.equal((await page.locator('.script').first().textContent()).includes('Job'), false);
    assert.equal(await page.locator('.story-select').count(), 0);
    await page.waitForFunction(() => document.querySelector('[data-wake-status]').dataset.wakeState === 'active');
    await layout(page);
    await page.screenshot({ path: '/private/tmp/moira-mobile-reader.png' });

    // A real touch gesture pauses scrolling before the reader moves the text.
    await page.getByRole('button', { name: '▶ Start', exact: true }).click();
    await page.locator('.script').first().tap();
    assert.equal(await page.evaluate(() => testMobile.state.playing), false);

    await page.getByRole('button', { name: '▶ Start', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('stage').scrollTop > 25);
    await page.evaluate(async () => { mock.rows[0].script = mock.rows[0].script.replace('Hello', 'Updated'); await testMobile.refresh(); });
    assert.ok((await page.locator('.script').first().textContent()).startsWith('Hello'));
    assert.equal(await page.locator('#updated').isVisible(), true);
    await page.getByRole('button', { name: '❚❚ Pause', exact: true }).click();
    assert.ok((await page.locator('.script').first().textContent()).startsWith('Updated'));
    assert.equal(await page.evaluate(() => mock.locks.at(-1).released), false, 'manual reading keeps lock');
    const node = await page.locator('[data-story="a1"]').elementHandle();
    await page.evaluate(async () => { mock.rows[0].locked_at = 'heartbeat'; await testMobile.refresh(); });
    assert.equal(await node.evaluate(el => el.isConnected), true, 'heartbeat does not redraw');

    await page.locator('summary').click();
    await page.getByRole('button', { name: 'Larger text', exact: true }).click();
    assert.equal(await page.locator('.script').first().evaluate(el => getComputedStyle(el).fontSize), '34px');
    await page.getByLabel('Keep screen awake').uncheck();
    assert.equal(await page.evaluate(() => mock.locks.at(-1).released), true);
    await page.getByLabel('Keep screen awake').check();
    await page.waitForFunction(() => mock.locks.length === 2);
    await page.evaluate(() => mock.locks.at(-1).release());
    await page.getByRole('button', { name: 'Try keeping screen awake again' }).waitFor();
    await page.getByRole('button', { name: 'Try keeping screen awake again' }).click();
    await page.waitForFunction(() => mock.locks.length === 3);
    await page.screenshot({ path: '/private/tmp/moira-mobile-settings.png' });
    await page.locator('summary').click();
    await page.getByRole('button', { name: '▶ Start', exact: true }).click();
    await visibility(page, 'hidden');
    assert.equal(await page.evaluate(() => testMobile.state.playing), false);
    assert.equal(await page.evaluate(() => mock.locks.at(-1).released), true);
    await page.evaluate(() => { mock.rows[0].script = 'After returning\n'.repeat(50); });
    await visibility(page, 'visible');
    await page.waitForFunction(() => mock.locks.length === 4 && document.querySelector('.script').textContent.startsWith('After returning'));
    assert.equal(await page.evaluate(() => testMobile.state.playing), false, 'resume is explicit');

    await page.evaluate(async () => { mock.offline = true; await testMobile.refresh(); });
    assert.ok((await page.locator('#connection').textContent()).includes('interrupted'));
    assert.equal(await page.locator('[data-story]').count(), 2, 'offline keeps loaded scripts');
    await page.evaluate(async () => { mock.offline = false; mock.rows[0].script = 'Reconnected'; await testMobile.refresh(); });
    assert.equal(await page.locator('.script').first().textContent(), 'Reconnected');
    for (const viewport of [{ width: 320, height: 568 }, { width: 844, height: 390 }, { width: 874, height: 274 }, { width: 667, height: 240 }]) {
      await page.setViewportSize(viewport); await page.waitForTimeout(100); await layout(page);
      if (viewport.width > viewport.height) {
        assert.ok(await page.locator('#stage').evaluate(el => el.clientHeight / innerHeight) > .65, 'landscape leaves most visible height for the bulletin');
        assert.ok(await page.locator('#topbar').evaluate(el => el.clientHeight) < 30, 'landscape header occupies one compact row');
        await page.locator('summary').click();
        const settings = await page.locator('.settings').boundingBox();
        assert.ok(settings.y >= 0, 'landscape settings stay inside visible viewport');
        await page.getByRole('button', { name: 'Change room', exact: true }).waitFor();
        await page.locator('summary').click();
      }
    }
    // Rotate back with settings open; everything returns to the portrait layout.
    await page.locator('summary').click();
    await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(100);
    await layout(page); await page.locator('summary').click();
    await page.setViewportSize({ width: 874, height: 274 }); await page.waitForTimeout(100);
    await page.screenshot({ path: '/private/tmp/moira-mobile-landscape.png' });
    await page.evaluate(async () => { mock.revoked = true; await testMobile.refresh(); });
    await page.getByLabel('Newsroom code').waitFor();
    assert.equal(await page.locator('[data-story]').count(), 0);
    assert.equal(await page.evaluate(() => mock.locks.at(-1).released), true);

    const denied = await open({ returning: true, denyWake: true }); await ready(denied);
    await denied.waitForFunction(() => document.querySelector('[data-wake-status]').dataset.wakeState === 'denied');
    assert.equal(await denied.evaluate(() => mock.signins), 0, 'returning session skips sign-in');
    await denied.locator('summary').click(); await denied.evaluate(() => { mock.denyWake = false; });
    await denied.getByRole('button', { name: 'Try keeping screen awake again' }).click();
    await denied.waitForFunction(() => mock.locks.length === 1);
    const unsupported = await open({ returning: true, unsupported: true }); await ready(unsupported);
    await unsupported.waitForFunction(() => document.querySelector('[data-wake-status]').dataset.wakeState === 'unsupported');
    await unsupported.getByRole('button', { name: '▶ Start', exact: true }).click();
    await unsupported.waitForFunction(() => document.getElementById('stage').scrollTop > 10);

    const pending = await open({ returning: true, holdWake: true }); await ready(pending);
    await pending.waitForFunction(() => !!mock.resolveWake);
    await pending.locator('summary').click(); await pending.getByLabel('Keep screen awake').uncheck();
    await pending.evaluate(() => { mock.holdWake = false; mock.resolveWake(); });
    await pending.waitForFunction(() => mock.locks[0]?.released);
    assert.equal(await pending.locator('[data-wake-status]').getAttribute('data-wake-state'), 'off');

    // Backgrounding during an unresolved lock must release the old result and
    // acquire a fresh lock after returning; it must never restart scrolling.
    const background = await open({ returning: true, holdWake: true }); await ready(background);
    await background.waitForFunction(() => !!mock.resolveWake);
    await visibility(background, 'hidden'); await visibility(background, 'visible');
    await background.evaluate(() => { mock.holdWake = false; mock.resolveWake(); });
    await background.waitForFunction(() => mock.locks.length === 2 && mock.locks[0].released && !mock.locks[1].released);
    assert.equal(await background.evaluate(() => testMobile.state.playing), false);

    // An empty bulletin cannot start scrolling; a changed running order is
    // filtered again on refresh, including the END OF PROGRAMME boundary.
    await background.evaluate(async () => { mock.order = ['marker-line', 'a1']; await testMobile.refresh(); });
    assert.equal(await background.locator('[data-story]').count(), 0);
    assert.equal(await background.locator('#play').isDisabled(), true);
    await background.evaluate(async () => { mock.order = ['a2', 'marker-line', 'a1']; await testMobile.refresh(); });
    assert.deepEqual(await background.locator('[data-story]').evaluateAll(els => els.map(el => el.dataset.story)), ['a2']);
    await background.getByRole('button', { name: '▶ Start', exact: true }).click();
    await background.evaluate(() => { const stage = document.getElementById('stage'); stage.scrollTop = stage.scrollHeight; });
    await background.waitForFunction(() => !testMobile.state.playing);

    // Outstanding reads and events cannot restore text after sign-out.
    await denied.evaluate(() => { mock.holdReads = true; void testMobile.refresh(); });
    await denied.waitForFunction(() => mock.resolveReads?.length === 2);
    await denied.evaluate(() => { mock.authEvent('SIGNED_OUT', null); mock.resolveReads.forEach(resolve => resolve()); mock.channels[0].callbacks[0].fn(); });
    await denied.getByLabel('Newsroom code').waitFor();
    assert.equal(await denied.locator('[data-story]').count(), 0);
    assert.equal(await denied.evaluate(() => mock.channels.every(ch => ch.removed)), true);
    assert.equal(await denied.evaluate(() => mock.locks.at(-1).released), true);

    // Native fullscreen, browser-driven exit, and controls remain operable.
    const fullscreen = await open({ returning: true }); await ready(fullscreen);
    await fullscreen.setViewportSize({ width: 874, height: 274 });
    const supportsFullscreen = await fullscreen.evaluate(() => !!document.documentElement.requestFullscreen && document.fullscreenEnabled !== false);
    if (supportsFullscreen) {
      await fullscreen.getByRole('button', { name: 'Full screen', exact: true }).click();
      await fullscreen.waitForFunction(() => !!document.fullscreenElement && document.getElementById('app').classList.contains('focus-mode'));
      assert.equal(await fullscreen.locator('#topbar').isVisible(), false);
      assert.ok(await fullscreen.locator('#stage').evaluate(el => el.clientHeight >= innerHeight - 1));
      await fullscreen.getByRole('button', { name: '▶ Start', exact: true }).click();
      await fullscreen.waitForFunction(() => testMobile.state.playing);
      await fullscreen.evaluate(() => document.exitFullscreen());
      await fullscreen.waitForFunction(() => !document.getElementById('app').classList.contains('focus-mode'));
      assert.equal(await fullscreen.evaluate(() => testMobile.state.playing), false);
      await fullscreen.getByRole('button', { name: 'Full screen', exact: true }).click();
      await fullscreen.getByRole('button', { name: 'Show controls', exact: true }).click();
      await fullscreen.waitForFunction(() => !document.fullscreenElement);
      await layout(fullscreen);
    }

    // iPhone-style unsupported API and rejected requests both offer a truthful
    // fallback. The Home Screen app can hide controls without showing the help.
    for (const mode of ['unsupported', 'denied', 'standalone']) {
      const fallback = await open({ returning: true, fullscreen: mode === 'standalone' ? 'unsupported' : mode, standalone: mode === 'standalone' }); await ready(fallback);
      await fallback.setViewportSize({ width: 874, height: 274 });
      await fallback.getByRole('button', { name: 'Full screen', exact: true }).click();
      if (mode !== 'standalone') {
        await fallback.getByRole('dialog').waitFor();
        assert.ok((await fallback.getByRole('dialog').textContent()).includes('Add to Home Screen'));
        await fallback.getByRole('button', { name: 'Hide prompter controls', exact: true }).click();
      }
      await fallback.getByRole('button', { name: 'Show controls', exact: true }).waitFor();
      assert.equal(await fallback.locator('#topbar').isVisible(), false);
      assert.ok(await fallback.locator('#stage').evaluate(el => el.clientHeight >= innerHeight - 1));
      await fallback.getByRole('button', { name: '▶ Start', exact: true }).click();
      await fallback.waitForFunction(() => document.getElementById('stage').scrollTop > 10);
      await fallback.getByRole('button', { name: '❚❚ Pause', exact: true }).click();
      if (mode === 'unsupported') await fallback.screenshot({ path: '/private/tmp/moira-mobile-reading-mode.png' });
      await fallback.getByRole('button', { name: 'Show controls', exact: true }).click();
      await layout(fallback);
      assert.equal(await fallback.locator('#topbar').isVisible(), true);
    }
    assert.deepEqual(errors, []);
    console.log('PASS: mobile join, bulletin/cues, updates, wake-lock lifecycle, reconnect, access removal, reduced landscape height, rotation, fullscreen and unsupported/denied/standalone reading modes');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
