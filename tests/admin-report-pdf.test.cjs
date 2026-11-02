// External Playwright only; Supabase is mocked, and the PDF libraries are served
// from a local pdfmake/jszip install (MOIRA_REPORT_LIBS, a node_modules folder).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.MOIRA_PLAYWRIGHT_MODULE || 'playwright');
const file = path.join(__dirname, '..', 'admin.html');
if (!fs.existsSync(file)) { console.log('SKIP: local admin.html is not present'); process.exit(0); }
const libs = process.env.MOIRA_REPORT_LIBS || path.join(__dirname, '..', 'node_modules');
const lib = (rel) => fs.readFileSync(path.join(libs, rel));
const JSZip = require(path.join(libs, 'jszip'));
const html = fs.readFileSync(file, 'utf8').replace(/<script\b[^>]*\bsrc="[^"]*"[^>]*>\s*<\/script>/g, '');
const CDN = {
 'https://cdn.jsdelivr.net/npm/pdfmake@0.3.13/build/pdfmake.min.js': 'pdfmake/build/pdfmake.min.js',
 'https://cdn.jsdelivr.net/npm/pdfmake@0.3.13/build/vfs_fonts.js': 'pdfmake/build/vfs_fonts.js',
 'https://cdn.jsdelivr.net/npm/jszip@3.10.2/dist/jszip.min.js': 'jszip/dist/jszip.min.js',
};

const rooms = ['Newsday Blue', 'Newsday Red', 'Newsday Blue'].map((name, i) => ({ newsroom_id: `room-${i}`, name, members: 4, stories: 2, sent_stories: 0, has_code: true, producer_name: '', pitches: 2, picked: 1 }));
const conference = (id, name) => ({
 id, name, producer_name: 'Sam', conference_started_at: '2026-11-02T09:00:00Z', target_duration: 120,
 cuez_episode_title: 'Lunch', cuez_part_title: 'Part 1',
 pitches: [
  { slug: 'Bridge closure', angle: 'Commuters face delays', pitched_by: 'Ana', status: 'picked', story_id: 's1', decided_at: '2026-11-02T09:10:00Z', ep_note: 'Get a council voice' },
  { slug: 'Cat show', pitched_by: 'Ben', status: 'spiked', spike_reason: 'Too soft', decided_at: '2026-11-02T09:12:00Z' },
 ],
 stories: [
  { id: 'seg', type: 'segment', slug: 'Headlines', duration: 20 },
  { id: 's1', slug: 'Bridge closure', format: 'PKG', reporter: 'Ana', presenter: 'Joe', duration: 95, completed: 'checked-ok', script: 'LINK: The bridge shuts tonight.\n  Indented line.', brief: 'Commuters face delays', pitched_by: 'Ana' },
  { id: 's2', slug: 'Weather', format: 'OOV', duration: 30, is_floated: true, script: 'Rain later.' },
 ],
 order: ['seg', 's1', 'marker-line', 's2'],
 feedback: [
  { id: 'f1', story_id: null, body: 'Good pace, lead buried.' },
  { id: 'f2', story_id: 's1', quote: 'The bridge shuts tonight.', body: 'Attribute this.' },
  { id: 'f3', story_id: 'gone', story_slug: 'Dropped', body: 'Shame it went.' },
 ],
});

