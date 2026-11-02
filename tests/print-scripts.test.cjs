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
      state.rooms = [{ id: 'room-a', name: 'Room A' }]; state.roomDisplayName = 'Room <A>';
      const story = (slug, extra = {}) => ({ bulletinId: 'room-a', slug, script: '', format: 'PKG', presenter: '', reporter: '', duration: 30,
        completed: null, isFloated: false, type: null, lockedBySession: null, lockedByName: null, lockedAt: null, rev: 1, ...extra });
      let cb = {};
      DB = { ...DB_NULL, subscribe: (b, s, p, f) => { cb = { b, s, p, f }; return () => {}; } };
      setupListeners();
      state.storiesMap = {
        seg: story('Headlines', { type: 'segment', duration: 20 }),
        s1: story('Bridge', { script: 'LINK: The bridge shuts tonight.\\n[CLIP:0:20 Council]', reporter: 'Ana', presenter: 'Joe', duration: 95 }),
        s2: story('<img src=x onerror=alert(1)>Float', { isFloated: true, script: 'Floated script' }),
        s3: story('Weather', { format: 'OOV' }),
        s4: story('Spare', { script: 'Below the line script' }),
      };
      cb.b(bulletinFromRow({ order_ids: ['seg', 's1', 's2', 's3', 'marker-line', 's4'], conference_id: 'conf-1' }));
      showView('rundown');
      window.printTest = { html: () => scriptsPrintHTML() };
    `;
    const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')
      .replace(/<script\b[^>]*\bsrc="[^"]*"[^>]*>\s*<\/script>/g, '')
      .replace(/import \{ createClient \} from "[^"]+";/, 'const createClient = () => { throw Error("No live backend in tests"); };')
      .replace('        boot();', hook);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', e => { errors.push(e.message); console.error('Browser error:', e.message); });
    // Every frame, including the hidden print frame, records print() instead of opening a dialog.
    await page.addInitScript(() => { window.print = () => { window.top.printed = (window.top.printed || 0) + 1; window.top.printedText = document.body.innerText; }; });
    await page.route('**/*', route => route.request().url() === 'http://localhost:4173/' ? route.fulfill({ contentType: 'text/html', body: source }) : route.abort());
    await page.goto('http://localhost:4173/');
    await page.waitForFunction(() => !!window.printTest);

    const html = await page.evaluate(() => printTest.html());
    assert.ok(html.includes('<title>Room &lt;A&gt;: scripts</title>'), 'newsroom name escaped');
    assert.ok(html.includes('LINK: The bridge shuts tonight.\n[CLIP:0:20 Council]'), 'script kept as written');
    assert.ok(html.includes('PKG · 01:35 · Ana · presenter Joe'));
    assert.ok(html.includes('HEADLINES') || html.includes('Headlines · 00:20'));
    assert.ok(!html.includes('Floated script') && !html.includes('<img'), 'floated stories left out');
    assert.ok(!html.includes('Below the line script'), 'stories below End of programme left out');
    assert.ok(html.indexOf('Bridge') < html.indexOf('Weather'), 'running order kept');
    assert.ok(html.includes('No script.'), 'stories without a script still listed');
    assert.ok(html.includes('2 stories · TRT 02:25'));

    await page.getByRole('button', { name: 'Print scripts' }).click();
    await page.waitForFunction(() => window.printed === 1);
    assert.match(await page.evaluate(() => window.printedText), /Room <A>: scripts[\s\S]*1\s*Bridge[\s\S]*2\s*Weather/);
    await page.getByRole('button', { name: 'Print scripts' }).click();
    await page.waitForFunction(() => window.printed === 2);
    assert.equal(await page.locator('iframe#print-frame').count(), 1, 'only one print frame at a time');
    assert.deepEqual(errors, []);
    console.log('PASS: printable scripts above End of programme in running order, floated and below-the-line left out, escaped, printed from a single hidden frame');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
