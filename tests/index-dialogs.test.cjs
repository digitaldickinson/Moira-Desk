// Uses an external Playwright installation; all network calls are blocked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.MOIRA_PLAYWRIGHT_MODULE || 'playwright');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
assert.equal(/\b(?:prompt|confirm|alert)\s*\(/.test(source), false, 'No browser pop-up calls remain');
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', dialog => { errors.push('Unexpected native dialog: ' + dialog.type()); dialog.dismiss(); });
    const hook = `
      state.currentBulletinId = 'bulletin-local';
      seedLocalData(); bindGlobalEvents(); render();
      window.testDesk = { state, deskDialog, confirmAction, askName, render, deleteStory, spikePitch, calls: [],
        setConference() {
          state.localMode = false; supabaseUser = { id: 'test-user' };
          state.meta.producerUser = 'test-user'; state.meta.conferenceId = 'conference-a';
          state.pitchesMap['pitch-a'] = { id: 'pitch-a', slug: '<img src=x onerror=alert(1)>', status: 'pitched', conferenceId: 'conference-a', position: 0, spikeReason: 'Earlier reason' };
          DB = { ...DB_NULL, pitchAction: async (name, args) => { testDesk.calls.push({ name, args }); return true; } };
          refreshPitches = async () => {};
        }
      };
    `;
    const html = source.replace(/<script\b[^>]*\bsrc="[^"]*"[^>]*>\s*<\/script>/g, '')
      .replace(/import \{ createClient \} from "[^"]+";/, 'const createClient = () => { throw Error("No live backend in tests"); };')
      .replace('        boot();', hook);
    await page.route('**/*', route => route.request().url() === 'http://localhost:4173/'
      ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://localhost:4173/');
    await page.waitForFunction(() => !!window.testDesk);
    const prompterLink = page.getByTestId('open-prompter');
    await prompterLink.waitFor();
    assert.equal(await prompterLink.getAttribute('href'), 'prompt.html?room=bulletin-local');
    assert.equal(await prompterLink.getAttribute('target'), '_blank');
    assert.equal(await prompterLink.getAttribute('rel'), 'noopener');

    // Name entry: required validation, Escape/cancel and actual saved value.
    await page.evaluate(() => { testDesk.result = undefined; testDesk.askName().then(v => { testDesk.result = v; }); });
    await page.getByRole('dialog').getByRole('button', { name: 'Save name', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Please enter your name' }).waitFor();
    await page.getByLabel('Name', { exact: true }).fill('Student editor');
    await page.getByRole('dialog').getByRole('button', { name: 'Save name', exact: true }).click();
    assert.equal(await page.evaluate(() => testDesk.result), 'Student editor');
    await page.evaluate(() => { testDesk.askName('Existing name').then(v => { testDesk.result = v; }); });
    await page.getByLabel('Name', { exact: true }).press('Escape');
    assert.equal(await page.evaluate(() => testDesk.result), null);
    assert.equal(await page.locator('dialog').count(), 0);

    // Cancelling a real delete leaves the story untouched; accepting removes it.
    const id = await page.evaluate(() => Object.keys(testDesk.state.storiesMap)[0]);
    await page.evaluate(id => { testDesk.deleteStory(id); }, id);
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await page.evaluate(id => !!testDesk.state.storiesMap[id], id), true);

    // The editor underneath must keep unsaved text during a background refresh.
    await page.evaluate(id => { testDesk.state.myName = 'Student'; testDesk.state.ui.editingStoryId = id; testDesk.render('modal'); }, id);
    await page.locator('#edit-script').fill('Unsaved script that must survive');
    await page.locator('[data-action="cancel-edit"]').last().focus();
    await page.evaluate(() => { testDesk.confirmAction('A confirmation above the editor').then(v => { testDesk.result = v; }); });
    await page.evaluate(() => testDesk.render('modal', 'header', 'main'));
    await page.waitForTimeout(50);
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.waitForTimeout(50);
    assert.equal(await page.locator('#edit-script').inputValue(), 'Unsaved script that must survive');
    await page.evaluate(() => { testDesk.state.ui.editingStoryId = null; testDesk.render('modal'); });

    await page.evaluate(id => { testDesk.deleteStory(id); }, id);
    await page.getByRole('dialog').getByRole('button', { name: 'Delete story', exact: true }).click();
    assert.equal(await page.evaluate(id => !!testDesk.state.storiesMap[id], id), false);

    // Spike reasons support multiline text and preserve the draft on refresh.
    await page.evaluate(() => { testDesk.setConference(); testDesk.spikePitch('pitch-a'); });
    const reason = page.getByLabel('Reason (optional)', { exact: true });
    assert.equal(await reason.inputValue(), 'Earlier reason');
    assert.equal(await page.locator('dialog img').count(), 0, 'Slug is escaped');
    await reason.fill('Needs another source.\nCheck the figures first.');
    await page.evaluate(() => testDesk.render('main', 'modal'));
    await page.waitForTimeout(50);
    assert.equal(await reason.inputValue(), 'Needs another source.\nCheck the figures first.');
    assert.equal(await reason.evaluate(el => document.activeElement === el), true);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator('dialog').evaluate(el => el.getBoundingClientRect().width <= innerWidth), true);
    await page.screenshot({ path: '/private/tmp/moira-index-note-modal.png' });
    await page.getByRole('dialog').getByRole('button', { name: 'Spike pitch', exact: true }).click();
    const call = await page.evaluate(() => testDesk.calls.at(-1));
    assert.deepEqual(call, { name: 'spike_pitch', args: { p_pitch_id: 'pitch-a', p_reason: 'Needs another source.\nCheck the figures first.' } });
    await page.evaluate(() => { testDesk.spikePitch('pitch-a'); });
    await reason.fill('');
    await page.getByRole('dialog').getByRole('button', { name: 'Spike pitch', exact: true }).click();
    assert.equal(await page.evaluate(() => testDesk.calls.at(-1).args.p_reason), '');

    // Background room/session changes cannot apply an old confirmation.
    await page.evaluate(() => { testDesk.confirmAction('Old newsroom action').then(v => { testDesk.result = v; }); });
    await page.evaluate(() => { testDesk.state.currentBulletinId = 'different-room'; });
    await page.getByRole('dialog').getByRole('button', { name: 'Continue', exact: true }).click();
    assert.equal(await page.evaluate(() => testDesk.result), false);
    assert.deepEqual(errors, []);
    console.log('PASS: names, validation, Escape/cancel, delete confirmation, editor draft preservation, spike reasons, live refresh, mobile layout and stale-room cancellation');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
