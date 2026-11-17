// desk-shared.js: both desks load it, and admin.html's pinned copy is current.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const shared = fs.readFileSync(path.join(root, 'desk-shared.js'));
const script = (html) => html.slice(html.indexOf('<script>\n') + 9, html.indexOf('</script>', html.indexOf('<script>\n')));

test('tutor.html loads desk-shared.js from its own site', () => {
  assert.match(fs.readFileSync(path.join(root, 'tutor.html'), 'utf8'), /<script src="desk-shared\.js"><\/script>/);
});

test('admin.html pins the current desk-shared.js by version and hash', { skip: !fs.existsSync(path.join(root, 'admin.html')) }, () => {
  const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
  const tag = html.match(/<script src="https:\/\/digitaldickinson\.github\.io\/Moira-Desk\/desk-shared\.js\?v=([0-9a-f]+)"\s+integrity="([^"]+)"\s+crossorigin="anonymous"><\/script>/);
  assert.ok(tag, 'admin.html loads desk-shared.js from GitHub Pages with an integrity hash');
  const sha384 = crypto.createHash('sha384').update(shared);
  const digest = sha384.digest();
  assert.equal(tag[2], `sha384-${digest.toString('base64')}`, 'integrity hash matches desk-shared.js: run the README command and update admin.html');
  assert.equal(tag[1], digest.toString('hex').slice(0, 12), '?v= matches the hash, so a cached old copy is never used');
});

test('neither page declares a name that desk-shared.js already declares', () => {
  for (const file of ['tutor.html', 'admin.html']) {
    if (!fs.existsSync(path.join(root, file))) continue;
    assert.doesNotThrow(() => new vm.Script(`${shared}\n${script(fs.readFileSync(path.join(root, file), 'utf8'))}`), `${file} redeclares a shared name`);
  }
});

test('desk-shared.js can be inlined for tests', () => {
  assert.ok(!/<\/script/i.test(shared.toString()));
});

