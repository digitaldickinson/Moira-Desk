// Admin newsroom list, Manage panel, selection bar and new conference dialog.
// External Playwright only; all Supabase calls are mocked and network access blocked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.MOIRA_PLAYWRIGHT_MODULE || 'playwright');
const { pageHtml } = require('./desk-page.cjs');
const file = path.join(__dirname, '..', 'admin.html');
if (!fs.existsSync(file)) { console.log('SKIP: local admin.html is not present'); process.exit(0); }
const html = pageHtml('admin.html');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const errors = [], calls = [];
  const base = () => [
    { newsroom_id: 'room-a', name: 'Alpha', members: 9, stories: 3, sent_stories: 1, has_code: true, code_updated_at: '2026-11-01T10:00:00Z', producer_name: 'Sam', pitches: 11, picked: 5,
      cuez_episode_id: '0f2c1d3e-1111-4222-8333-944455556666', cuez_episode_title: 'Lunch', cuez_part_uid: 'part-1', cuez_part_title: 'Part 1' },
    { newsroom_id: 'room-b', name: '<b>Bold</b>', members: 0, stories: 0, sent_stories: 0, has_code: false, producer_name: null, pitches: 0, picked: 0 },
    { newsroom_id: 'room-c', name: 'Charlie', members: 4, stories: 1, sent_stories: 0, has_code: true, producer_name: null, pitches: 2, picked: 1 },
    { newsroom_id: 'room-d', name: 'Delta', members: 6, stories: 0, sent_stories: 0, has_code: true, producer_name: 'Dee', pitches: 1, picked: 0 },
  ];
  let rooms = base(), codes = { 'room-a': 'TUTA1234' }, failMove = false, note = null;
  let folders = [{ id: 'folder-1', name: 'Year 2', newsroom_ids: ['room-c', 'room-d'] }];
  let tutors = [{ user_id: 't1', email: 'one@example.test', newsroom_ids: ['room-a'] }, { user_id: 't2', email: 'two@example.test', newsroom_ids: ['room-a', 'room-c'] }];
  async function rpc(name, args) {
    calls.push({ name, args });
    if (name === 'is_admin') return { data: true };
    if (name === 'admin_newsrooms') return { data: rooms };
    if (name === 'tutor_newsrooms') return { data: rooms.map((r) => ({ newsroom_id: r.newsroom_id, tutor_code_available: !!codes[r.newsroom_id] })) };
    if (name === 'admin_tutors') return { data: structuredClone(tutors) };
    if (name === 'get_admin_folders') return { data: structuredClone(folders) };
    if (name === 'get_tutor_join_code') return { data: codes[args.p_newsroom_id] || null };
    if (name === 'set_tutor_join_code') { codes[args.p_newsroom_id] = args.p_enabled ? 'NEWT5678' : null; if (!args.p_enabled) delete codes[args.p_newsroom_id]; return { data: codes[args.p_newsroom_id] || null }; }
    if (name === 'set_tutor_access') { tutors.find((t) => t.email === args.p_email).newsroom_ids = args.p_newsroom_ids; return { data: null }; }
    if (name === 'rename_newsroom') { rooms.find((r) => r.newsroom_id === args.p_newsroom_id).name = args.p_name; return { data: null }; }
    if (name === 'delete_newsroom') { rooms = rooms.filter((r) => r.newsroom_id !== args.p_newsroom_id); return { data: null }; }
    if (name === 'start_conference') { const r = rooms.find((x) => x.newsroom_id === args.p_newsroom_id); r.pitches = 0; r.picked = 0; r.producer_name = null; return { data: null }; }
    if (name === 'create_newsroom') { const id = `bulletin-${args.p_name.toLowerCase()}`; rooms.push({ newsroom_id: id, name: args.p_name, members: 0, stories: 0, sent_stories: 0, has_code: true, pitches: 0, picked: 0 }); return { data: [{ newsroom_id: id, join_code: 'NEWROOM1' }] }; }
    if (name === 'move_admin_newsrooms') {
      if (failMove) return { error: { message: 'Move failed.' } };
      folders.forEach((f) => { f.newsroom_ids = f.newsroom_ids.filter((id) => !args.p_newsroom_ids.includes(id)); });
      if (args.p_folder_id) folders.find((f) => f.id === args.p_folder_id).newsroom_ids.push(...args.p_newsroom_ids);
      return { data: null };
    }
    if (name === 'admin_conference') return { data: args.p_newsroom_ids.map((id) => ({ id, name: rooms.find((r) => r.newsroom_id === id).name, producer_name: null,
      pitches: id === 'room-a' ? [{ id: 'p1', slug: 'Bins', angle: '', status: 'pitched', pitched_by: 'Sam', ep_note: note },
        { id: 'p2', slug: 'Fete', status: 'spiked', spike_reason: 'Too soft', pitched_by: 'Jo' }] : [], stories: [], order: [], feedback: [] })) };
    if (name === 'set_pitch_note') { note = args.p_note; return { data: null }; }
    throw Error(`Unexpected RPC ${name}`);
  }
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => d.accept());
    await page.exposeFunction('adminMockRpc', rpc);
    await page.addInitScript(() => {
      let listener;
      window.mockSignOut = () => listener?.('SIGNED_OUT', null);
      window.supabase = { createClient: () => ({
        auth: { getSession: async () => ({ data: { session: { user: { id: 'admin-a', email: 'admin@example.test' } } } }), signOut: async () => ({}),
          onAuthStateChange: (fn) => { listener = fn; return { data: { subscription: { unsubscribe() {} } } }; } },
        rpc: (name, args) => window.adminMockRpc(name, args),
        functions: { invoke: async () => ({ data: { status: 'missing', checkedAt: new Date().toISOString(), expiresAt: null } }) },
      }) };
    });
    await page.route('**/*', (route) => route.request().url() === 'http://moira.test/admin.html' ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://moira.test/admin.html');
    await page.locator('[data-newsroom="room-a"]').waitFor();
    const count = (n) => calls.filter((c) => c.name === n).length;
    const panel = page.locator('#manage');
    const dlg = page.locator('#dlg');
    const text = async (loc) => (await loc.textContent()).replace(/\s+/g, ' ').trim();

    // ── List: summary, rows, setup line, no conference card or create form ──
    assert.equal(await page.locator('#summary').innerText(), '4 newsrooms in 1 folder · 19 students');
    assert.equal(await page.locator('#new-name').count(), 0, 'no always-visible New newsroom form');
    assert.equal(await page.getByText('Tick newsrooms in the table below').count(), 0);
    const rowA = page.locator('[data-newsroom="room-a"]');
    assert.equal(await text(rowA.locator('[role="cell"]').nth(3)), '✓ Code · ✓ Tutors 2 · ✓ Tutor code · ✓ Cuez');
    assert.equal(await rowA.locator('button').count(), 1, 'one Manage button per row');
    const rowB = page.locator('[data-newsroom="room-b"]');
    assert.equal(await text(rowB.locator('[role="cell"]').nth(3)), '– Code (none) · – Tutor (none) · – Tutor code (none) · – Cuez (none)');
    assert.ok((await text(rowB)).includes('No producer yet') && (await text(rowB)).includes('No pitches yet'));
    assert.equal(await page.locator('b').count(), 0, 'names escaped');
    assert.ok((await text(rowA)).includes('11 pitches · 5 picked'));
    await page.getByText('Tick newsrooms to open the EP wall, send an alert, make a report, move them to a folder or start a new conference.').waitFor();
    console.log('PASS: summary, one Manage button per row, setup line, escaping, empty selection bar');

    // ── Selection bar, folder notes, collapsed folders, Tick folder with search ──
    const search = page.getByLabel('Find a newsroom');
    await page.locator('.folder-toggle', { hasText: 'Year 2' }).click();
    await page.getByRole('checkbox', { name: 'Select Delta' }).check();
    await page.locator('.folder-toggle', { hasText: 'Year 2' }).click();
    assert.equal(await page.locator('[data-folder="folder-1"] [data-newsroom]').count(), 0, 'folder collapsed');
    assert.equal(await page.locator('[data-folder="folder-1"] .folder-selection').innerText(), '1 ticked');
    await page.getByLabel('Select Alpha').click();
    assert.equal(await page.locator('.selbar strong').innerText(), '2 newsrooms');
    assert.equal(await page.locator('.selbar .names').innerText(), 'Alpha, Delta', 'ticks in a collapsed folder are listed');
    assert.equal(await page.locator('.selbar .names').getAttribute('title'), 'Alpha, Delta');
    assert.equal(await rowA.getAttribute('class'), 'rl-row ticked');
    await search.click();
    await page.keyboard.type('har');
    await page.keyboard.press('ArrowLeft');
    await search.evaluate((el) => { el.dataset.same = '1'; });
    assert.equal(await page.locator('[data-folder="folder-1"] .pill').innerText(), '1 of 2');
    assert.equal(await page.locator('[data-folder="unfiled"]').count(), 0, 'folders with no match hidden');
    await page.getByRole('button', { name: 'Tick folder Year 2' }).click();
    assert.deepEqual(await page.evaluate(() => [...state.selected].sort()), ['room-a', 'room-c', 'room-d'], 'Tick folder acts on the match only');
    assert.deepEqual(await search.evaluate((el) => [el.dataset.same, el.value, el.selectionStart]), ['1', 'har', 2]);
    assert.equal(await page.locator('[data-folder="folder-1"] .folder-selection').innerText(), '2 ticked');
    await page.getByRole('button', { name: 'Untick folder Year 2' }).click();
    assert.deepEqual(await page.evaluate(() => [...state.selected].sort()), ['room-a', 'room-d']);
    await search.fill('zzz');
    await page.getByText('No newsroom matches ‘zzz’.', { exact: true }).waitFor();
    assert.equal(await page.locator('.selbar strong').innerText(), '2 newsrooms');
    await search.fill('');
    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    console.log('PASS: selection bar names, folder "n ticked", collapsed folders, Tick/Untick folder respects search, search keeps focus');

    // ── Manage panel values ──
    await rowA.getByRole('button', { name: 'Manage Alpha' }).click();
    await panel.locator('.manage-panel').waitFor();
    assert.equal(await page.evaluate(() => document.getElementById('app').inert), true, 'page behind is inert');
    const p = await text(panel);
    for (const t of ['Alpha', '9 members · Unfiled', 'Sam', '11 pitches · 5 picked', '9 members joined', 'Set 1 Nov · shown once, stored as a hash',
      'On · assigned tutors can show it', 'one@example.test, two@example.test', 'Newsroom ID: room-a', 'Delete this newsroom'])
      assert.ok(p.includes(t), `panel shows ${t}`);
    const link = panel.getByRole('link', { name: 'https://app.cuez.live/episode/0f2c1d3e-1111-4222-8333-944455556666' });
    assert.equal(await link.getAttribute('target'), '_blank');
    assert.equal(await panel.getByText('Lunch').count(), 0, 'no episode title');
    assert.equal(await panel.getByRole('switch', { name: 'Tutor join code' }).getAttribute('aria-checked'), 'true');
    await page.waitForTimeout(300);
    await page.screenshot({ path: '/private/tmp/moira-admin-manage.png' });
    // Sub-dialogs open above the panel, and the panel refreshes afterwards.
    await panel.getByRole('button', { name: 'Rename', exact: true }).click();
    assert.equal(await page.evaluate(() => document.elementFromPoint(640, 450)?.closest('dialog')?.id), 'dlg', 'dialog stacks above the panel');
    await page.getByLabel('Name', { exact: true }).fill('Alpha Prime');
    await dlg.getByRole('button', { name: 'Rename', exact: true }).click();
    await panel.locator('#manage-title', { hasText: 'Alpha Prime' }).waitFor();
    await panel.getByRole('button', { name: 'Show', exact: true }).click();
    await dlg.getByText('TUTA1234', { exact: true }).waitFor();
    await dlg.getByRole('button', { name: 'New tutor code' }).click(); // the confirm() warning is accepted by the test
    await dlg.getByText('NEWT5678', { exact: true }).waitFor();
    await dlg.getByRole('button', { name: 'Done' }).click();
    await panel.getByRole('switch', { name: 'Tutor join code' }).click();
    await panel.getByText('Off', { exact: true }).waitFor();
    assert.equal(await dlg.evaluate((d) => d.open), false, 'panel switch does not open a dialog');
    assert.equal(await text(rowA.locator('[role="cell"]').nth(3)), '✓ Code · ✓ Tutors 2 · – Tutor code (none) · ✓ Cuez', 'row follows the switch');
    assert.equal(await panel.getByRole('button', { name: 'Show', exact: true }).count(), 0);
    await panel.getByRole('button', { name: 'Edit', exact: true }).click();
    await dlg.getByRole('heading', { name: 'Tutors for Alpha Prime' }).waitFor();
    await dlg.getByLabel('one@example.test').uncheck();
    await dlg.getByRole('button', { name: 'Save tutors' }).click();
    await panel.getByText('two@example.test', { exact: true }).waitFor();
    assert.deepEqual(calls.filter((c) => c.name === 'set_tutor_access').map((c) => c.args), [{ p_email: 'one@example.test', p_newsroom_ids: [] }], 'only the changed tutor is saved');
    console.log('PASS: Manage panel values, Cuez link, dialogs above the panel, refresh after rename, tutor code switch, Show and rotate, tutors dialog');

    // Esc closes the sub-dialog first, then the panel; focus returns to Manage.
    await panel.getByRole('button', { name: 'Move', exact: true }).click();
    await page.keyboard.press('Escape');
    await dlg.waitFor({ state: 'hidden' });
    assert.equal(await panel.isVisible(), true);
    await page.keyboard.press('Escape');
    await panel.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Manage Alpha Prime');
    assert.equal(await page.evaluate(() => document.getElementById('app').inert), false);
    console.log('PASS: Esc closes the dialog, then the panel, and focus returns to the row');

    // ── New conference dialog: from the panel and from the bar ──
    await page.locator('.folder-toggle', { hasText: 'Year 2' }).click();
    await page.getByRole('button', { name: 'Manage Delta' }).click();
    await panel.getByRole('button', { name: 'New conference…' }).click();
    await dlg.getByRole('heading', { name: 'Start a new conference', exact: true }).waitFor();
    assert.deepEqual(await dlg.locator('li').allInnerTexts(), ['Delta']);
    await dlg.getByRole('button', { name: 'Make a report first' }).click();
    await dlg.getByRole('heading', { name: 'Report: Delta' }).waitFor();
    assert.equal(count('start_conference'), 0, 'Make a report first leaves the conference alone');
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await panel.getByRole('button', { name: 'New conference…' }).click();
    await dlg.getByRole('button', { name: 'Start new conference' }).click();
    await page.getByText('New conference started for Delta.', { exact: true }).waitFor();
    assert.deepEqual(calls.filter((c) => c.name === 'start_conference').map((c) => c.args.p_newsroom_id), ['room-d']);
    await panel.getByText('No pitches yet', { exact: true }).waitFor();
    assert.ok((await text(panel)).includes('No producer claimed'), 'panel refreshed');
    await page.keyboard.press('Escape');
    for (const n of ['Alpha Prime', 'Charlie']) await page.getByRole('checkbox', { name: `Select ${n}` }).check();
    await page.locator('.selbar').getByRole('button', { name: 'New conference…' }).click();
    await dlg.getByRole('heading', { name: 'Start a new conference for 2 newsrooms' }).waitFor();
    await page.screenshot({ path: '/private/tmp/moira-admin-conference.png' });
    await dlg.getByRole('button', { name: 'Start new conference' }).click();
    await page.getByText('New conference started for Alpha Prime, Charlie.', { exact: true }).waitFor();
    assert.deepEqual(calls.filter((c) => c.name === 'start_conference').map((c) => c.args.p_newsroom_id), ['room-d', 'room-a', 'room-c'], 'only the listed newsrooms');
    console.log('PASS: new conference dialog from the panel and the bar, Make a report first, only listed newsrooms cleared');

    // ── Report dialog from the bar ──
    await page.locator('.selbar').getByRole('button', { name: 'Report…' }).click();
    assert.deepEqual(await dlg.locator('li').allInnerTexts(), ['Alpha Prime', 'Charlie']);
    await dlg.getByRole('checkbox', { name: 'Include scripts' }).waitFor();
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'Clear', exact: true }).click();

    // ── New newsroom with a folder, and a failed move ──
    await page.getByRole('button', { name: 'New newsroom' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Echo');
    assert.equal(await page.getByLabel('Folder (optional)').inputValue(), 'folder-1', 'defaults to the open folder');
    await dlg.getByRole('button', { name: 'Create' }).click();
    await dlg.getByText('NEWROOM1', { exact: true }).waitFor();
    assert.ok(folders[0].newsroom_ids.includes('bulletin-echo'));
    await dlg.getByRole('button', { name: 'Done' }).click();
    await page.locator('[data-folder="folder-1"] [data-newsroom="bulletin-echo"]').waitFor();
    failMove = true;
    await page.getByRole('button', { name: 'New newsroom' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Foxtrot');
    await page.getByLabel('Folder (optional)').selectOption('folder-1');
    await dlg.getByRole('button', { name: 'Create' }).click();
    await dlg.getByText('NEWROOM1', { exact: true }).waitFor();
    await dlg.getByRole('button', { name: 'Done' }).click();
    await page.getByText("Foxtrot was created but couldn't be moved to its folder, so it's in Unfiled. Move failed.").waitFor();
    await page.locator('[data-folder="unfiled"] [data-newsroom="bulletin-foxtrot"]').waitFor();
    failMove = false;
    console.log('PASS: new newsroom dialog lands in the chosen folder, shows the code once, and reports a failed move');

    // ── Delete from the panel closes it; a vanished newsroom closes it with a message ──
    await page.getByRole('button', { name: 'Manage Charlie' }).click();
    await panel.getByRole('button', { name: 'Delete newsroom…' }).click();
    await page.getByLabel('Type Charlie to confirm').fill('Charlie');
    await dlg.getByRole('button', { name: 'Delete newsroom' }).click();
    await panel.waitFor({ state: 'hidden' });
    await page.getByText('Deleted Charlie.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Manage Delta' }).click();
    rooms = rooms.filter((r) => r.newsroom_id !== 'room-d');
    await page.evaluate(() => loadRooms());
    await panel.waitFor({ state: 'hidden' });
    await page.getByText('Delta is no longer available, so its Manage panel has closed.').waitFor();
    console.log('PASS: delete needs the typed name and closes the panel; a vanished newsroom closes it with a message');

    // ── Tutor access card and dialog ──
    const tutorsCard = page.locator('#tutors');
    assert.equal(await tutorsCard.getByRole('button', { name: 'Remove tutor' }).count(), 0, 'Remove tutor moved into the dialog');
    assert.ok((await text(tutorsCard)).includes('Alpha Prime'));
    await tutorsCard.getByRole('button', { name: 'Edit access for two@example.test' }).click();
    assert.deepEqual(await dlg.locator('.tg-head span').allInnerTexts(), ['Year 2', 'Unfiled']);
    await dlg.getByRole('button', { name: 'Tick all in Year 2' }).click();
    assert.equal(await dlg.locator('[data-group="folder-1"] input:checked').count(), 1);
    assert.equal(await dlg.getByRole('button', { name: 'Remove tutor' }).count(), 1);
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    console.log('PASS: tutor access rows, grouped tutor dialog with Tick all and Remove tutor inside');

    // ── The shared EP wall, with the admin RPCs ──
    await page.getByRole('checkbox', { name: 'Select Alpha Prime' }).check();
    await page.getByRole('button', { name: 'Open EP wall' }).click();
    await page.locator('.wall-pitch').waitFor();
    assert.equal(calls.filter((c) => c.name === 'admin_conference').at(-1).args.p_scripts, false);
    assert.equal(await page.getByRole('button', { name: '▸ 1 spiked' }).count(), 1, 'spiked pitches collapse');
    await page.locator('.wall-pitch').click();
    await page.getByLabel('Your note to the newsroom').fill('Get a council voice');
    await page.getByRole('button', { name: 'Save note' }).click();
    await page.getByText('EP: Get a council voice', { exact: true }).waitFor();
    assert.deepEqual(calls.filter((c) => c.name === 'set_pitch_note').at(-1).args, { p_pitch_id: 'p1', p_note: 'Get a council voice' });
    await page.getByRole('button', { name: 'Hide notes' }).click();
    assert.equal(await page.locator('.wall-pitch .note').count(), 0);
    await page.locator('.col-head').click();
    await page.locator('.wall-focus').waitFor();
    await page.keyboard.press('p');
    await page.locator('.wall-strip').waitFor();
    assert.equal(await page.locator('.wall-pitch').isDisabled(), true);
    await page.keyboard.press('p');
    await page.keyboard.press('Escape');
    await page.locator('.wall-cols').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.wall').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    console.log('PASS: admin EP wall is the shared wall, with admin_conference and set_pitch_note');

    // ── Phone width ──
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'page does not scroll sideways');
    assert.equal(await page.locator('.room-list-wrap').first().evaluate((el) => el.scrollWidth > el.clientWidth), true, 'rows scroll inside their box');
    await page.getByRole('checkbox', { name: 'Select Alpha Prime' }).check();
    assert.ok(await page.locator('.selbar-in').evaluate((el) => el.scrollHeight) > 60, 'selection bar wraps');
    await page.screenshot({ path: '/private/tmp/moira-admin-mobile.png' });
    await page.getByRole('button', { name: 'Manage Alpha Prime' }).click();
    assert.equal(Math.round(await panel.locator('.manage-panel').evaluate((el) => el.getBoundingClientRect().width)), 390, 'panel is full width');
    await page.waitForTimeout(300);
    await page.screenshot({ path: '/private/tmp/moira-admin-manage-mobile.png' });

    // ── Signing out with the panel and a dialog open leaves nothing on screen ──
    await panel.getByRole('button', { name: 'Rename', exact: true }).click();
    await page.evaluate(() => mockSignOut());
    await page.locator('#email').waitFor();
    assert.equal(await panel.isVisible(), false);
    assert.equal(await panel.innerHTML(), '');
    assert.equal(await dlg.evaluate((d) => d.open || d.innerHTML !== ''), false);
    assert.equal(await page.evaluate(() => state.rooms.length + state.selected.size + (state.manageId ? 1 : 0)), 0);
    assert.equal(await page.locator('.selbar').count(), 0);
    console.log('PASS: phone layout, full-width panel, and sign-out with the panel and a dialog open');

    assert.deepEqual(errors, [], 'No browser JavaScript errors');

    // ── The real script tag: loaded from GitHub Pages and checked against its hash ──
    const raw = fs.readFileSync(file, 'utf8').replace(/<script\b[^>]*\bsrc="https:\/\/cdn[^"]*"[^>]*>\s*<\/script>/g, '');
    const shared = fs.readFileSync(path.join(__dirname, '..', 'desk-shared.js'), 'utf8');
    for (const [body, ok] of [[shared, true], [`${shared}\n// changed`, false]]) {
      const ctx = await browser.newContext();
      const pg = await ctx.newPage();
      await pg.exposeFunction('adminMockRpc', rpc);
      await pg.addInitScript(() => { window.supabase = { createClient: () => ({
        auth: { getSession: async () => ({ data: { session: { user: { id: 'admin-a', email: 'admin@example.test' } } } }), signOut: async () => ({}) },
        rpc: (name, args) => window.adminMockRpc(name, args),
        functions: { invoke: async () => ({ data: { status: 'missing', checkedAt: new Date().toISOString(), expiresAt: null } }) } }) }; });
      await pg.route('**/*', (route) => {
        const url = route.request().url();
        if (url === 'http://moira.test/admin.html') return route.fulfill({ contentType: 'text/html', body: raw });
        if (url.startsWith('https://digitaldickinson.github.io/Moira-Desk/desk-shared.js?v=')) return route.fulfill({ contentType: 'text/javascript', body, headers: { 'Access-Control-Allow-Origin': '*' } });
        return route.abort();
      });
      await pg.goto('http://moira.test/admin.html');
      if (ok) await pg.locator('[data-newsroom]').first().waitFor();
      else await pg.getByText("Couldn't load desk-shared.js from the Moira:Desk site.").waitFor();
      await ctx.close();
    }
    console.log('PASS: admin.html loads desk-shared.js from GitHub Pages only when it matches the pinned hash');
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
