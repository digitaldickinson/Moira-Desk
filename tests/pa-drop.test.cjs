// PA wire drop on the conference's new-pitch box: fills the form (not the
// board), adds the PA marker and link only when + is pressed, shows them on the
// pitch card and story editor, and stops stray drops navigating the desk away.
// Uses an external Playwright installation; all network calls are blocked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.MOIRA_PLAYWRIGHT_MODULE || 'playwright');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// Fictional story in the shape PA Explore hands over (as in the pa_drop.html lab).
const PA_URL = 'https://explore.pa.media/story/commons-tourism-123';
const paHtml = (slug, headline) => `<a href="${PA_URL}"><create-event-brief layout="wide"><div class="event-brief"><app-ninjs-article-summary>`
  + '<div class="published"><span class="time">14:35</span><span class="date">16 Nov 2026</span><span class="words">286 words</span></div>'
  + `<p class="slug body-1"><app-ninjs-slug><span class="keywords">${slug}</span></app-ninjs-slug></p>`
  + (headline ? `<h3 class="article-headline">${headline}</h3>` : '')
  + '<p class="article-teaser">Councillors are considering proposed changes to library services following a public consultation.</p>'
  + '<img src="https://tracker.example/pixel.gif"></app-ninjs-article-summary></div></create-event-brief></a>';

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [], requests = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (r.url() !== 'http://localhost:4173/') requests.push(r.url()); });
    const hook = `
      state.currentBulletinId = 'bulletin-local';
      seedLocalData(); bindGlobalEvents(); render();
      window.testDesk = { state, render, parseWireTransfer, calls: [],
        setConference() {
          state.localMode = false; supabaseUser = { id: 'test-user' }; state.myName = 'Sam';
          state.meta.producerUser = 'producer-user'; state.meta.conferenceId = 'conference-a';  // a student, not the producer
          DB = { ...DB_NULL, pitchAction: async (name, args) => { testDesk.calls.push({ name, args }); return 'new-id'; } };
          refreshPitches = async () => {};
          state.ui.view = 'conference'; render('main');
        },
        transfer(data) { const dt = new DataTransfer(); for (const [k, v] of Object.entries(data)) dt.setData(k, v); return dt; },
        drop(selector, data) {
          const el = document.querySelector(selector), dt = testDesk.transfer(data);
          const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt });
          el.dispatchEvent(over);
          const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
          el.dispatchEvent(drop);
          return { overPrevented: over.defaultPrevented, dropPrevented: drop.defaultPrevented, effect: dt.dropEffect };
        },
        previewCalls: [], previewReply: null, previewGate: null,
        holdPreview(reply) { testDesk.previewReply = reply; testDesk.previewGate = new Promise(r => { testDesk.releasePreview = r; }); },
        paste(selector, data) {
          const el = document.querySelector(selector); el.focus();
          const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: testDesk.transfer(data) });
          el.dispatchEvent(ev);
          return ev.defaultPrevented;
        },
      };
      invokeLinkPreview = async (body) => {
        testDesk.previewCalls.push(body);
        await testDesk.previewGate;
        if (testDesk.previewReply === 'fail') throw new Error('offline');
        return testDesk.previewReply;
      };
    `;
    const html = source.replace(/<script\b[^>]*\bsrc="[^"]*"[^>]*>\s*<\/script>/g, '')
      .replace(/import \{ createClient \} from "[^"]+";/, 'const createClient = () => { throw Error("No live backend in tests"); };')
      .replace('        boot();', hook);
    await page.route('**/*', route => route.request().url() === 'http://localhost:4173/'
      ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://localhost:4173/');
    await page.waitForFunction(() => !!window.testDesk);

    // The story editor shows a picked story's PA link with the pitch brief (not in the script).
    const storyId = await page.evaluate(url => {
      const id = Object.keys(testDesk.state.storiesMap).find(k => testDesk.state.storiesMap[k].type !== 'segment');
      Object.assign(testDesk.state.storiesMap[id], { brief: 'Ministers outline proposals', pitchedBy: 'Sam', sourceUrl: url, script: '' });
      testDesk.state.myName = 'Sam'; testDesk.state.ui.editingStoryId = id; testDesk.render('modal');
      return id;
    }, PA_URL);
    const editorLink = page.locator('#modal-container a', { hasText: 'PA story' });
    await editorLink.waitFor();
    assert.equal(await editorLink.getAttribute('href'), PA_URL);
    assert.equal(await editorLink.getAttribute('rel'), 'noopener noreferrer');
    assert.equal(await editorLink.getAttribute('target'), '_blank');
    assert.equal(await page.evaluate(id => testDesk.state.storiesMap[id].script, storyId), '');
    await page.evaluate(() => { testDesk.state.ui.editingStoryId = null; testDesk.render('modal'); });
    console.log('PASS: story editor shows the PA link beside the pitch brief, outside the script');

    await page.evaluate(() => testDesk.setConference());
    await page.locator('#pitch-drop-hint').waitFor();

    // A PA drop fills the form only; the summary and tracking image never come across.
    const r = await page.evaluate(([html, url]) => testDesk.drop('#pitch-drop', { 'text/html': html, 'text/uri-list': url, 'text/plain': url }), [paHtml('COMMONS Tourism', 'Ministers outline proposals for visitor levy'), PA_URL]);
    assert.equal(r.overPrevented, true); assert.equal(r.dropPrevented, true);
    assert.equal(await page.inputValue('#pitch-new-slug'), 'COMMONS Tourism');
    assert.equal(await page.inputValue('#pitch-new-angle'), 'Ministers outline proposals for visitor levy');
    assert.equal(await page.inputValue('#pitch-new-by'), 'Sam');
    const draft = page.getByTestId('wire-draft');
    await draft.locator('.src-badge').waitFor();
    assert.equal(await draft.locator('a').getAttribute('href'), PA_URL);
    assert.equal(await page.evaluate(() => testDesk.calls.length), 0, 'nothing pitched until + is pressed');
    assert.equal(await page.locator('[data-pitch-id]').count(), 0);
    assert.equal(await page.locator('body').innerText().then(t => t.includes('public consultation')), false);

    // The draft survives a live redraw, then + adds it with the PA marker and link.
    await page.evaluate(() => testDesk.render('main'));
    assert.equal(await page.inputValue('#pitch-new-slug'), 'COMMONS Tourism');
    await page.getByTestId('wire-draft').waitFor();
    await page.locator('[data-action="add-pitch"]').click();
    await page.waitForFunction(() => testDesk.calls.length === 1);
    assert.deepEqual(await page.evaluate(() => testDesk.calls[0]), { name: 'add_pitch', args: {
      p_bulletin_id: 'bulletin-local', p_slug: 'COMMONS Tourism', p_angle: 'Ministers outline proposals for visitor levy',
      p_format: '', p_pitched_by: 'Sam', p_source: 'pa', p_source_url: PA_URL } });
    await page.locator('#pitch-drop-hint').waitFor();
    assert.equal(await page.inputValue('#pitch-new-slug'), '');
    console.log('PASS: PA drop fills slug, angle and link for checking; + adds it as a PA pitch; summary not kept');

    // A typed pitch is unchanged: no source arguments.
    await page.fill('#pitch-new-slug', 'Council'); await page.fill('#pitch-new-angle', 'Local angle');
    await page.locator('[data-action="add-pitch"]').click();
    await page.waitForFunction(() => testDesk.calls.length === 2);
    assert.deepEqual(Object.keys(await page.evaluate(() => testDesk.calls[1].args)).sort(), ['p_angle', 'p_bulletin_id', 'p_format', 'p_pitched_by', 'p_slug']);

    // Removing the link before adding sends a plain pitch.
    await page.evaluate(([html, url]) => testDesk.drop('#pitch-new-angle', { 'text/html': html, 'text/uri-list': url }), [paHtml('LOCAL Libraries', 'Council examines changes to library services'), PA_URL]);
    assert.equal(await page.inputValue('#pitch-new-slug'), 'LOCAL Libraries', 'dropping onto a field inside the box works too');
    await page.locator('[data-action="clear-wire-draft"]').click();
    await page.locator('#pitch-drop-hint').waitFor();
    assert.equal(await page.inputValue('#pitch-new-angle'), 'Council examines changes to library services');
    await page.locator('[data-action="add-pitch"]').click();
    await page.waitForFunction(() => testDesk.calls.length === 3);
    assert.equal(await page.evaluate(() => 'p_source' in testDesk.calls[2].args), false);
    console.log('PASS: typed pitches and removed links send no source');

    // An ordinary (non-PA) link: headline and link, but no PA marker.
    await page.evaluate(() => testDesk.drop('#pitch-drop', { 'text/html': '<a href="https://news.example.org/story">Rail operator announces changes to evening services</a>', 'text/uri-list': 'https://news.example.org/story' }));
    assert.equal(await page.inputValue('#pitch-new-slug'), '');
    assert.equal(await page.inputValue('#pitch-new-angle'), 'Rail operator announces changes to evening services');
    assert.equal(await page.getByTestId('wire-draft').locator('.src-badge').count(), 0);
    assert.equal(await page.getByTestId('wire-draft').locator('a').innerText().then(t => t.trim()), 'Source');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'pitch-new-slug', 'missing slug gets focus');
    await page.fill('#pitch-new-slug', 'Rail');
    await page.locator('[data-action="add-pitch"]').click();
    await page.waitForFunction(() => testDesk.calls.length === 4);
    assert.deepEqual(await page.evaluate(() => [testDesk.calls[3].args.p_source, testDesk.calls[3].args.p_source_url]), [null, 'https://news.example.org/story']);

    // PA markup without a separable headline: no guessing from the run-together text.
    const glued = await page.evaluate(([url]) => testDesk.parseWireTransfer(testDesk.transfer({
      'text/html': `<a href="${url}"><app-ninjs-article-summary><div>21:4616 Nov 2026272 wordsShowbizCelebrity</div><p class="slug"><app-ninjs-slug><span class="keywords">SHOWBIZ</span> <span class="keywords">Awards</span></app-ninjs-slug></p></app-ninjs-article-summary></a>`,
      'text/plain': '21:4616 Nov 2026272 wordsShowbizCelebrity' })), [PA_URL]);
    assert.deepEqual(glued, { url: PA_URL, slug: 'SHOWBIZ Awards', headline: '', source: 'pa', paMarkup: true, linkOnly: false });
    // Real PA Explore event-card shape (fictional text): no headline element, so the
    // one-line summary becomes the angle; the slug leaves out the "Latest" label.
    const card = await page.evaluate(([url]) => testDesk.parseWireTransfer(testDesk.transfer({
      'text/html': `<meta http-equiv="Content-Type" content="text/html;charset=UTF-8"><a _ngcontent-x="" href="${url}" target="_self"><create-event-brief layout="wide"><div class="event-brief"><app-ninjs-article-summary showslug="true" class="layout-wide"><div class="article-metadata"><div class="datetime"><app-ninjs-article-timestamp><!----><time datetime="2026-11-17T08:03:24Z"><span class="time">08:03</span><span class="date">17 Nov 2026</span></time></app-ninjs-article-timestamp><app-ninjs-article-wordcount label="words"><span class="word-count">183 words</span></app-ninjs-article-wordcount></div></div><div class="row-control"><div class="container" data-uri="abc"><p class="slug body-1"><app-ninjs-slug><span class="topic">Politics</span><span class="keywords">Levy</span></app-ninjs-slug><!----><app-ninjs-article-summary-label><span class="article-label latest">Latest</span></app-ninjs-article-summary-label></p><app-embargo-notice><!----></app-embargo-notice><section class="description body-1">A council leader has said plans for a visitor levy were “long overdue”. She said the money would go to parks. </section></div></div></app-ninjs-article-summary></div></create-event-brief></a>`,
      'text/uri-list': url, 'text/plain': url })), [PA_URL]);
    assert.deepEqual(card, { url: PA_URL, slug: 'Politics Levy', headline: 'A council leader has said plans for a visitor levy were “long overdue”.', source: 'pa', paMarkup: true, linkOnly: false });
    const long = await page.evaluate(([url]) => testDesk.parseWireTransfer(testDesk.transfer({
      'text/html': `<a href="${url}"><app-ninjs-article-summary><section class="description">${'word '.repeat(80)}end</section></app-ninjs-article-summary></a>` })), [PA_URL]);
    assert.ok(long.headline.length <= 221 && long.headline.endsWith('word…'), long.headline);
    // Unsafe links are never kept.
    const unsafe = await page.evaluate(() => testDesk.parseWireTransfer(testDesk.transfer({ 'text/uri-list': 'javascript:alert(1)', 'text/html': '<a href="javascript:alert(1)">Click this suspicious headline right now please</a>' })));
    assert.equal(unsafe.url, '');
    console.log('PASS: PA event cards give slug and summary line; non-PA links get no marker; run-together text and unsafe links are not used');

    // Paste: a PA link attaches without touching typed text; ordinary text pastes normally.
    await page.fill('#pitch-new-slug', 'MY SLUG'); await page.fill('#pitch-new-angle', 'My angle');
    assert.equal(await page.evaluate(url => testDesk.paste('#pitch-new-slug', { 'text/plain': url }), PA_URL), true);
    assert.equal(await page.inputValue('#pitch-new-slug'), 'MY SLUG');
    assert.equal(await page.inputValue('#pitch-new-angle'), 'My angle');
    await page.getByTestId('wire-draft').locator('.src-badge').waitFor();
    assert.equal(await page.evaluate(() => testDesk.paste('#pitch-new-angle', { 'text/plain': 'just some words' })), false);
    assert.equal(await page.evaluate(() => testDesk.paste('#pitch-new-angle', { 'text/plain': 'https://news.example.org/x' })), false);
    await page.locator('[data-action="clear-wire-draft"]').click();
    console.log('PASS: pasting a PA link attaches it; other pastes behave normally');

    // BBC News / MEN: only the address is pasted, so the headline is looked up.
    const BBC_URL = 'https://www.bbc.co.uk/news/articles/c8752wyv155xo';
    const MEN_URL = 'https://www.manchestereveningnews.co.uk/news/greater-manchester-news/m56-traffic-live-drivers-face-34922134';
    const BBC_TITLE = 'Hundreds of properties hit by power cuts after cable incident';
    assert.equal((await page.evaluate(url => testDesk.parseWireTransfer(testDesk.transfer({ 'text/plain': url })), MEN_URL)).source, 'men');
    await page.fill('#pitch-new-slug', ''); await page.fill('#pitch-new-angle', '');
    await page.evaluate(title => testDesk.holdPreview({ ok: true, title, siteName: 'BBC News', site: 'bbc' }), BBC_TITLE);
    assert.equal(await page.evaluate(url => testDesk.paste('#pitch-new-angle', { 'text/plain': url }), BBC_URL), true);
    await page.getByTestId('wire-fetching').waitFor();
    await page.getByTestId('wire-draft').locator('.src-badge.bbc').waitFor();
    assert.equal(await page.getByTestId('wire-draft').locator('a').innerText().then(t => t.trim()), 'BBC story');
    assert.deepEqual(await page.evaluate(() => testDesk.previewCalls), [{ bulletinId: 'bulletin-local', url: BBC_URL }]);
    await page.evaluate(() => testDesk.releasePreview());
    await page.getByTestId('wire-fetching').waitFor({ state: 'detached' });
    assert.equal(await page.inputValue('#pitch-new-angle'), BBC_TITLE);
    assert.equal(await page.inputValue('#pitch-new-slug'), '');
    await page.fill('#pitch-new-slug', 'POWER CUTS');
    await page.locator('[data-action="add-pitch"]').click();
    await page.waitForFunction(() => testDesk.calls.at(-1).args.p_slug === 'POWER CUTS');
    assert.deepEqual(await page.evaluate(() => [testDesk.calls.at(-1).args.p_angle, testDesk.calls.at(-1).args.p_source, testDesk.calls.at(-1).args.p_source_url]), [BBC_TITLE, 'bbc', BBC_URL]);
    console.log('PASS: pasting a BBC link looks up its headline into the angle; + adds it as a BBC pitch');

    // An angle already typed: no lookup, nothing replaced.
    await page.fill('#pitch-new-angle', 'My own angle');
    assert.equal(await page.evaluate(url => testDesk.paste('#pitch-new-angle', { 'text/plain': url }), MEN_URL), true);
    await page.getByTestId('wire-draft').locator('.src-badge.men').waitFor();
    assert.equal(await page.getByTestId('wire-fetching').count(), 0);
    assert.equal(await page.evaluate(() => testDesk.previewCalls.length), 1);
    assert.equal(await page.inputValue('#pitch-new-angle'), 'My own angle');
    await page.locator('[data-action="clear-wire-draft"]').click();

    // Typed during the lookup: the student's words are kept.
    await page.fill('#pitch-new-angle', '');
    await page.evaluate(() => testDesk.holdPreview({ ok: true, title: 'M56 traffic LIVE', site: 'men' }));
    await page.evaluate(url => testDesk.paste('#pitch-new-slug', { 'text/plain': url }), MEN_URL);
    await page.getByTestId('wire-fetching').waitFor();
    await page.fill('#pitch-new-angle', 'Typed meanwhile');
    await page.evaluate(() => testDesk.releasePreview());
    await page.getByTestId('wire-fetching').waitFor({ state: 'detached' });
    assert.equal(await page.inputValue('#pitch-new-angle'), 'Typed meanwhile');
    await page.locator('[data-action="clear-wire-draft"]').click();

    // Link removed during the lookup: the late answer is ignored.
    await page.fill('#pitch-new-angle', '');
    await page.evaluate(() => testDesk.holdPreview({ ok: true, title: 'Too late', site: 'men' }));
    await page.evaluate(url => testDesk.paste('#pitch-new-slug', { 'text/plain': url }), MEN_URL);
    await page.getByTestId('wire-fetching').waitFor();
    await page.locator('[data-action="clear-wire-draft"]').click();
    await page.evaluate(() => testDesk.releasePreview());
    await page.waitForTimeout(50);
    assert.equal(await page.inputValue('#pitch-new-angle'), '');
    assert.equal(await page.getByTestId('wire-draft').count(), 0);

    // Lookup fails: the link stays attached and the student is asked to type the angle.
    await page.evaluate(() => testDesk.holdPreview('fail'));
    await page.evaluate(url => testDesk.paste('#pitch-new-slug', { 'text/plain': url }), BBC_URL);
    await page.evaluate(() => testDesk.releasePreview());
    await page.getByTestId('wire-fetching').waitFor({ state: 'detached' });
    await page.getByText('No headline found').waitFor();
    assert.equal(await page.inputValue('#pitch-new-angle'), '');
    assert.equal(await page.getByTestId('wire-draft').locator('a').getAttribute('href'), BBC_URL);
    await page.locator('[data-action="clear-wire-draft"]').click();
    console.log('PASS: typed angles are never replaced; late or failed lookups leave the form alone');

    // Pitch cards: PA badge and safe link; a bad stored link is not rendered.
    await page.evaluate(url => {
      const base = { status: 'pitched', conferenceId: 'conference-a', angle: 'Angle', pitchedBy: 'Sam', createdBy: 'test-user' };
      testDesk.state.pitchesMap = {
        'pa-1': { ...base, id: 'pa-1', slug: 'COMMONS Tourism', source: 'pa', sourceUrl: url, position: 0 },
        'bad-1': { ...base, id: 'bad-1', slug: 'Bad link', source: '', sourceUrl: 'javascript:alert(1)', position: 1 },
      };
      testDesk.render('main');
    }, PA_URL);
    const paCard = page.locator('[data-pitch-id="pa-1"]');
    await paCard.locator('.src-badge').waitFor();
    assert.equal(await paCard.locator('a').getAttribute('href'), PA_URL);
    assert.equal(await paCard.locator('a').getAttribute('rel'), 'noopener noreferrer');
    const badCard = page.locator('[data-pitch-id="bad-1"]');
    assert.equal(await badCard.locator('a').count(), 0);
    assert.equal(await badCard.locator('.src-badge').count(), 0);
    console.log('PASS: pitch cards show the PA badge and link; unsafe stored links are dropped');

    // Stray drops elsewhere can't navigate away; text fields still accept drops.
    const stray = await page.evaluate(url => testDesk.drop('h2', { 'text/uri-list': url }), PA_URL);
    assert.deepEqual(stray, { overPrevented: true, dropPrevented: true, effect: 'none' });
    await page.evaluate(() => { const t = document.createElement('textarea'); t.id = 'probe'; document.getElementById('main-container').append(t); });
    const intoField = await page.evaluate(url => testDesk.drop('#probe', { 'text/plain': url }), PA_URL);
    assert.equal(intoField.overPrevented, false); assert.equal(intoField.dropPrevented, false);
    console.log('PASS: stray drops are blocked, text fields outside the box keep normal drops');

    // Local mode / signed out: the box doesn't take drops.
    await page.evaluate(() => { testDesk.state.localMode = true; testDesk.state.ui.view = 'conference'; testDesk.render('main'); });
    await page.getByText('News conference needs a Supabase connection').waitFor();
    assert.equal(await page.locator('#pitch-drop').count(), 0);

    assert.deepEqual(requests.filter(u => u.includes('tracker.example')), [], 'images in dropped HTML are never loaded');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