test('EP wall and report mark PA, BBC and MEN pitches and link their stories safely', () => {
  const ctx = { window: {}, URL, Date, console, document: { head: { insertAdjacentHTML() {} }, addEventListener() {} } };
  vm.createContext(ctx);
  vm.runInContext(`${shared}\nwall = { firstSeen: new Map(), present: false, hideNotes: false };
    globalThis.t = { wallPitch, reportSection, sourceMix, mixLine, renderWallCloseup };`, ctx);
  const url = 'https://explore.pa.media/story/commons-tourism-123';
  const pa = { id: 'p1', slug: 'COMMONS Tourism', angle: 'Visitor levy', status: 'picked', story_id: 's1', pitched_by: 'Sam', source: 'pa', source_url: url };
  const plain = { id: 'p2', slug: 'Bins', angle: '', status: 'pitched', pitched_by: 'Ali', source: null, source_url: 'javascript:alert(1)' };
  const card = ctx.t.wallPitch(pa, {});
  assert.match(card, /<span class="wall-tag pa"[^>]*>PA<\/span>COMMONS Tourism/);
  assert.doesNotMatch(card, /<a\b/, 'no link inside the wall card button');
  assert.doesNotMatch(ctx.t.wallPitch(plain, {}), /wall-tag pa/);
  const html = ctx.t.reportSection({ id: 'r1', name: 'Room', order: ['s1', 'marker-line'], pitches: [pa, plain], feedback: [],
    stories: [{ id: 's1', slug: 'COMMONS TOURISM', format: 'READ', duration: 20, brief: 'Visitor levy', pitched_by: 'Sam', source_url: url }] }, false);
  assert.equal(html.match(/<a href="https:\/\/explore\.pa\.media\/story\/commons-tourism-123" target="_blank" rel="noopener noreferrer">PA story ↗<\/a>/g)?.length, 3, 'conference, wire list and running-order rows link the PA story');
  assert.match(html, /<strong>COMMONS Tourism<\/strong> <span class="tag pa"[^>]*>PA<\/span>/);
  assert.doesNotMatch(html, /javascript:/);
  const bbcUrl = 'https://www.bbc.co.uk/news/articles/c8752wyv155xo';
  const bbc = { id: 'p3', slug: 'Power cuts', angle: 'Cable incident', status: 'pitched', pitched_by: 'Jo', source: 'bbc', source_url: bbcUrl };
  assert.match(ctx.t.wallPitch(bbc, {}), /<span class="wall-tag bbc"[^>]*>FOLLOW-UP · BBC<\/span><span class="wall-gate missing">Answers missing<\/span>Power cuts/);
  assert.match(ctx.t.wallPitch({ ...bbc, source: 'men' }, {}), /<span class="wall-tag men"[^>]*>FOLLOW-UP · MEN<\/span>/);
  const bbcHtml = ctx.t.reportSection({ id: 'r2', name: 'Room', order: ['s2', 'marker-line'], pitches: [bbc], feedback: [],
    stories: [{ id: 's2', slug: 'POWER CUTS', format: 'READ', duration: 20, brief: 'Cable incident', source_url: bbcUrl }] }, false);
  assert.equal(bbcHtml.match(/>BBC story ↗<\/a>/g)?.length, 2, 'BBC links labelled in both rows');
  assert.match(bbcHtml, /<strong>Power cuts<\/strong> <span class="tag bbc"[^>]*>FOLLOW-UP · BBC<\/span>/);
  // Follow pitches: headline, page claims and the three answers, on the wall and in the report.
  const fol = { ...bbc, id: 'p4', slug: 'Follow', source_title: 'Hundreds hit by <power> cuts', source_published_at: '2026-11-17T08:46:54Z', source_modified_at: null,
    follow_when: 'Sunday night', follow_origin: 'ab', follow_angle: 'Second night without power', angle: 'Hundreds hit by power cuts' };
  const folCard = ctx.t.wallPitch(fol, {});
  assert.match(folCard, /class="wall-pitch follow" data-action="wall-followup"/);
  assert.match(folCard, /<span class="wall-gate missing">Answers missing<\/span>/, '2 characters is not an answer');
  assert.match(folCard, /<span class="angle">Hundreds hit by power cuts<\/span>/, 'the pitch angle shows as usual');
  assert.doesNotMatch(folCard, /Sunday night/, 'answers are in the close-up, not on the card');
  assert.match(ctx.t.wallPitch({ ...fol, follow_origin: 'Electricity North West' }, {}), /<span class="wall-gate ready">Ready<\/span>/);
  const close = ctx.t.renderWallCloseup(fol);
  assert.match(close, /BBC: “Hundreds hit by &lt;power&gt; cuts”/);
  assert.match(close, /Page claims: published 17 Nov 2026, \d\d:46 \/ updated not given/);
  assert.match(close, /<dt>Who is the original source\?<\/dt><dd class="missing">Not answered yet<\/dd>/);
  const folHtml = ctx.t.reportSection({ id: 'r3', name: 'Room', order: ['marker-line'], pitches: [fol], feedback: [], stories: [] }, false);
  assert.match(folHtml, /<dt>When did this actually happen\?<\/dt><dd>Sunday night<\/dd>/);
  assert.match(folHtml, /<dt>Who is the original source\?<\/dt><dd>ab<\/dd>/, 'answers verbatim, even short ones');
  assert.match(folHtml, /Page claims: published 17 Nov 2026/);
  // One shared count for the wall and the report.
  const m = ctx.t.sourceMix([{ source: null }, { source: 'pa' }, { source_type: 'wire' }, { ...fol, status: 'picked', story_id: 's9', follow_origin: 'ENW' },
    { source: 'men', status: 'picked', story_id: 'gone' }, { source: 'https-other', status: 'spiked' }], ['s9', 'marker-line']);
  assert.deepEqual({ ...m }, { original: 2, wire: 2, follow: 2, pitched: 6, promoted: 2, inRunningOrder: 1, followAnswered: 1, followPromoted: 2 });
  assert.equal(ctx.t.mixLine(m), 'Original 2 · Wire 2 · Follow-up 2');
  assert.equal(ctx.t.mixLine(m, 'Original (declared)'), 'Original (declared) 2 · Wire 2 · Follow-up 2');
});
