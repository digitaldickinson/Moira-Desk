// Source mix on the EP wall and in the report (tutor desk): counts by how
// pitches were added, follow-up gate badges, the follow-up close-up, and the
// report's summary, follow-up detail and wire list. External Playwright only;
// Supabase calls are mocked and network access is blocked.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.MOIRA_PLAYWRIGHT_MODULE || 'playwright');
const { pageHtml } = require('./desk-page.cjs');
const html = pageHtml('tutor.html');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.clock.install();
    await page.addInitScript(() => {
      const BBC = 'https://www.bbc.co.uk/news/articles/c8752wyv155xo';
      const MEN = 'https://www.manchestereveningnews.co.uk/news/greater-manchester-news/m56-traffic-live-drivers-face-34922134';
      const PA = 'https://explore.pressassociation.com/create/events/x/latest/1';
      const alpha = { id: 'room-alpha', name: 'Alpha', producer_name: 'Pat', order: ['s1', 's4', 'marker-line'], feedback: [],
        stories: [{ id: 's1', slug: 'BINS', format: 'READ', duration: 20 }, { id: 's4', slug: 'M56', format: 'OOV', duration: 30 }],
        pitches: [
          { id: 'p1', slug: 'Bins', angle: 'Collections cut', status: 'picked', story_id: 's1', pitched_by: 'Sam', source: null, source_type: 'original' },
          { id: 'p2', slug: 'Brand', angle: 'Edited angle', status: 'pitched', pitched_by: 'Ali', source: 'pa', source_type: 'wire', source_url: PA,
            source_title: 'A woman who alleges she was raped by Russell Brand has said his message from jail was "really shocking".' },
          { id: 'p3', slug: 'Power cuts', angle: 'Hundreds hit by power cuts', status: 'pitched', pitched_by: 'Jo', source: 'bbc', source_type: 'follow', source_url: BBC,
            source_title: 'Hundreds of properties hit by power cuts after cable incident', source_published_at: '2026-11-17T08:46:54Z', source_modified_at: null,
            follow_when: 'Sunday night', follow_origin: 'ab', follow_angle: null },
          { id: 'p4', slug: 'M56', angle: 'Queues on the M56', status: 'picked', story_id: 's4', pitched_by: 'Kim', source: 'men', source_type: 'follow', source_url: MEN,
            source_title: 'M56 traffic LIVE as drivers face long queues', source_published_at: '2026-11-17T09:22:24Z', source_modified_at: '2026-11-17T10:00:00Z',
            follow_when: 'Monday rush hour', follow_origin: 'National Highways', follow_angle: 'Third crash at this junction this month' },
          { id: 'p5', slug: 'Fete', angle: '', status: 'spiked', spike_reason: 'Too soft', pitched_by: 'Jo', source: null, source_type: 'original' },
        ] };
      const bravo = { id: 'room-bravo', name: 'Bravo', producer_name: null, order: [], feedback: [], stories: [],
        pitches: [{ id: 'b1', slug: 'Parking', angle: 'New fines', status: 'pitched', pitched_by: 'Ned', source: null },
          { id: 'b2', slug: 'Levy', angle: 'Visitor levy', status: 'pitched', pitched_by: 'Mo', source: 'pa', source_url: PA }] };
      window.mock = { snaps: [alpha, bravo], calls: [] };
      const session = { user: { id: 'staff', email: 'staff@example.test' } };
      window.supabase = { createClient: () => ({
        auth: { getSession: async () => ({ data: { session }, error: null }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), signOut: async () => ({ error: null }) },
        rpc: async (name, args) => {
          mock.calls.push({ name, args });
          if (name === 'is_admin') return { data: false };
          if (name === 'is_tutor') return { data: true };
          if (name === 'tutor_newsrooms') return { data: mock.snaps.map((s) => ({ newsroom_id: s.id, name: s.name, members: 3, pitches: s.pitches.length, picked: 0, stories: 0, producer_name: s.producer_name, tutor_code_available: false })) };
          if (name === 'tutor_conference') return { data: mock.snaps.filter((s) => args.p_newsroom_ids.includes(s.id)).map((s) => structuredClone(s)) };
          if (name === 'tutor_set_pitch_note') return { data: null };
          throw new Error(`Unexpected RPC: ${name}`);
        },
      }) };
    });
    await page.route('**/*', (route) => route.request().url() === 'http://moira.test/tutor.html'
      ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://moira.test/tutor.html');
    await page.locator('.room-card').first().waitFor();
    for (const n of ['Alpha', 'Bravo']) await page.getByRole('checkbox', { name: `Select ${n}` }).check();

    // ── Wall: source-mix bar and per-newsroom mix, counts only ──
    await page.getByRole('button', { name: 'Open EP wall' }).click();
    await page.locator('.wall-col').first().waitFor();
    assert.equal(await page.getByTestId('wall-mix').innerText(), 'Original 3 · Wire 2 · Follow-up 2');
    assert.deepEqual(await page.locator('.col-head .mix').allInnerTexts(), ['Original 2 · Wire 1 · Follow-up 2', 'Original 1 · Wire 1 · Follow-up 0']);
    const card = (slug) => page.locator('.wall-pitch', { hasText: slug });
    assert.equal(await card('Power cuts').locator('.wall-tag.bbc').innerText(), 'FOLLOW-UP · BBC');
    assert.equal(await card('Power cuts').locator('.wall-gate').innerText(), 'Answers missing', '2 characters and a blank are not answers');
    assert.equal(await card('M56').locator('.wall-gate').innerText(), 'Ready');
    assert.equal(await card('Bins').locator('.wall-gate').count(), 0, 'only follow-ups have a gate badge');
    assert.equal(await card('Power cuts').getByText('Sunday night').count(), 0, 'answers are not on the card');
    console.log('PASS: wall shows the source mix (total and per newsroom), follow-up tags and gate badges');

    // ── Live: new pitches and completed answers show on the next poll ──
    await page.evaluate(() => {
      const [a, b] = mock.snaps;
      b.pitches.push({ id: 'b3', slug: 'Trams', angle: 'Delays', status: 'pitched', pitched_by: 'Ned', source: 'bbc', source_type: 'follow' });
      b.pitches.push({ id: 'b4', slug: 'Library', angle: 'Typed', status: 'pitched', pitched_by: 'Mo', source: null });
      Object.assign(a.pitches.find((p) => p.id === 'p3'), { follow_origin: 'Electricity North West', follow_angle: 'Second night without power' });
    });
    await page.clock.runFor(3000);
    await page.getByTestId('wall-mix').getByText('Original 4 · Wire 2 · Follow-up 3').waitFor();
    await card('Power cuts').locator('.wall-gate.ready').waitFor();
    assert.equal(await card('Trams').locator('.wall-gate').innerText(), 'Answers missing');
    console.log('PASS: the bar and gate badges update live with the wall\'s refresh');

    // ── Close-up: large, read-only, Esc or a click closes it ──
    await card('Power cuts').click();
    const closeup = page.getByTestId('wall-closeup');
    await closeup.waitFor();
    const text = await closeup.innerText();
    for (const t of ['POWER CUTS', 'BBC: “Hundreds of properties hit by power cuts after cable incident”', 'Page claims: published 17 Nov 2026',
      'Sunday night', 'Electricity North West', 'Second night without power', 'WHEN DID THIS ACTUALLY HAPPEN?']) assert.ok(text.includes(t), `close-up shows ${t}`);
    assert.equal(await closeup.locator('input, textarea, [contenteditable]').count(), 0, 'nothing to edit');
    const answerPx = await closeup.locator('dd').first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    assert.ok(answerPx >= 26, `answers readable across a room (${answerPx}px)`);
    await page.screenshot({ path: '/private/tmp/moira-wall-closeup.png' });
    await page.keyboard.press('Escape');
    await closeup.waitFor({ state: 'detached' });
    assert.equal(await page.locator('.wall').count(), 1, 'Esc closes the close-up, not the wall');
    await card('M56').click();
    await closeup.locator('h2').click();
    await closeup.waitFor({ state: 'detached' });
    // The EP note is one button away.
    await card('M56').click();
    await closeup.getByRole('button', { name: 'Add EP note' }).click();
    await page.locator('.wall-note-dialog').waitFor();
    assert.equal(await closeup.count(), 0, 'the close-up gives way to the note');
    await page.locator('.wall-note-dialog [data-note-cancel]').first().click();
    // Present mode: follow-ups still open their close-up, without the note button.
    await page.keyboard.press('p');
    await page.locator('.wall-strip').waitFor();
    assert.match(await page.locator('.wall-strip').innerText(), /Original 4 · Wire 2 · Follow-up 3/);
    await card('M56').click();
    await closeup.waitFor();
    assert.equal(await closeup.getByRole('button', { name: /EP note/ }).count(), 0);
    await page.keyboard.press('Escape');
    assert.equal(await card('Bins').isDisabled(), true, 'other cards still do nothing in Present mode');
    await page.keyboard.press('p');
    await page.keyboard.press('Escape');
    await page.locator('.wall').waitFor({ state: 'detached' });
    console.log('PASS: follow-up close-up is large and read-only, closes with Esc or a click, offers the EP note, works in Present mode');

    // ── Report: same counts as the wall, follow-ups in full, PA list ──
    await page.getByRole('button', { name: 'Report…' }).click();
    await page.getByRole('button', { name: 'Generate', exact: true }).click();
    await page.getByText('Report ready', { exact: true }).waitFor();
    const report = await page.evaluate(async () => (await fetch(lastReport.url)).text());
    const doc = await browser.newPage();
    await doc.setContent(report);
    const alpha = doc.locator('#nr-room-alpha'), bravo = doc.locator('#nr-room-bravo');
    const tidy = (t) => t.replace(/\n\s*\n/g, '\n').trim();
    const summary = tidy(await alpha.getByTestId('mix-summary').innerText());
    assert.equal(summary, ['Source mix: Original (declared) 2 · Wire 1 · Follow-up 2',
      'Counts are based on how pitches were added. Typed-in pitches count as original.',
      'Follow-ups: 2 · with all three answers: 2 · promoted: 1',
      'Pipeline: 5 pitched → 2 promoted → 2 in the running order'].join('\n'));
    assert.match(tidy(await bravo.getByTestId('mix-summary').innerText()), /^Source mix: Original \(declared\) 2 · Wire 1 · Follow-up 1\n/, 'matches the wall column after the live update');
    for (const s of ['Sunday night', 'Electricity North West', 'Third crash', 'raped']) assert.ok(!summary.includes(s), 'the summary has counts only');
    const details = alpha.locator('.pitch-detail');
    assert.equal(await details.count(), 2);
    const m56 = tidy(await details.filter({ hasText: 'M56' }).innerText());
    for (const t of ['MEN: “M56 traffic LIVE as drivers face long queues”', 'Page claims: published 17 Nov 2026', 'Pitched by Kim',
      'When did this actually happen?\nMonday rush hour', 'Who is the original source?\nNational Highways',
      "What's new, or what's our angle?\nThird crash at this junction this month", 'Status: Promoted · in the running order'])
      assert.ok(m56.includes(t), `follow-up detail shows ${t}`);
    assert.equal(await details.filter({ hasText: 'M56' }).locator('a').getAttribute('href'), 'https://www.manchestereveningnews.co.uk/news/greater-manchester-news/m56-traffic-live-drivers-face-34922134');
    const trams = await bravo.locator('.pitch-detail', { hasText: 'Trams' }).innerText();
    assert.equal(trams.match(/— not answered —/g).length, 3, 'blank answers are shown, not hidden');
    assert.match(trams, /Status: Not promoted/);
    assert.equal((report.match(/When did this actually happen\?/g) || []).length, 3, 'answers appear once per follow-up, only in the detail');
    const wires = await alpha.locator('.wires li').allInnerTexts();
    assert.equal(wires.length, 1);
    assert.match(wires[0], /^Brand: A woman who alleges .* · PA story ↗ · Not promoted$/);
    assert.match(await bravo.locator('.wires li').innerText(), /^Levy: Visitor levy · PA story ↗/, 'older PA pitches fall back to their angle');
    assert.ok(!/You need to/i.test(report));
    console.log('PASS: report summary matches the wall, lists follow-ups in full with blanks shown, lists PA pitches with links');

    assert.deepEqual(errors, [], 'No browser JavaScript errors');
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