(async () => {
 const browser = await chromium.launch({ headless: true });
 const errors = [];
 let failLibs = false;
 try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.exposeFunction('reportMockRpc', (name, args) => {
   if (name === 'is_admin') return { data: true };
   if (name === 'admin_newsrooms' || name === 'tutor_newsrooms') return { data: rooms };
   if (name === 'admin_tutors' || name === 'get_admin_folders') return { data: [] };
   if (name === 'admin_conference') return { data: args.p_newsroom_ids.map(id => conference(id, rooms.find(r => r.newsroom_id === id).name)) };
   throw Error(`Unexpected RPC ${name}`);
  });
  await page.addInitScript(() => {
   window.supabase = { createClient: () => ({
    auth: { getSession: async () => ({ data: { session: { user: { id: 'admin-a', email: 'admin@example.test' } } } }), signOut: async () => ({}) },
    rpc: (name, args) => window.reportMockRpc(name, args),
    functions: { invoke: async () => ({ data: { status: 'missing', checkedAt: new Date().toISOString(), expiresAt: null } }) },
   }) };
  });
  await page.route('**/*', route => {
   const url = route.request().url();
   if (url === 'http://moira.test/admin.html') return route.fulfill({ contentType: 'text/html', body: html });
   if (CDN[url] && !failLibs) return route.fulfill({ contentType: 'text/javascript', body: lib(CDN[url]), headers: { 'Access-Control-Allow-Origin': '*' } });
   return route.abort();
  });
  await page.goto('http://moira.test/admin.html');
  await page.getByLabel('Find a newsroom').waitFor();
  const dialog = page.locator('dialog[open]');
  const generate = async (ids, scripts) => {
   await page.evaluate(({ ids, scripts }) => { state.selected = new Set(ids); state.reportScripts = scripts; render(); }, { ids, scripts });
   await page.getByRole('button', { name: 'Generate report', exact: true }).click();
  };
  const download = async (link) => { const [d] = await Promise.all([page.waitForEvent('download'), link.click()]); return { name: d.suggestedFilename(), body: fs.readFileSync(await d.path()) }; };

  // The libraries fail to load: the overview still works and the PDFs can be retried.
  failLibs = true;
  await generate(['room-0'], false);
  await dialog.getByText('Could not load the PDF tools').waitFor();
  assert.equal(await dialog.getByRole('link', { name: 'Download overview' }).count(), 1);
  failLibs = false;
  await dialog.getByRole('button', { name: 'Try again' }).click();

  // One newsroom: a single PDF.
  const one = dialog.getByRole('link', { name: 'Download PDF', exact: true });
  await one.waitFor();
  const pdf = await download(one);
  assert.match(pdf.name, /^moira-desk-newsday-blue-\d{4}-\d\d-\d\d-\d{4}\.pdf$/);
  assert.equal(pdf.body.subarray(0, 5).toString(), '%PDF-');
  const overview = await download(dialog.getByRole('link', { name: 'Download overview' }));
  assert.match(overview.name, /-overview\.html$/);

  // Several newsrooms, two with the same name, with scripts: one ZIP, one PDF each.
  await page.locator('dialog [data-action="close-dialog"]').first().click();
  await generate(['room-0', 'room-1', 'room-2'], true);
  const many = dialog.getByRole('link', { name: 'Download 3 PDFs (ZIP)' });
  await many.waitFor();
  const zip = await download(many);
  assert.match(zip.name, /^moira-desk-reports-.*\.zip$/);
  const names = Object.keys((await JSZip.loadAsync(zip.body)).files).sort();
  assert.equal(names.length, 3);
  assert.match(names[0], /^moira-desk-newsday-blue-.*-2\.pdf$/, 'duplicate names get a suffix');
  assert.match(names[1], /^moira-desk-newsday-blue-\d{4}-\d\d-\d\d-\d{4}\.pdf$/);
  assert.match(names[2], /^moira-desk-newsday-red-/);
  for (const n of names) assert.equal((await (await JSZip.loadAsync(zip.body)).file(n).async('string')).slice(0, 5), '%PDF-');

  // The PDF carries the same content as the overview, scripts at the end.
  const doc = await page.evaluate((c) => JSON.stringify(reportPdf(c, true, new Date()).content), conference('room-1', 'Newsday Red'));
  for (const text of ['NEWS CONFERENCE', 'END OF PROGRAMME', 'HEADLINES · 0:20', 'Get a council voice', ': Too soft', 'floated, below the line', 'Not sent', 'TRT 1:55 against a target of 2:00', 'LINK: The bridge shuts tonight.']) {
   assert.ok(doc.includes(JSON.stringify(text).slice(1, -1)), `PDF includes ${text}`);
  }
  assert.ok(doc.indexOf('SCRIPTS') > doc.indexOf('RUNNING ORDER'), 'scripts come after the running order');
  for (const text of ['EP FEEDBACK', 'The bulletin as a whole', 'Good pace, lead buried.', '“The bridge shuts tonight.”', 'Attribute this.', 'Dropped (removed from the running order)'])
   assert.ok(doc.includes(text), `PDF feedback includes ${text}`);
  assert.ok(doc.indexOf('RUNNING ORDER') < doc.indexOf('EP FEEDBACK') && doc.indexOf('EP FEEDBACK') < doc.indexOf('SCRIPTS'), 'feedback sits between the running order and scripts');
  assert.ok(!(await page.evaluate((c) => JSON.stringify(reportPdf(c, false, new Date()).content), conference('room-1', 'Newsday Red'))).includes('SCRIPTS'));

  await page.screenshot({ path: '/private/tmp/moira-admin-report.png' });
  assert.deepEqual(errors, []);
  console.log('PASS: per-newsroom PDFs, ZIP for several with unique names, overview kept, scripts at the end, retry after library load failure');
 } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
