// Tutor newsroom page and EP wall redesign. External Playwright only; all
// Supabase calls are mocked and network access is blocked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.MOIRA_PLAYWRIGHT_MODULE || 'playwright');
const html = fs.readFileSync(path.join(__dirname, '..', 'tutor.html'), 'utf8').replace(/<script\b[^>]*\bsrc="[^"]*"[^>]*>\s*<\/script>/g, '');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.clock.install();
    await page.addInitScript(() => {
      let listener;
      const names = ['Foxtrot', 'Alpha', 'Delta', 'Charlie', 'Echo', 'Bravo <b>'];
      const id = (n) => `room-${n.split(' ')[0].toLowerCase()}`;
      const story = (sid, duration, completed, extra = {}) => ({ id: sid, slug: sid.toUpperCase(), format: 'PKG', duration, completed, is_floated: false, type: null, script: `Script ${sid}`, ...extra });
      const snap = (n) => ({ id: id(n), name: n, producer_name: n === 'Echo' ? null : `${n} producer`,
        pitches: n === 'Alpha' ? [
          { id: 'p1', slug: 'Bins', angle: 'Collections cut', status: 'picked', story_id: 's1', pitched_by: 'Sam', ep_note: null },
          { id: 'p2', slug: 'Parking', angle: 'New fines', status: 'pitched', pitched_by: 'Ali', ep_note: 'Check the figures' },
          { id: 'p3', slug: 'Fete', angle: '', status: 'spiked', spike_reason: 'Too soft', pitched_by: 'Jo', ep_note: null },
          { id: 'p4', slug: 'Bus lane', angle: '', status: 'pitched', pitched_by: 'Kim', ep_note: null },
        ] : [{ id: `x-${id(n)}`, slug: `${n} story`, angle: '', status: 'pitched', pitched_by: 'Someone', ep_note: null }],
        // Alpha: segment 60 + s1 30 + s3 20 = 1:50; s2 floated; s4 below the line.
        stories: n === 'Alpha' ? [{ id: 'seg', slug: 'Headlines', type: 'segment', duration: 60 }, story('s1', 30, 'checked-ok'),
          story('s2', 45, null, { is_floated: true }), story('s3', 20, 'checked-needs-work'), story('s4', 100, 'checked-ok')] : [],
        order: n === 'Alpha' ? ['seg', 's1', 's2', 's3', 'marker-line', 's4'] : [],
        feedback: n === 'Alpha' ? [{ id: 'f1', story_id: null, body: 'Good' }, { id: 'f2', story_id: 's1', body: 'Tighter' }] : [] });
      const snaps = names.map(snap);
      window.mock = { calls: [], snaps, reverse: false, hold: null, pending: [],
        signOut: () => listener?.('SIGNED_OUT', null) };
      const session = { user: { id: 'staff', email: 'staff@example.test' } };
      window.supabase = { createClient: () => ({
        auth: {
          getSession: async () => ({ data: { session: mock.signedOut ? null : session }, error: null }),
          onAuthStateChange: (fn) => { listener = fn; return { data: { subscription: { unsubscribe() {} } } }; },
          signOut: async () => { mock.signedOut = true; listener?.('SIGNED_OUT', null); return { error: null }; },
        },
        rpc: async (name, args) => {
          mock.calls.push({ name, args });
          if (mock.hold === name) return new Promise((resolve) => mock.pending.push(resolve));
          if (name === 'is_admin') return { data: false };
          if (name === 'is_tutor') return { data: true };
          if (name === 'tutor_newsrooms') return { data: names.map((n) => ({ newsroom_id: id(n), name: n, members: 5, pitches: 1, picked: 0, stories: 0,
            producer_name: n === 'Echo' ? null : `${n} producer`, tutor_code_available: n !== 'Delta' })) };
          if (name === 'tutor_conference') {
            const out = mock.snaps.filter((s) => args.p_newsroom_ids.includes(s.id)).map((s) => structuredClone(s));
            return { data: mock.reverse ? out.reverse() : out };
          }
          if (name === 'tutor_set_pitch_note') return { data: null };
          throw new Error(`Unexpected RPC: ${name}`);
        },
      }) };
    });
    await page.route('**/*', (route) => route.request().url() === 'http://moira.test/tutor.html'
      ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://moira.test/tutor.html');
    const calls = (name) => page.evaluate((n) => mock.calls.filter((c) => c.name === n).length, name);
    const text = (sel) => page.locator(sel).first().innerText();

    // ── Cards, summary and live status ──
    await page.locator('.room-card').first().waitFor();
    assert.deepEqual(await page.locator('.room-card .name').allInnerTexts(), ['Alpha', 'Bravo <b>', 'Charlie', 'Delta', 'Echo', 'Foxtrot'], 'A–Z, escaped');
    assert.equal(await page.locator('.room-card b').count(), 0);
    assert.equal(await text('#summary'), '6 newsrooms · 30 students · 5 of 6 have a producer');
    assert.match(await text('#live-status'), /^Live · updated \d\d:\d\d$/);
    const alpha = page.locator('.room-card').first();
    const alphaText = (await alpha.textContent()).replace(/\s+/g, ' ');
    for (const t of ['5 members', 'Alpha producer', '4 pitched · 1 picked · 1 spiked · 2 undecided', '3 stories · 1:50 running time', '1 OK', '1 needs work', '0 to check', '1 not checked', '2 comments'])
      assert.ok(alphaText.includes(t), `Alpha card shows ${t}`);
    assert.ok((await page.locator('.room-card').nth(1).innerText()).includes('Nothing picked yet'));
    assert.ok((await page.locator('.room-card').nth(4).innerText()).includes('No producer yet'));
    assert.equal(await page.getByRole('button', { name: 'Join code: Delta' }).count(), 0, 'no join code button without a tutor code');
    assert.equal(await page.getByRole('button', { name: 'Join code: Alpha' }).count(), 1);
    await page.getByText('Tick newsrooms to open the EP wall').waitFor();
    console.log('PASS: cards sorted and escaped, summary, live status, conference, running time, checks and feedback');

    // ── Search keeps focus through a background poll ──
    const search = page.getByLabel('Find a newsroom');
    await search.click();
    await page.keyboard.type('ha');
    await page.keyboard.press('ArrowLeft');
    await search.evaluate((el) => { el.dataset.same = '1'; });
    assert.equal(await text('.filter-note'), 'Showing 2 of 6 newsrooms matching ‘ha’');
    assert.deepEqual(await page.locator('.room-card .name').allInnerTexts(), ['Alpha', 'Charlie']);
    const before = await calls('tutor_newsrooms');
    await page.clock.runFor(30000);
    await page.waitForFunction((n) => mock.calls.filter((c) => c.name === 'tutor_newsrooms').length > n, before);
    await page.waitForFunction(() => mock.calls.at(-1).name === 'tutor_conference');
    await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));
    assert.deepEqual(await search.evaluate((el) => [el.dataset.same, el === document.activeElement, el.value, el.selectionStart]), ['1', true, 'ha', 1]);
    console.log('PASS: search filters without RPC and keeps focus and cursor through a poll');

    // ── Select all, selection bar, ticks hidden by search ──
    const selAll = page.locator('#sel-all-btn');
    assert.equal(await selAll.innerText(), 'Select 2 shown');
    await selAll.click();
    assert.equal(await selAll.innerText(), 'Deselect shown');
    assert.equal(await text('.selbar strong'), '2 newsrooms');
    assert.equal(await text('.selbar .names'), 'Alpha, Charlie');
    assert.equal(await page.locator('.room-card.ticked').count(), 2);
    await search.fill('zzz');
    await page.getByText('No newsroom matches ‘zzz’.', { exact: true }).waitFor();
    assert.equal(await text('.selbar strong'), '2 newsrooms', 'hidden ticks still count');
    await search.fill('');
    assert.equal(await selAll.innerText(), 'Select all');
    await page.locator('.room-card .name', { hasText: 'Bravo' }).click();
    assert.equal(await page.getByRole('checkbox', { name: 'Select Bravo <b>' }).isChecked(), true, 'clicking the heading row ticks');
    assert.equal(await text('.selbar strong'), '3 newsrooms');
    await selAll.click();
    assert.equal(await selAll.innerText(), 'Clear selection');
    await selAll.click();
    assert.equal(await page.locator('.room-card.ticked').count(), 0);
    await page.locator('.selbar').getByRole('button', { name: 'Select all' }).click();
    assert.equal(await text('.selbar strong'), '6 newsrooms');
    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    await page.getByText('Tick newsrooms to open the EP wall').waitFor();
    console.log('PASS: Select all / Clear / Select n shown, selection bar count and names, ticks survive filtering');

    // ── Report dialog from a card and from the bar ──
    await page.getByRole('button', { name: 'Report: Alpha' }).click();
    assert.equal(await page.locator('#dlg li').count(), 1);
    await page.getByRole('checkbox', { name: 'Include scripts' }).check();
    await page.getByRole('button', { name: 'Generate', exact: true }).click();
    await page.getByText('Report ready', { exact: true }).waitFor();
    let last = await page.evaluate(() => mock.calls.filter((c) => c.name === 'tutor_conference').at(-1).args);
    assert.deepEqual(last, { p_newsroom_ids: ['room-alpha'], p_scripts: true });
    const report = await page.evaluate(async () => (await fetch(lastReport.url)).text());
    assert.ok(report.includes('TRT 1:50') && report.includes('Script s1'), 'report TRT matches the card');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Select Alpha' }).check();
    await page.getByRole('checkbox', { name: 'Select Charlie' }).check();
    await page.getByRole('button', { name: 'Report…' }).click();
    assert.deepEqual(await page.locator('#dlg li').allInnerTexts(), ['Alpha', 'Charlie']);
    await page.getByRole('checkbox', { name: 'Include scripts' }).uncheck();
    await page.getByRole('button', { name: 'Generate', exact: true }).click();
    await page.getByText('Report ready', { exact: true }).waitFor();
    last = await page.evaluate(() => mock.calls.filter((c) => c.name === 'tutor_conference').at(-1).args);
    assert.deepEqual(last, { p_newsroom_ids: ['room-alpha', 'room-charlie'], p_scripts: false });
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    console.log('PASS: report dialog covers one newsroom from a card and the ticked newsrooms from the bar, with or without scripts');

    // ── Review TRT matches ──
    await page.getByRole('button', { name: 'Review & feedback: Alpha' }).click();
    await page.locator('.review').getByText('Overall feedback', { exact: true }).waitFor();
    assert.match(await text('.review-page > p'), /TRT 1:50/);
    await page.keyboard.press('Escape');
    await page.locator('.review').waitFor({ state: 'detached' });

    // ── List view, remembered in the tab ──
    await page.getByRole('button', { name: 'List', exact: true }).click();
    assert.equal(await page.locator('.rl-row:not(.head)').count(), 6);
    assert.equal(await page.locator('.rl-row.ticked').count(), 2);
    assert.ok((await page.locator('.rl-row:not(.head)').first().innerText()).includes('1 of 4 picked'));
    await page.locator('.list-key').waitFor();
    const mids = await page.locator('.rl-row:not(.head)').first().locator('.chk i').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return r.top + r.height / 2; }));
    assert.ok(Math.max(...mids) - Math.min(...mids) < 1, `check markers line up: ${mids}`);
    await page.locator('.room-list-wrap').screenshot({ path: '/private/tmp/moira-tutor-desk-list.png' });
    await page.reload();
    await page.locator('.rl-row').first().waitFor();
    assert.equal(await page.getByRole('button', { name: 'List', exact: true }).getAttribute('aria-pressed'), 'true');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'page does not scroll sideways');
    assert.equal(await page.locator('.room-list-wrap').evaluate((el) => el.scrollWidth > el.clientWidth), true, 'list scrolls inside its box');
    await page.getByRole('button', { name: 'Cards', exact: true }).click();
    assert.equal(await page.locator('.room-grid').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length), 1);
    await page.getByRole('checkbox', { name: 'Select Alpha' }).check();
    assert.ok((await page.locator('.selbar-in').evaluate((el) => el.scrollHeight)) > 50, 'selection bar wraps');
    await page.screenshot({ path: '/private/tmp/moira-tutor-desk-mobile.png' });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: '/private/tmp/moira-tutor-desk-cards.png' });
    console.log('PASS: list view with labelled columns, remembered on reload, phone layout');

    // ── EP wall ──
    for (const n of ['Bravo <b>', 'Charlie']) await page.getByRole('checkbox', { name: `Select ${n}` }).check();
    await page.getByRole('button', { name: 'Open EP wall' }).click();
    await page.locator('.wall-col').first().waitFor();
    assert.equal(await page.locator('.wall-col').count(), 3);
    assert.equal(await page.locator('.wall-pitch.new').count(), 0, 'nothing is new when the wall opens');
    const col = page.locator('.wall-col').first();
    assert.equal(await col.locator('.meta').innerText(), 'Producer: Alpha producer · 2 undecided · 1 picked');
    assert.deepEqual(await col.locator('.wall-sub').allInnerTexts(), ['UNDECIDED · 2', 'PICKED · 1']);
    assert.equal(await col.locator('.wall-pitch.picked .wall-tag.picked').innerText(), 'PICKED');
    assert.equal(await page.getByRole('button', { name: 'Note', exact: true }).count(), 0);
    await col.getByRole('button', { name: '▸ 1 spiked' }).click();
    assert.equal(await col.locator('.spiked-list li').innerText(), 'FETE · Too soft');
    await page.clock.runFor(3000);
    assert.equal(await col.locator('.spiked-list li').count(), 1, 'spiked stays open through a poll');
    assert.equal(await page.locator('.wall-pitch .note').count(), 1);
    await page.getByRole('button', { name: 'Hide notes' }).click();
    assert.equal(await page.locator('.wall-pitch .note').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Notes hidden' }).getAttribute('aria-pressed'), 'true');
    await page.clock.runFor(3000);
    assert.equal(await page.locator('.wall-pitch .note').count(), 0);
    await page.getByRole('button', { name: 'Notes hidden' }).click();
    assert.equal(await page.locator('.wall-pitch .note').count(), 1);
    const noScroll = () => page.locator('.wall-cols').evaluate((el) => el.scrollWidth <= el.clientWidth);
    const width = () => col.evaluate((el) => el.getBoundingClientRect().width);
    const narrow = await width();
    assert.equal(await noScroll(), true);
    for (let i = 0; i < 6; i++) await page.getByRole('button', { name: 'A+' }).click();
    assert.ok(await width() > narrow, 'A+ gives wider columns');
    assert.equal(await noScroll(), true, 'no horizontal scroll at A+');
    await page.screenshot({ path: '/private/tmp/moira-tutor-wall-zoomed.png' });
    for (let i = 0; i < 6; i++) await page.getByRole('button', { name: 'A−' }).click();
    console.log('PASS: wall columns, undecided/picked headings, PICKED label, spiked toggle, hide notes, A+ wraps without sideways scroll');

    // NEW for about 30 seconds
    await page.evaluate(() => mock.snaps.find((s) => s.id === 'room-bravo').pitches.push({ id: 'p-new', slug: 'Flood', angle: '', status: 'pitched', pitched_by: 'Ned', ep_note: null }));
    await page.clock.runFor(3000);
    await page.locator('.wall-pitch.new', { hasText: 'Flood' }).waitFor();
    assert.equal(await page.locator('.wall-pitch.new .wall-tag.new').innerText(), 'NEW');
    await page.screenshot({ path: '/private/tmp/moira-tutor-wall.png' });
    await page.clock.runFor(31000);
    await page.locator('.wall-pitch.new').waitFor({ state: 'detached' });
    console.log('PASS: a new pitch shows NEW, then expires');

    // Focus view
    await page.locator('.col-head', { hasText: 'Bravo' }).click();
    assert.equal(await text('.focus-title h2'), 'Bravo <b>');
    assert.match(await text('.focus-title .meta'), /2 of 3$/);
    await page.keyboard.press('ArrowRight');
    assert.equal(await text('.focus-title h2'), 'Charlie');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await text('.focus-title h2'), 'Alpha');
    assert.equal(await text('.focus-spiked'), 'Spiked · 1: FETE · Too soft');
    await page.getByRole('button', { name: '← Charlie' }).click();
    assert.equal(await text('.focus-title h2'), 'Charlie');
    await page.getByRole('button', { name: 'Alpha →' }).click();
    await page.evaluate(() => { mock.reverse = true; });
    await page.clock.runFor(3000);
    await page.waitForFunction(() => mock.calls.at(-1).name === 'tutor_conference');
    await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));
    assert.equal(await text('.focus-title h2'), 'Alpha', 'focus survives a reordered poll');
    assert.match(await text('.focus-title .meta'), /1 of 3$/);
    await page.screenshot({ path: '/private/tmp/moira-tutor-wall-focus.png' });
    await page.keyboard.press('Escape');
    await page.locator('.wall-cols').waitFor();
    assert.equal(await page.locator('.wall').count(), 1);
    await page.locator('.col-head', { hasText: 'Charlie' }).click();
    await page.evaluate(() => { mock.snaps = mock.snaps.filter((s) => s.id !== 'room-charlie'); });
    await page.clock.runFor(3000);
    await page.locator('.wall-cols').waitFor();
    assert.equal(await page.locator('.wall-col').count(), 2, 'a vanished focused newsroom returns to all');
    console.log('PASS: focus view, ← / → and buttons, survives reordering, Esc back to all');

    // Present mode
    await page.locator('.wall-pitch', { hasText: 'Parking' }).click();
    await page.getByLabel('Your note to the newsroom').fill('');
    await page.keyboard.type('pp');
    assert.equal(await page.getByLabel('Your note to the newsroom').inputValue(), 'pp');
    assert.equal(await page.evaluate(() => wall.present), false, 'typing p in a note does not toggle Present');
    await page.evaluate(() => setPresent(true));
    assert.equal(await page.locator('.wall-note-dialog').count(), 0, 'Present closes the note dialog');
    assert.equal(await page.locator('.wall-bar').count(), 0);
    assert.match(await text('.wall-strip'), /^Conference · Live · \d\d:\d\d/);
    assert.equal(await page.locator('.wall-pitch:not([disabled])').count(), 0);
    await page.locator('.wall-pitch').first().click({ force: true });
    assert.equal(await page.locator('.wall-note-dialog').count(), 0, 'no note opens in Present mode');
    await page.screenshot({ path: '/private/tmp/moira-tutor-wall-present.png' });
    await page.getByRole('button', { name: 'Show controls' }).click();
    await page.locator('.wall-bar').waitFor();
    await page.keyboard.press('p');
    await page.locator('.wall-strip').waitFor();
    await page.keyboard.press('P');
    await page.locator('.wall-bar').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.wall').waitFor({ state: 'detached' });
    console.log('PASS: Present mode hides controls, blocks notes, Show controls and P bring them back, Esc closes');

    // ── Sign-out with a poll in flight leaves no timers or data ──
    await page.getByRole('button', { name: 'Open EP wall' }).click();
    await page.locator('.wall-col').first().waitFor();
    await page.evaluate(() => { mock.hold = 'tutor_conference'; });
    await page.clock.runFor(3000);
    await page.evaluate(() => mock.signOut());
    await page.locator('#email').waitFor();
    assert.equal(await page.locator('.wall, .review, .selbar').count(), 0);
    const n = await page.evaluate(() => mock.calls.length);
    await page.evaluate(() => { mock.pending.forEach((r) => r({ data: mock.snaps })); mock.hold = null; });
    await page.clock.runFor(120000);
    assert.equal(await page.evaluate(() => mock.calls.length), n, 'no timers left running');
    assert.equal(await page.evaluate(() => state.rooms.length + state.selected.size + (state.pollTimer ? 1 : 0)), 0);
    assert.equal(await page.locator('.room-card, .wall').count(), 0);
    console.log('PASS: signing out with the wall open and a poll in flight stops timers and clears the screen');

    assert.deepEqual(errors, [], 'No browser JavaScript errors');
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
