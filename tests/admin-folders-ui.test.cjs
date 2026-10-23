// External Playwright only; all Supabase calls are mocked and network access blocked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.MOIRA_PLAYWRIGHT_MODULE || 'playwright');
const file = path.join(__dirname, '..', 'admin.html');
if (!fs.existsSync(file)) { console.log('SKIP: local admin.html is not present'); process.exit(0); }
const html = fs.readFileSync(file, 'utf8').replace(/<script\b[^>]*\bsrc="[^"]*"[^>]*>\s*<\/script>/g, '');
(async () => {
 const browser = await chromium.launch({ headless: true });
 const errors = [], calls = [];
 const rooms = ['Newsday Blue', 'Newsday Red', 'Year 1 Radio', 'Year 2 TV', 'Summer Workshop', 'Last year'].map((name, i) => ({ newsroom_id: `room-${i}`, name, members: 12, stories: 3, sent_stories: 0, has_code: true, producer_name: '', pitches: 2, picked: 1 }));
 let folders = [], failMove = false, unavailable = false;
 async function rpc(name, args) {
  calls.push({ name, args });
  if (name === 'is_admin') return { data: true };
  if (name === 'admin_newsrooms' || name === 'tutor_newsrooms') return { data: rooms };
  if (name === 'admin_tutors') return { data: [] };
  if (name === 'get_admin_folders') return unavailable ? { error: { message: 'Missing function' } } : { data: structuredClone(folders) };
  if (name === 'save_admin_folder') {
   if (folders.some(f => f.name.toLowerCase() === args.p_name.trim().toLowerCase() && f.id !== args.p_folder_id)) return { error: { message: 'You already have a folder with that name.' } };
   if (args.p_folder_id) folders.find(f => f.id === args.p_folder_id).name = args.p_name;
   else folders.push({ id: `folder-${folders.length + 1}`, name: args.p_name.trim(), newsroom_ids: [] });
   return { data: args.p_folder_id || folders.at(-1).id };
  }
  if (name === 'move_admin_newsrooms') {
   if (failMove) return { error: { message: 'Move failed. Try again.' } };
   folders.forEach(f => { f.newsroom_ids = f.newsroom_ids.filter(id => !args.p_newsroom_ids.includes(id)); });
   if (args.p_folder_id) folders.find(f => f.id === args.p_folder_id).newsroom_ids.push(...args.p_newsroom_ids);
   return { data: null };
  }
  if (name === 'delete_admin_folder') { folders = folders.filter(f => f.id !== args.p_folder_id); return { data: null }; }
  throw Error(`Unexpected RPC ${name}`);
 }
 async function open(context) {
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.exposeFunction('folderMockRpc', rpc);
  await page.addInitScript(() => {
   window.supabase = { createClient: () => ({
    auth: { getSession: async () => ({ data: { session: { user: { id: 'admin-a', email: 'admin@example.test' } } } }), signOut: async () => ({}) },
    rpc: (name, args) => window.folderMockRpc(name, args),
    functions: { invoke: async () => ({ data: { status: 'missing', checkedAt: new Date().toISOString(), expiresAt: null } }) }
   }) };
  });
  await page.route('**/*', route => route.request().url() === 'http://moira.test/admin.html' ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
  await page.goto('http://moira.test/admin.html');
  await page.getByLabel('Find a newsroom').waitFor();
  return page;
 }
 try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await open(context);
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  await page.getByLabel('Folder name').fill('Autumn 2026');
  await page.getByRole('button', { name: 'Save folder' }).click();
  const group = page.locator('[data-folder="folder-1"]');
  await group.waitFor();
  assert.equal(await group.locator('.folder-toggle').getAttribute('aria-expanded'), 'false');
  for (const name of ['Newsday Blue', 'Newsday Red']) await page.getByRole('checkbox', { name: `Select ${name}`, exact: true }).check();
  await page.getByRole('button', { name: 'Move selected (2)', exact: true }).click();
  await page.getByLabel('Destination').selectOption('folder-1');
  await page.getByRole('button', { name: 'Move newsrooms', exact: true }).click();
  await group.locator('[data-newsroom="room-0"]').waitFor();
  assert.equal(await group.locator('[data-newsroom]').count(), 2);
  assert.equal(await page.locator('[data-folder="unfiled"] [data-newsroom]').count(), 4);
  await group.locator('.folder-toggle').click();
  await page.reload(); await page.getByLabel('Find a newsroom').waitFor();
  assert.equal(await group.locator('.folder-toggle').getAttribute('aria-expanded'), 'false', 'collapsed preference persists');
  await page.getByLabel('Find a newsroom').fill('Blue');
  await group.locator('[data-newsroom="room-0"]').waitFor();
  assert.equal(await page.locator('[data-newsroom]').count(), 1, 'search reaches collapsed folders');
  await group.getByRole('checkbox', { name: 'Select all shown in Autumn 2026' }).check();
  assert.deepEqual(await page.evaluate(() => [...state.selected]), ['room-0'], 'select all only selects matching rooms');
  await page.getByLabel('Find a newsroom').fill('');
  assert.equal(await group.locator('.folder-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(await group.locator('.folder-selection').innerText(), '1 selected');
  await page.getByRole('button', { name: 'Clear selection (1)' }).click();
  await page.getByRole('button', { name: 'Rename folder Autumn 2026', exact: true }).click();
  await page.getByLabel('Folder name').fill('<img src=x onerror=alert(1)>');
  await page.getByRole('button', { name: 'Save folder' }).click();
  await page.waitForFunction(() => state.folders[0].name.startsWith('<img'));
  assert.equal(await group.locator('img').count(), 0, 'folder names are escaped');
  // A fresh browser context gets the saved grouping without local browser storage.
  const second = await open(await browser.newContext());
  assert.equal(await second.locator('[data-folder="folder-1"] .pill').innerText(), '2');
  await second.close();
  await page.getByRole('button', { name: 'Rename folder <img src=x onerror=alert(1)>', exact: true }).click();
  await page.getByLabel('Folder name').fill('Autumn 2026');
  await page.getByRole('button', { name: 'Save folder' }).click();
  await page.getByRole('button', { name: 'Rename folder Autumn 2026', exact: true }).waitFor();
  const unfiled = page.locator('[data-folder="unfiled"]');
  await unfiled.locator('[data-newsroom="room-2"] [data-action="move-room"]').click();
  await page.getByLabel('Destination').selectOption('folder-1'); failMove = true;
  await page.getByRole('button', { name: 'Move newsrooms', exact: true }).click();
  await page.getByText('Move failed. Try again.', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Destination').inputValue(), 'folder-1');
  assert.equal(await unfiled.locator('[data-newsroom="room-2"]').count(), 1);
  failMove = false;
  await page.getByRole('button', { name: 'Move newsrooms', exact: true }).click();
  await group.locator('[data-newsroom="room-2"]').waitFor();
  await group.locator('.folder-toggle').click();
  await page.screenshot({ path: '/private/tmp/moira-admin-folders.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: '/private/tmp/moira-admin-folders-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Remove folder Autumn 2026', exact: true }).click();
  await page.locator('#dlg').getByRole('button', { name: 'Remove folder', exact: true }).click();
  await page.getByText('Folder removed. Its newsrooms are now Unfiled.', { exact: true }).waitFor();
  assert.equal(await unfiled.locator('[data-newsroom]').count(), rooms.length);
  unavailable = true;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Folders could not be loaded' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'New folder', exact: true }).isDisabled(), true);
  assert.equal(await page.locator('[data-newsroom]').count(), rooms.length, 'missing SQL leaves rooms usable');
  assert.equal(calls.some(c => ['delete_newsroom','set_tutor_access','start_conference'].includes(c.name)), false);
  assert.deepEqual(errors, []);
  console.log('PASS: folder creation, bulk/single moves, collapsed persistence, search, scoped selection, escaping, cross-browser grouping, failed-save recovery, mobile layout, safe removal and missing-migration fallback');
 } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
