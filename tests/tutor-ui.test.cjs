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
        auth: {
          getSession: async () => ({ data: { session: null }, error: null }),
          onAuthStateChange: fn => { listener = fn; return { data: { subscription: { unsubscribe() {} } } }; },
          signInWithPassword: async () => ({ data: { user: { id: 'staff', email: 'staff@example.test' } }, error: null }),
          signOut: async () => { listener?.('SIGNED_OUT', null); return { error: null }; },
        },
        rpc: async (name, args) => {
          mock.calls.push({ name, args });
          if (name === 'is_admin') return { data: mock.admin };
          if (name === 'is_tutor') return { data: !mock.denied };
          if (name === 'tutor_newsrooms' || name === 'admin_newsrooms') return { data: rooms };
          if (name === 'get_tutor_join_code') {
            if (mock.hold) return new Promise(resolve => { mock.resolveCode = () => resolve({ data: 'DEMO1234' }); });
            return { data: mock.admin ? mock.code : 'DEMO1234' };
          }
          if (name === 'tutor_conference') return mock.revoked ? { error: { message: 'Newsroom unavailable.' } } : { data: snapshot };
          if (name === 'tutor_set_pitch_note') { pitch.ep_note = args.p_note; return { data: null }; }
          if (name === 'admin_tutors') return { data: mock.tutors };
          if (name === 'set_tutor_access') {
            mock.tutors = [{ user_id: 'staff', email: args.p_email, newsroom_ids: args.p_newsroom_ids }]; return { data: null };
          }
          if (name === 'set_tutor_join_code') { mock.code = args.p_enabled ? 'DEMO5678' : null; return { data: mock.code }; }
          throw new Error(`Unexpected RPC: ${name}`);
        },
      }) };
      // Avoid OS fullscreen transitions in the test browser.
      Element.prototype.requestFullscreen = async () => {};
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
  try {
    const page = await pageFor('tutor.html');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByText('Newsroom A', { exact: true }).waitFor();
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
    page.once('dialog', dialog => dialog.accept('Check the figures'));
    await page.getByRole('button', { name: 'Note', exact: true }).click();
    await page.getByText('EP: Check the figures', { exact: true }).waitFor();
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
    await admin.getByRole('button', { name: 'Assign a tutor', exact: true }).click();
    await admin.locator('#tutor-email').fill('colleague@example.test');
    await admin.locator('[name="tutor-room"][value="room-a"]').check();
    await admin.getByRole('button', { name: 'Save access', exact: true }).click();
    await admin.getByText('colleague@example.test', { exact: true }).waitFor();
    assert.deepEqual(await admin.evaluate(() => mock.calls.find(c => c.name === 'set_tutor_access').args), { p_email: 'colleague@example.test', p_newsroom_ids: ['room-a'] });
    await admin.getByRole('button', { name: 'Tutor code', exact: true }).click();
    await admin.getByRole('button', { name: 'Enable tutor code', exact: true }).click();
    await admin.getByText('DEMO5678', { exact: true }).waitFor();
    admin.once('dialog', dialog => dialog.accept());
    await admin.getByRole('button', { name: 'Disable', exact: true }).click();
    await admin.getByText('No tutor join code is enabled for this newsroom.', { exact: true }).waitFor();
    console.log('PASS: admin assignment and code enable/disable');
    } else console.log('SKIP: local-only admin.html is not present');
    assert.deepEqual(errors, [], 'No browser JavaScript errors');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
