// Run with an external Playwright installation; no browser dependency in the app.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.MOIRA_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  async function pageFor(file, admin = false) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(({ admin }) => {
      window.mock = { calls: [], admin, denied: false, revoked: false, code: null, tutors: [] };
      let listener;
      const rooms = [{ newsroom_id: 'room-a', name: 'Newsroom A', members: 12, pitches: 1, picked: 0,
        stories: 1, producer_name: 'Student producer', tutor_code_available: true, cuez_configured: false }];
      const pitch = { id: 'pitch-a', slug: '<img src=x onerror=alert(1)>', angle: 'Local story', status: 'pitched', pitched_by: 'Student', ep_note: null };
      const snapshot = [{ id: 'room-a', name: 'Newsroom A', producer_name: 'Student producer', pitches: [pitch],
        stories: [{ id: 'story-a', slug: 'Council', format: 'PKG', duration: 30, script: 'Example script' }], order: ['story-a'] }];
      window.supabase = { createClient: () => ({
        functions: { invoke: async (name, { body }) => {
          mock.calls.push({ name: body.action });
          if (mock.tokenError) return { error: { message: 'Status unavailable' } };
          return { data: mock.tokenInfo || { status: 'valid', checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + (4 * 24 + 1) * 3600000).toISOString() } };
        } },
        auth: {
          getSession: async () => ({ data: { session: null }, error: null }),
          onAuthStateChange: fn => { listener = fn; return { data: { subscription: { unsubscribe() {} } } }; },
          signInWithPassword: async () => ({ data: { user: { id: 'staff', email: 'staff@example.test' } }, error: null }),
          signOut: async () => { listener?.('SIGNED_OUT', null); return { error: null }; },
        },
        rpc: async (name, args) => {
          mock.calls.push({ name, args });
          if (name === 'tutor_send_alert') {
            if (mock.alertError) return { error: { message: 'Alert could not be sent. Try again.' } };
            if (mock.holdAlert) return new Promise(resolve => { mock.resolveAlert = () => resolve({ data: null }); });
            return { data: null };
          }
          if (name === 'is_admin') return { data: mock.admin };
          if (name === 'is_tutor') return { data: !mock.denied };
          if (name === 'tutor_newsrooms') return { data: rooms.map(r => ({ ...r, tutor_code_available: mock.admin ? !!mock.code : true })) };
          if (name === 'admin_newsrooms') return { data: rooms.map(r => ({ ...r })) };
          if (name === 'get_tutor_join_code') {
            if (mock.hold) return new Promise(resolve => { mock.resolveCode = () => resolve({ data: 'DEMO1234' }); });
            return { data: mock.admin ? mock.code : 'DEMO1234' };
          }
          if (name === 'tutor_conference' || name === 'admin_conference') return mock.revoked ? { error: { message: 'Newsroom unavailable.' } } : { data: snapshot };
          if (name === 'tutor_set_pitch_note' || name === 'set_pitch_note') {
            if (mock.noteError) return { error: { message: 'Could not save note. Try again.' } };
            pitch.ep_note = args.p_note; return { data: null };
          }
          if (name === 'admin_tutors') return { data: mock.tutors };
          if (name === 'set_tutor_access') {
            mock.tutors = [{ user_id: 'staff', email: args.p_email, newsroom_ids: args.p_newsroom_ids }]; return { data: null };
          }
          if (name === 'set_tutor_join_code') { mock.code = args.p_enabled ? 'DEMO5678' : null; return { data: mock.code }; }
          throw new Error(`Unexpected RPC: ${name}`);
        },
      }) };
      // Use the browser's real Fullscreen API to check the note dialog.
    }, { admin });
    await page.route('**/*', route => {
      if (route.request().url() === `http://moira.test/${file}`) {
        // Test only: substitute the CDN dependency with the stub above.
        const html = fs.readFileSync(path.join(root, file), 'utf8').replace(/<script\b[^>]*\bsrc="[^"]*"[^>]*>\s*<\/script>/g, '');
        return route.fulfill({ contentType: 'text/html', body: html });
      }
      return route.abort();
    });
    await page.goto(`http://moira.test/${file}`);
    await page.locator('#email').fill('staff@example.test');
    await page.locator('#password').fill('test-only-not-a-real-password');
    return page;
  }
  async function checkBroadcast(page) {
    assert.equal(await page.locator('[data-action="alert"]').isDisabled(), true);
    await page.getByRole('checkbox', { name: 'Select Newsroom A', exact: true }).check();
    await page.getByRole('button', { name: 'Send alert', exact: true }).click();
    assert.equal(await page.getByLabel('Message', { exact: true }).getAttribute('maxlength'), '240');
    await page.getByLabel('Message', { exact: true }).fill('  Everyone back in 5  ');
    await page.evaluate(() => { mock.alertError = true; });
    const send = page.getByRole('button', { name: 'Send to selected newsrooms', exact: true });
    await send.click();
    await page.getByText('Alert could not be sent. Try again.', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Message', { exact: true }).inputValue(), '  Everyone back in 5  ');
    await page.evaluate(() => { mock.alertError = false; mock.holdAlert = true; });
    await send.click();
    await page.waitForFunction(() => !!mock.resolveAlert);
    assert.equal(await send.isDisabled(), true);
    const count = await page.evaluate(() => mock.calls.filter(c => c.name === 'tutor_send_alert').length);
    await page.locator('#alert-form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    assert.equal(await page.evaluate(() => mock.calls.filter(c => c.name === 'tutor_send_alert').length), count);
    await page.evaluate(() => mock.resolveAlert());
    await page.getByText('Alert sent.', { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => mock.calls.filter(c => c.name === 'tutor_send_alert').at(-1).args), { p_newsroom_ids: ['room-a'], p_message: 'Everyone back in 5' });
    await page.getByRole('checkbox', { name: 'Select Newsroom A', exact: true }).uncheck();
    console.log('PASS: staff broadcast selection, trimmed message, retry preserves draft and duplicate submit prevented');
  }
  try {
    const page = await pageFor('tutor.html');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByText('Newsroom A', { exact: true }).waitFor();
    await checkBroadcast(page);
    assert.equal(await page.locator('[data-action="wall"]').isDisabled(), true);
    assert.equal(await page.evaluate(() => mock.calls.some(c => c.name === 'get_tutor_join_code')), false);
    await page.getByRole('button', { name: 'Show join code' }).click();
    await page.getByText('DEMO1234', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    assert.equal(await page.locator('#dlg').innerHTML(), '');
    await page.getByRole('checkbox', { name: 'Select Newsroom A', exact: true }).check();
    await page.getByRole('button', { name: 'Open EP wall' }).click();
    await page.locator('.wall-pitch').waitFor();
    assert.equal(await page.locator('.wall img').count(), 0, 'pitch HTML escaped');
    await page.getByRole('button', { name: 'Note', exact: true }).click();
    await page.getByRole('dialog', { name: 'Add EP note' }).waitFor();
    assert.equal(await page.evaluate(() => document.fullscreenElement?.classList.contains('wall')), true);
    await page.getByLabel('Your note to the newsroom').fill('Check the figures');
    await page.evaluate(() => pollWall());
    assert.equal(await page.getByLabel('Your note to the newsroom').inputValue(), 'Check the figures', 'live refresh preserves draft');
    assert.equal(await page.getByLabel('Your note to the newsroom').evaluate(el => el === document.activeElement), true);
    await page.evaluate(() => { mock.noteError = true; });
    await page.getByRole('button', { name: 'Save note', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Could not save note' }).waitFor();
    assert.equal(await page.getByLabel('Your note to the newsroom').inputValue(), 'Check the figures');
    await page.evaluate(() => { mock.noteError = false; });
    await page.getByRole('button', { name: 'Save note', exact: true }).click();
    await page.getByText('EP: Check the figures', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.fullscreenElement?.classList.contains('wall')), true, 'saving keeps fullscreen');
    await page.getByRole('button', { name: 'Edit note', exact: true }).click();
    await page.getByLabel('Your note to the newsroom').fill('Cancelled edit');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByText('EP: Check the figures', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.fullscreenElement?.classList.contains('wall')), true, 'cancelling keeps fullscreen');
    await page.getByRole('button', { name: 'Edit note', exact: true }).click();
    await page.getByLabel('Your note to the newsroom').fill('');
    await page.getByRole('button', { name: 'Save note', exact: true }).click();
    await page.getByRole('button', { name: 'Note', exact: true }).waitFor();
    assert.equal(await page.locator('.wall-pitch .note').count(), 0, 'blank note removes existing note');
    await page.evaluate(async () => { mock.revoked = true; await pollWall(); });
    assert.equal(await page.locator('.wall-pitch').count(), 0, 'revoked room cleared');
    await page.getByRole('button', { name: 'Close (Esc)' }).click();
    await page.evaluate(() => { mock.revoked = false; });
    await page.getByRole('button', { name: 'Generate report' }).click();
    await page.getByText('Report ready', { exact: true }).waitFor();
    let call = await page.evaluate(() => mock.calls.filter(c => c.name === 'tutor_conference').at(-1));
    assert.equal(call.args.p_scripts, false);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Include scripts in the report' }).check();
    await page.getByRole('button', { name: 'Generate report' }).click();
    await page.getByText('Report ready', { exact: true }).waitFor();
    call = await page.evaluate(() => mock.calls.filter(c => c.name === 'tutor_conference').at(-1));
    assert.equal(call.args.p_scripts, true);
    const report = await page.evaluate(async () => (await fetch(lastReport.url)).text());
    assert.ok(report.includes('Example script') && report.includes('&lt;img'));
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.screenshot({ path: '/private/tmp/moira-tutor-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: '/private/tmp/moira-tutor-mobile.png' });
    await page.evaluate(() => { mock.hold = true; });
    await page.getByRole('button', { name: 'Show join code' }).click();
    await page.waitForFunction(() => !!mock.resolveCode);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.locator('#email').waitFor();
    await page.evaluate(() => mock.resolveCode());
    await page.waitForFunction(() => document.querySelector('#dlg').innerHTML === '' && !document.querySelector('.wall'));
    assert.equal(await page.evaluate(() => state.rooms.length === 0 && lastReport === null), true);
    assert.equal(await page.locator('text=DEMO1234').count(), 0);
    console.log('PASS: tutor selection, on-demand code, wall, notes, escaping, revocation, reports, mobile layout, sign-out and late response');

    const denied = await pageFor('tutor.html');
    await denied.evaluate(() => { mock.denied = true; });
    await denied.getByRole('button', { name: 'Sign in', exact: true }).click();
    await denied.getByRole('alert').filter({ hasText: 'no tutor access' }).waitFor();
    assert.equal(await denied.locator('[data-action="wall"]').count(), 0);
    console.log('PASS: non-staff account refused');

    if (fs.existsSync(path.join(root, 'admin.html'))) {
    const admin = await pageFor('admin.html', true);
    await admin.getByRole('button', { name: 'Sign in', exact: true }).click();
    await admin.getByText('Newsroom A', { exact: true }).waitFor();
    await checkBroadcast(admin);
    const tokenPill = admin.locator('[data-action="cuez-token-status"]');
    await tokenPill.filter({ hasText: '4 days left' }).waitFor();
    assert.ok((await tokenPill.getAttribute('class')).includes('ok'));
    await admin.locator('#new-name').fill('Unsaved newsroom name');
    await admin.evaluate(async () => {
      mock.tokenInfo = { status: 'valid', checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 2 * 3600000).toISOString() };
      await refreshCuezTokenStatus();
    });
    assert.ok((await tokenPill.getAttribute('class')).includes('err'));
    assert.equal(await admin.locator('#new-name').inputValue(), 'Unsaved newsroom name');
    await admin.evaluate(() => { mock.tokenInfo = { status: 'expired', checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() - 1000).toISOString() }; });
    await tokenPill.click();
    await tokenPill.filter({ hasText: 'expired' }).waitFor();
    await admin.screenshot({ path: '/private/tmp/moira-admin-token-expired.png' });
    await admin.evaluate(() => { mock.tokenError = true; });
    await tokenPill.click();
    await tokenPill.filter({ hasText: 'check unavailable' }).waitFor();
    assert.ok(!(await tokenPill.getAttribute('class')).includes('ok'));
    await admin.evaluate(() => { mock.tokenError = false; mock.tokenInfo = null; });
    await tokenPill.click();
    await tokenPill.filter({ hasText: '4 days left' }).waitFor();
    const rowCode = admin.locator('#app [data-action="tutor-code"]');
    await rowCode.waitFor();
    assert.equal(await rowCode.getAttribute('title'), 'Tutor code: disabled');
    await admin.getByRole('button', { name: 'Assign a tutor', exact: true }).click();
    await admin.locator('#tutor-email').fill('colleague@example.test');
    await admin.locator('[name="tutor-room"][value="room-a"]').check();
    await admin.getByRole('button', { name: 'Save access', exact: true }).click();
    await admin.getByText('colleague@example.test', { exact: true }).waitFor();
    assert.deepEqual(await admin.evaluate(() => mock.calls.find(c => c.name === 'set_tutor_access').args), { p_email: 'colleague@example.test', p_newsroom_ids: ['room-a'] });
    await admin.getByRole('heading', { name: 'Join codes for colleague@example.test', exact: true }).waitFor();
    await admin.getByRole('button', { name: 'Newsroom A — set up or view code', exact: true }).click();
    const toggle = admin.getByRole('switch', { name: 'Tutor code', exact: true });
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    await toggle.click();
    await admin.getByText('DEMO5678', { exact: true }).waitFor();
    assert.equal(await toggle.getAttribute('aria-checked'), 'true');
    assert.ok((await rowCode.getAttribute('class')).includes('tutor-code-enabled'));
    await admin.getByRole('button', { name: 'Done', exact: true }).click();
    await admin.getByRole('button', { name: 'Refresh', exact: true }).click();
    await admin.getByRole('button', { name: 'Assign a tutor', exact: true }).waitFor();
    assert.ok((await rowCode.getAttribute('class')).includes('tutor-code-enabled'), 'enabled colour restored from database on refresh');
    await admin.getByRole('button', { name: 'Join codes', exact: true }).click();
    await admin.getByRole('button', { name: 'Newsroom A — set up or view code', exact: true }).click();
    await admin.getByText('DEMO5678', { exact: true }).waitFor();
    assert.equal(await admin.evaluate(() => mock.calls.filter(c => c.name === 'set_tutor_join_code').length), 1, 'viewing an existing code does not rotate it');
    await toggle.click();
    await admin.getByText('No tutor join code is enabled for this newsroom.', { exact: true }).waitFor();
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    assert.equal(await rowCode.getAttribute('title'), 'Tutor code: disabled');
    assert.equal((await rowCode.getAttribute('class')).includes('tutor-code-enabled'), false);
    await admin.getByRole('button', { name: 'Done', exact: true }).click();
    await admin.getByRole('checkbox', { name: 'Select Newsroom A', exact: true }).check();
    await admin.locator('[data-action="wall"]').click();
    await admin.getByRole('button', { name: 'Note', exact: true }).click();
    await admin.getByLabel('Your note to the newsroom').fill('Admin feedback');
    await admin.evaluate(() => pollWall());
    assert.equal(await admin.getByLabel('Your note to the newsroom').inputValue(), 'Admin feedback');
    assert.equal(await admin.evaluate(() => document.fullscreenElement?.classList.contains('wall')), true);
    await admin.screenshot({ path: '/private/tmp/moira-note-modal.png' });
    await admin.getByRole('button', { name: 'Save note', exact: true }).click();
    await admin.getByText('EP: Admin feedback', { exact: true }).waitFor();
    assert.equal(await admin.evaluate(() => document.fullscreenElement?.classList.contains('wall')), true);
    console.log('PASS: admin assignment opens code setup, Join codes reopens existing code without rotation, and code enable/disable');
    } else console.log('SKIP: local-only admin.html is not present');
    assert.deepEqual(errors, [], 'No browser JavaScript errors');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
