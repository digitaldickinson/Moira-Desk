// Run with an external Playwright installation; Supabase is mocked and network access blocked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.MOIRA_PLAYWRIGHT_MODULE || 'playwright');
const html = fs.readFileSync(path.join(__dirname, '..', 'tutor.html'), 'utf8').replace(/<script\b[^>]*\bsrc="[^"]*"[^>]*>\s*<\/script>/g, '');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => {
      window.mock = { calls: [], feedback: [], saveError: false, next: 1 };
      const stories = [
        { id: 'seg', type: 'segment', slug: 'Headlines', duration: 20 },
        { id: 'story-a', slug: 'Bridge', format: 'PKG', reporter: 'Ana', presenter: 'Joe', duration: 95, script: 'LINK: The council say the bridge shuts tonight.\nIN: "We had no choice"' },
        { id: 'story-b', slug: '<img src=x onerror=alert(1)>', format: 'OOV', duration: 30, script: '' },
      ];
      const snapshot = () => [{ id: 'room-a', name: 'Newsroom A', producer_name: 'Sam', target_duration: 120, pitches: [],
        stories, order: ['seg', 'story-a', 'marker-line', 'story-b'], feedback: mock.feedback.map(f => ({ ...f })) }];
      window.supabase = { createClient: () => ({
        auth: {
          getSession: async () => ({ data: { session: { user: { id: 'staff', email: 'staff@example.test' } } }, error: null }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
          signOut: async () => ({ error: null }),
        },
        rpc: async (name, args) => {
          mock.calls.push({ name, args });
          if (name === 'is_admin') return { data: false };
          if (name === 'is_tutor') return { data: true };
          if (name === 'tutor_newsrooms') return { data: [{ newsroom_id: 'room-a', name: 'Newsroom A', members: 4, pitches: 0, picked: 0, stories: 2, producer_name: 'Sam', tutor_code_available: false }] };
          if (name === 'tutor_conference') return { data: snapshot() };
          if (name === 'tutor_save_feedback') {
            if (mock.saveError) return { error: { message: 'Could not save. Try again.' } };
            if (args.p_feedback_id) Object.assign(mock.feedback.find(f => f.id === args.p_feedback_id), { body: args.p_body.trim(), quote: args.p_quote?.trim() || null });
            else mock.feedback.push({ id: `fb-${mock.next++}`, story_id: args.p_story_id, story_slug: stories.find(s => s.id === args.p_story_id)?.slug || null,
              quote: args.p_story_id ? args.p_quote?.trim() || null : null, body: args.p_body.trim(), created_at: new Date().toISOString() });
            return { data: 'ok' };
          }
          if (name === 'tutor_delete_feedback') { mock.feedback = mock.feedback.filter(f => f.id !== args.p_feedback_id); return { data: null }; }
          throw new Error(`Unexpected RPC: ${name}`);
        },
      }) };
    });
    await page.route('**/*', route => route.request().url() === 'http://moira.test/tutor.html' ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://moira.test/tutor.html');
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    const review = page.locator('.review');
    await review.getByText('Overall feedback', { exact: true }).waitFor();
    assert.equal(await review.locator('img').count(), 0, 'slugs are escaped');
    assert.equal(await review.locator('.review-eop').count(), 1);
    assert.match(await review.locator('.review-page > p').first().textContent(), /TRT 1:55 · target 2:00/);

    // Overall feedback: blank is refused locally, a failed save keeps the draft.
    await review.getByRole('button', { name: 'Add overall feedback' }).click();
    const dialog = page.locator('dialog.fb-dialog[open]');
    assert.equal(await dialog.locator('#fb-quote').count(), 0, 'no quote for overall feedback');
    await dialog.getByRole('button', { name: 'Post feedback' }).click();
    await dialog.getByText('Write some feedback first.').waitFor();
    await dialog.locator('#fb-body').fill('Good pace, but the lead was buried.');
    await page.evaluate(() => { mock.saveError = true; });
    await dialog.getByRole('button', { name: 'Post feedback' }).click();
    await dialog.getByText('Could not save. Try again.').waitFor();
    assert.equal(await dialog.locator('#fb-body').inputValue(), 'Good pace, but the lead was buried.');
    await page.evaluate(() => { mock.saveError = false; });
    await dialog.getByRole('button', { name: 'Post feedback' }).click();
    await dialog.waitFor({ state: 'detached' });
    await review.getByText('Good pace, but the lead was buried.').waitFor();

    // Story feedback quotes the words selected in that story's script.
    await page.evaluate(() => {
      const pre = document.querySelector('[data-script="story-a"]'), text = pre.firstChild, start = text.data.indexOf('The council say');
      const range = document.createRange(); range.setStart(text, start); range.setEnd(text, start + 'The council say'.length);
      getSelection().removeAllRanges(); getSelection().addRange(range);
    });
    await review.locator('[data-story="story-a"]').getByRole('button', { name: 'Add feedback' }).click();
    assert.equal(await dialog.locator('#fb-quote').inputValue(), 'The council say');
    await dialog.locator('#fb-body').fill('Who at the council? Attribute it.');
    await dialog.getByRole('button', { name: 'Post feedback' }).click();
    await dialog.waitFor({ state: 'detached' });
    const storyA = review.locator('[data-story="story-a"]');
    await storyA.locator('blockquote', { hasText: 'The council say' }).waitFor();
    let save = (await page.evaluate(() => mock.calls)).filter(c => c.name === 'tutor_save_feedback').at(-1).args;
    assert.deepEqual(save, { p_feedback_id: null, p_newsroom_id: 'room-a', p_story_id: 'story-a', p_quote: 'The council say', p_body: 'Who at the council? Attribute it.' });

    // A selection in a different story is not quoted.
    await review.locator('[data-story="story-b"]').getByRole('button', { name: 'Add feedback' }).click();
    assert.equal(await dialog.locator('#fb-quote').inputValue(), '');
    await dialog.locator('#fb-body').fill('<b>Needs a script</b>');
    await dialog.getByRole('button', { name: 'Post feedback' }).click();
    await dialog.waitFor({ state: 'detached' });
    await review.locator('[data-story="story-b"] .fb .text', { hasText: '<b>Needs a script</b>' }).waitFor();

    // Edit and delete.
    await storyA.getByRole('button', { name: 'Edit' }).click();
    assert.equal(await dialog.locator('#fb-body').inputValue(), 'Who at the council? Attribute it.');
    await dialog.locator('#fb-body').fill('Attribute the council line.');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await dialog.waitFor({ state: 'detached' });
    await storyA.getByText('Attribute the council line.').waitFor();
    save = (await page.evaluate(() => mock.calls)).filter(c => c.name === 'tutor_save_feedback').at(-1).args;
    assert.equal(save.p_feedback_id, 'fb-2');
    page.once('dialog', d => d.accept());
    await review.locator('[data-story="story-b"]').getByRole('button', { name: 'Delete' }).click();
    await review.locator('[data-story="story-b"] .fb').waitFor({ state: 'detached' });
    assert.match(await review.locator('[data-review-bar]').textContent(), /2 comments/);
    await page.screenshot({ path: '/private/tmp/moira-tutor-review.png' });

    // Escape closes the review; the report carries the feedback.
    await page.keyboard.press('Escape');
    await review.waitFor({ state: 'detached' });
    await page.getByRole('checkbox', { name: 'Select Newsroom A', exact: true }).check();
    await page.getByRole('button', { name: 'Generate report', exact: true }).click();
    await page.getByText('2 EP comments').waitFor();
    const report = await page.evaluate(async () => await (await fetch(document.querySelector('dialog a[download]').href)).text());
    assert.ok(report.indexOf('EP feedback') > report.indexOf('Running order'));
    assert.ok(report.includes('The bulletin as a whole') && report.includes('<blockquote>The council say</blockquote>') && report.includes('Attribute the council line.'));
    assert.deepEqual(errors, []);
    console.log('PASS: review screen escapes content, overall and story feedback, quoting the selected script, failed-save draft kept, edit, delete, Escape, and feedback in the report');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
