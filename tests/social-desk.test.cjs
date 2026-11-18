// Social newsroom desk: the social running order replaces the TV one, adds
// above the outro, reorders and deletes; the story editor plans sections,
// keeps its draft through redraws, asks for each shot's source and credit,
// and saves the sections, shots and a script the prompters can read.
// Uses an external Playwright installation; all network calls are blocked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.MOIRA_PLAYWRIGHT_MODULE || 'playwright');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const hook = `
      state.currentBulletinId = 'bulletin-local';
      seedLocalData(); bindGlobalEvents(); render();
      window.testDesk = { state, render, productionSheetHTML, composeSocialScript, calls: [], confirms: [],
        social(kind = 'social') {
          state.localMode = false; supabaseUser = { id: 'me' }; state.myName = 'Sam';
          state.meta.kind = kind; state.meta.formats = ['OOV/CLIP', 'ONCAM']; state.meta.conferenceId = 'c1';
          const story = (slug, format, extra = {}) => ({ ...blankStory({ slug, format, duration: 5 }), ...extra });
          state.storiesMap = {
            intro: story('INTRO', 'ONCAM', { sections: [{ title: 'Welcome', says: 'Your news in a minute.', treatment: 'presenter', onscreen: '', clip: '' }] }),
            rail: story('RAIL', 'OOV/CLIP', { brief: 'Weekend engineering works', script: 'Rail passengers face disruption.' }),
            outro: story('OUTRO', 'ONCAM', { sections: [{ title: 'Sign-off', says: 'Follow for more.', treatment: 'presenter', onscreen: '', clip: '' }] }),
          };
          state.meta.order = ['intro', 'rail', 'outro', 'marker-line'];
          const rec = (name, ret) => async (...args) => { testDesk.calls.push({ name, args }); return ret; };
          DB = { ...DB_NULL, saveStory: rec('saveStory', 'ok'), createStory: rec('createStory'), moveStory: rec('moveStory', null),
            deleteStory: rec('deleteStory'), setStoryStatus: rec('setStoryStatus'), lockStory: rec('lockStory'), unlockStory: rec('unlockStory') };
          refreshPitches = async () => {};
          state.ui.view = 'rundown'; render();
        },
      };
      confirmAction = async (msg) => { testDesk.confirms.push(msg); return true; };
    `;
    const html = source.replace(/<script\b[^>]*\bsrc="[^"]*"[^>]*>\s*<\/script>/g, '')
      .replace(/import \{ createClient \} from "[^"]+";/, 'const createClient = () => { throw Error("No live backend in tests"); };')
      .replace('        boot();', hook);
    await page.route('**/*', route => route.request().url() === 'http://localhost:4173/'
      ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://localhost:4173/');
    await page.waitForFunction(() => !!window.testDesk);
    const calls = (name) => page.evaluate(n => testDesk.calls.filter(c => c.name === n).map(c => c.args), name);
    // The desk redraws on the next animation frame.
    const frame = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const slugs = async () => { await frame(); return page.$$eval('[data-testid="social-rundown"] .social-card', els => els.map(e => e.dataset.storyId)); };

    // A TV newsroom keeps its table and Cuez; a social one gets the social running order.
    await page.evaluate(() => testDesk.social('tv'));
    await page.getByText('Rundown').first().waitFor();
    assert.equal(await page.locator('[data-testid="social-rundown"]').count(), 0);
    await page.evaluate(() => testDesk.social());
    await page.locator('[data-testid="social-rundown"]').waitFor();
    assert.equal(await page.locator('text=Send').count(), 0, 'no Cuez send in a social newsroom');
    assert.equal(await page.locator('[data-action="print-scripts"], [data-action="add-segment"]').count(), 0);
    assert.match(await page.locator('[data-action="show-view"][data-val="rundown"]').innerText(), /Running order\s*SOCIAL/);
    assert.deepEqual(await slugs(), ['intro', 'rail', 'outro']);
    assert.match(await page.locator('#social-runtime').innerText(), /≈ 00:15/);
    assert.match(await page.locator('.social-card[data-story-id="rail"]').innerText(), /Media needed/, 'a story with footage and no source needs media');
    console.log('PASS: social newsrooms get the social running order (no Cuez, no segments); TV newsrooms keep theirs');

    // Add goes above the outro; delete removes it.
    await page.locator('[data-action="add-story"]').click();
    await page.waitForFunction(() => testDesk.calls.some(c => c.name === 'createStory'));
    const [[newId, newStory]] = await calls('createStory');
    assert.deepEqual(await slugs(), ['intro', 'rail', newId, 'outro']);
    assert.equal(newStory.format, 'OOV/CLIP');
    assert.equal(newStory.sections.length, 1);
    await page.locator(`.social-card[data-story-id="${newId}"] [data-action="delete-story"]`).click();
    await page.waitForFunction(() => testDesk.calls.some(c => c.name === 'deleteStory'));
    await page.locator(`.social-card[data-story-id="${newId}"]`).waitFor({ state: 'detached' });
    assert.deepEqual(await slugs(), ['intro', 'rail', 'outro']);
    console.log('PASS: Add story goes above the outro; delete takes it out');

    // Reorder: arrows, and dropping on the end zone keeps it above END OF PROGRAMME.
    await page.locator('.social-card[data-story-id="rail"] [data-action="move-story-up"]').click();
    assert.deepEqual(await slugs(), ['rail', 'intro', 'outro']);
    assert.equal(await page.locator('.social-card[data-story-id="outro"] [data-action="move-story-down"]').isDisabled(), true);
    await page.locator('.social-card[data-story-id="rail"]').dragTo(page.locator('[data-story-id="marker-line"]'));
    await page.waitForFunction(() => testDesk.calls.filter(c => c.name === 'moveStory').length === 2);
    assert.deepEqual((await calls('moveStory'))[1], ['rail', 'marker-line']);
    assert.deepEqual(await page.evaluate(() => testDesk.state.meta.order), ['intro', 'outro', 'rail', 'marker-line']);
    console.log('PASS: reordering by arrows and drag; the end zone keeps stories in the bulletin');

    // Three columns, no dialog: selecting a story shows it, read only, beside the running order.
    await page.locator('.social-card[data-story-id="rail"] [data-action="sd-select"]').click();
    await frame();
    const editor = page.getByTestId('social-editor');
    assert.equal(await page.locator('#modal-container > *').count(), 0, 'no dialog');
    assert.equal(await page.locator('.social-card[data-story-id="rail"] [data-action="sd-select"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await editor.locator('textarea[data-sd="says"]').inputValue(), 'Rail passengers face disruption.');
    assert.equal(await editor.locator('textarea[data-sd="says"]').getAttribute('readonly'), '');
    assert.equal(await page.evaluate(() => testDesk.calls.filter(c => c.name === 'lockStory').length), 0, 'looking takes no lock');
    // Clicking into a field starts editing: the story is locked and the field stays focused.
    await editor.locator('textarea[data-sd="says"]').click();
    await page.waitForFunction(() => testDesk.state.ui.editingStoryId === 'rail');
    await frame(); await frame();
    assert.deepEqual((await calls('lockStory')).map(a => a[0]), ['rail']);
    assert.equal(await editor.locator('textarea[data-sd="says"]').getAttribute('readonly'), null);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.sd), 'says');
    // The editor: a picked story starts with one section from its script.
    assert.match(await editor.innerText(), /Brief: Weekend engineering works/);
    assert.match(await editor.locator('label', { hasText: 'Voiceover' }).first().innerText(), /Voiceover/);
    // Typing updates timings and the picture plan in place.
    const words = 'Rail passengers face more disruption this weekend as engineering works close lines across the north. Operators are urging people to check before they travel, and buses will replace trains on Sunday.';
    await editor.locator('textarea[data-sd="says"]').fill(words);
    await editor.locator('input[data-sd="onscreen"]').fill('Check before you travel');
    await editor.locator('input[data-sd="clip"]').fill('0:06');
    await frame();
    assert.match(await page.locator('#sd-est').innerText(), /31 words · on brief/);
    assert.match(await page.locator('#sd-plan .sp-caption').innerText(), /Check before you travel/);
    assert.equal(await page.locator('#sd-plan .sp-credit').innerText(), 'PA', 'PA is the default credit');
    // Adding a section redraws the editor: the typed words survive.
    await editor.locator('[data-action="sd-add-sec"]').click();
    await frame();
    assert.equal(await editor.locator('textarea[data-sd="says"]').count(), 2);
    assert.equal(await editor.locator('textarea[data-sd="says"]').first().inputValue(), words);
    await editor.locator('textarea[data-sd="says"]').nth(1).fill('Full details on our page.');
    // Dual footage asks for both shots, each with its own source and credit.
    await editor.locator('select[data-sd="treatment"]').nth(1).selectOption('dual');
    await page.locator('#sd-plan .sp-footage2').waitFor();
    await editor.locator('[data-action="sd-tab"][data-val="media"][aria-pressed]').click();
    await frame();
    assert.equal(await editor.locator('[data-action="sd-source"][data-id="b"][aria-pressed="true"]').innerText(), 'Our own');
    await editor.locator('input[data-sd="link"][data-shot="a"]').fill('https://explore.pressassociation.com/create/videos/rail');
    await editor.locator('input[data-sd="credit"][data-shot="a"]').fill('Network Rail');
    await editor.locator('input[data-sd="newsroomReady"][data-shot="a"]').check();
    await frame();
    assert.match(await page.locator('#sd-media-foot').innerText(), /shot 1 embargo check, shot 2 footage link/);
    await editor.locator('input[data-sd="embargoClear"][data-shot="a"]').check();
    await editor.locator('input[data-sd="link"][data-shot="b"]').fill('https://onedrive.example/station.mp4');
    await frame();
    assert.match(await page.locator('#sd-media-foot').innerText(), /Media ready/);
    await editor.locator('[data-action="sd-tab"][data-val="review"]').click();
    await frame();
    assert.match(await page.locator('#sd-script').innerText(), /^\[FULL FOOTAGE · VO\]\n\[STRAP: Check before you travel\]\nRail passengers/);
    console.log('PASS: the editor plans sections, keeps typing through redraws, and checks both shots\' sources and credits');

    // Save sends the sections, shots, a readable script and the estimated duration.
    await editor.locator('[data-action="sd-save"]').click();
    await page.waitForFunction(() => testDesk.calls.some(c => c.name === 'saveStory'));
    const [[savedId, saved]] = await calls('saveStory');
    assert.equal(savedId, 'rail');
    assert.equal(saved.sections.length, 2);
    assert.deepEqual(saved.sections.map(x => x.treatment), ['footage', 'dual']);
    assert.equal(saved.shots.a.credit, 'Network Rail');
    assert.equal(saved.shots.b.source, 'own');
    assert.equal(saved.script, await page.evaluate(s => testDesk.composeSocialScript(s), saved.sections));
    assert.match(saved.script, /\[CLIP:0:06 Story\]/);
    assert.equal(saved.duration, 10 + 6 + 2);
    await frame();
    assert.match(await page.locator('.social-card[data-story-id="rail"]').innerText(), /Media ready/);
    assert.equal(await editor.locator('[data-action="sd-edit"]').count(), 1, 'back to read only after saving');
    assert.match(await page.locator('#sd-script').innerText(), /Rail passengers face more/, 'shows what was saved');
    await editor.locator('[data-action="sd-tab"][data-val="words"]').click();
    await frame();
    console.log('PASS: saving stores sections, shots, the composed script and the estimate');

    // Leaving a story with unsaved changes asks first, then lets it go.
    await editor.locator('[data-action="sd-edit"]').click();
    await page.waitForFunction(() => testDesk.state.ui.editingStoryId === 'rail');
    await frame(); await frame();
    await editor.locator('input[data-sd="onscreen"]').first().fill('Changed my mind');
    await page.locator('.social-card[data-story-id="outro"] [data-action="sd-select"]').click();
    await page.waitForFunction(() => testDesk.state.ui.socialSelected === 'outro');
    assert.equal((await page.evaluate(() => testDesk.confirms)).filter(m => /haven't saved/.test(m)).length, 1);
    assert.equal(await page.evaluate(() => testDesk.state.ui.editingStoryId), null);
    assert.ok((await calls('unlockStory')).some(a => a[0] === 'rail'));
    assert.equal(await page.evaluate(() => testDesk.state.storiesMap.rail.sections[0].onscreen), 'Check before you travel', 'unsaved change not kept');
    console.log('PASS: three columns, no dialog; clicking a field starts editing; leaving unsaved changes asks first');

    // Someone else editing: read only, with their name; clicking a field offers the take-over.
    await page.evaluate(() => Object.assign(testDesk.state.storiesMap.intro, { lockedBySession: 'other/tab', lockedByName: 'Priya', lockedAt: Date.now() }));
    await page.locator('.social-card[data-story-id="intro"] [data-action="sd-select"]').click();
    await frame();
    assert.match(await editor.innerText(), /Priya/);
    assert.equal(await editor.locator('[data-action="sd-edit"], [data-action="sd-save"]').count(), 0);
    await editor.locator('textarea[data-sd="says"]').click();
    await frame(); await frame();
    assert.equal(await editor.locator('textarea[data-sd="says"]').getAttribute('readonly'), '', 'still read only');
    assert.equal(await editor.locator('#takeover-btn').count(), 1);
    await editor.locator('[data-action="cancel-edit"]').click();
    await frame();

    // The production sheet lists the shots and flags a missing credit.
    await page.evaluate(() => Object.assign(testDesk.state.storiesMap.outro, { sections: [{ title: 'Sign-off', says: 'Bye.', treatment: 'graphic', onscreen: '', clip: '' }],
      shots: { a: { source: 'pa', link: 'https://explore.pressassociation.com/x', credit: '', newsroomReady: true, embargoClear: true } } }));
    const sheet = await page.evaluate(() => testDesk.productionSheetHTML());
    assert.match(sheet, /Network Rail/);
    assert.match(sheet, /onedrive\.example\/station\.mp4/);
    assert.match(sheet, /<span class="miss">MISSING<\/span>/);
    assert.doesNotMatch(sheet, /<script/i);
    console.log('PASS: read only while someone else edits; the production sheet shows sources and missing credits');

    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
