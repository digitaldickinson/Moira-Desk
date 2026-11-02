// Run with an external Playwright installation; the database is replaced by a test adapter.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.MOIRA_PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  try {
    const hook = `
      bindGlobalEvents();
      state.currentBulletinId = 'room-a'; state.localMode = false; supabaseUser = { id: 'student' };
      state.rooms = [{ id: 'room-a', name: 'Room A' }]; state.myName = 'Ana';
      const story = (id, slug, extra = {}) => ({ bulletinId: 'room-a', slug, script: 'The council say the bridge shuts.', format: 'PKG', presenter: '', reporter: '',
        duration: 60, completed: null, isFloated: false, type: null, lockedBySession: null, lockedByName: null, lockedAt: null, rev: 1, ...extra });
      const row = (id, story_id, body, extra = {}) => ({ id, conference_id: 'conf-1', story_id, story_slug: null, quote: null, body, created_at: '2026-11-02T10:00:0' + id.slice(-1) + 'Z', ...extra });
      let cb = {};
      DB = { ...DB_NULL,
        loadFeedback: async (room, conf) => conf === 'conf-1' ? [row('fb-1', null, 'Good pace overall.'), row('fb-2', 's1', '<img src=x onerror=alert(1)>Attribute it.', { quote: 'The council say' })].map(feedbackFromRow) : [],
        subscribe: (b, s, p, f) => { cb = { b, s, p, f }; return () => {}; } };
      setupListeners();
      state.storiesMap = { s1: story('s1', 'Bridge'), s2: story('s2', 'Weather') };
      cb.b(bulletinFromRow({ order_ids: ['s1', 's2', 'marker-line'] }));
      showView('rundown');
      window.deskTest = {
        conference(id) { cb.b(bulletinFromRow({ order_ids: ['s1', 's2', 'marker-line'], conference_id: id })); },
        feedback(changes) { cb.f(changes.map(c => c.type === 'removed' ? c : { type: 'modified', id: c.id, data: feedbackFromRow(c) })); },
        row, edit(id) { state.ui.editingStoryId = id; render('modal'); },
        closeEditor() { state.ui.editingStoryId = null; render(); }, view(v) { showView(v); },
      };
    `;
    const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')
      .replace(/<script\b[^>]*\bsrc="[^"]*"[^>]*>\s*<\/script>/g, '')
      .replace(/import \{ createClient \} from "[^"]+";/, 'const createClient = () => { throw Error("No live backend in tests"); };')
      .replace('        boot();', hook);
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport });
      page.on('pageerror', e => { errors.push(e.message); console.error('Browser error:', e.message); });
      await page.route('**/*', route => route.request().url() === 'http://localhost:4173/' ? route.fulfill({ contentType: 'text/html', body: source }) : route.abort());
      await page.goto('http://localhost:4173/');
      await page.waitForFunction(() => !!window.deskTest);
      const tab = page.locator('[data-action="show-view"][data-val="feedback"]');
      await page.waitForTimeout(100);
      assert.equal(await tab.count(), 0, 'no tab before any feedback');

      // Feedback loads with the conference; the tab and story markers appear.
      await page.evaluate(() => deskTest.conference('conf-1'));
      await tab.waitFor();
      assert.match(await tab.textContent(), /EP feedback\s*2/);
      const marker = page.locator('[data-action="show-feedback"][data-id="s1"]').first(); // Tailwind is not loaded in tests, so desktop and mobile layouts both render
      await marker.waitFor();
      assert.equal(await page.locator('[data-action="show-feedback"][data-id="s2"]').count(), 0);

      // The marker opens the feedback view: overall first, then the story, escaped.
      await marker.click();
      const view = page.locator('[data-feedback-story="s1"]');
      await view.waitFor();
      assert.equal(await page.locator('main img, #main-container img').count(), 0);
      assert.ok((await view.textContent()).includes('<img src=x onerror=alert(1)>Attribute it.'));
      assert.equal(await view.locator('blockquote').textContent(), 'The council say');
      const order = await page.locator('#main-container section h3').allTextContents();
      assert.deepEqual(order, ['The bulletin as a whole', 'Bridge']);

      // Live changes: other conferences are ignored, deletes and additions apply, removed stories keep their slug.
      await page.evaluate(() => deskTest.feedback([deskTest.row('fb-9', 's2', 'Old session', { conference_id: 'conf-0' })]));
      await page.evaluate(() => deskTest.feedback([{ type: 'removed', id: 'fb-1' }, deskTest.row('fb-3', 'gone', 'Good idea, shame it was dropped.', { story_slug: 'Dropped story' })]));
      await page.locator('[data-feedback-story="gone"]', { hasText: 'Removed from the running order' }).waitFor();
      assert.deepEqual(await page.locator('#main-container section h3').allTextContents(), ['Bridge', 'Dropped story']);
      assert.match(await tab.textContent(), /EP feedback\s*2/);

      // The story editor shows that story's feedback above the script.
      await page.evaluate(() => deskTest.edit('s1'));
      const panel = page.locator('[data-editor-feedback]');
      await panel.waitFor();
      assert.ok((await panel.textContent()).includes('Attribute it.'));
      if (viewport.width === 1280) await page.screenshot({ path: '/private/tmp/moira-desk-feedback-editor.png' });
      await page.evaluate(() => deskTest.closeEditor());

      // A new conference clears it, and the tab stays only while it is open.
      await page.evaluate(() => deskTest.conference('conf-2'));
      await page.getByText('No EP feedback yet.').waitFor();
      await page.evaluate(() => deskTest.view('rundown'));
      await tab.waitFor({ state: 'detached' });
      await page.close();
    }
    assert.deepEqual(errors, []);
    console.log('PASS: desk feedback loads per conference, tab and story markers, read-only escaped view in running-order order, live add/remove, removed stories, editor panel, desktop and mobile');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
