const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.MOIRA_PLAYWRIGHT_MODULE || 'playwright');
(async () => {
 const browser = await chromium.launch({ headless: true });
 try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => { errors.push(e.message); console.error('Browser error:', e.message); });
  await page.clock.install({ time: new Date('2026-10-23T12:00:00Z') });
  await page.addInitScript(() => {
   window.audioCalls = []; window.blockAudio = false;
   window.AudioContext = class {
    constructor() { if (window.blockAudio) throw Error('Autoplay blocked'); this.state = 'running'; this.currentTime = 0; this.destination = {}; }
    createOscillator() { const o = { frequency: {}, connect() {}, start(t) { window.audioCalls.push({ type: o.type, frequency: o.frequency.value, start: t }); }, stop() {} }; return o; }
    createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {} }; }
    close() { return Promise.resolve(); }
   };
  });
  const hook = `
    state.currentBulletinId = 'bulletin-local'; seedLocalData();
    state.rooms = [{id:'room-a',name:'Room A'},{id:'room-b',name:'Room B'}];
    state.currentBulletinId = 'room-a'; state.localMode = false; supabaseUser = {id:'student'};
    let callback; refreshPitches = async () => {};
    DB = {...DB_NULL, subscribe: onBulletin => { callback = onBulletin; return () => {}; }};
    setupListeners(); render();
    window.broadcastTest = {
      receive(row) { callback(bulletinFromRow(row)); },
      room(id) { openRoom(id); },
      ordinary() { showNotice('Saved','Normal notice'); },
      previous() { return callback; }
    };
  `;
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'),'utf8')
   .replace(/<script\b[^>]*\bsrc="[^"]*"[^>]*>\s*<\/script>/g,'')
   .replace(/import \{ createClient \} from "[^"]+";/, 'const createClient = () => { throw Error("No live backend in tests"); };')
   .replace('        boot();',hook);
  await page.route('**/*', route => route.request().url() === 'http://localhost:4173/' ? route.fulfill({ contentType:'text/html', body:source }) : route.abort());
  await page.goto('http://localhost:4173/');
  assert.equal(await page.evaluate(() => !!window.broadcastTest), true, 'test subscription is ready: ' + errors.join('; '));
  const baseTime = await page.evaluate(() => Date.now());
  async function receive(age, text='Everyone back in 5') {
   await page.evaluate(({age,text,baseTime}) => broadcastTest.receive({ep_alert_text:text,ep_alert_at: age === null ? 'invalid' : new Date(baseTime-age).toISOString()}), {age,text,baseTime});
  }
  await receive(300000); await receive(3600000); await receive(null); await receive(1000,'');
  assert.equal(await page.locator('.moira-toast').count(),0,'stale, empty and invalid alerts ignored');
  await receive(1000,'<img src=x onerror=alert(1)> Everyone back in 5');
  let toast = page.locator('.moira-toast');
  await toast.waitFor();
  assert.equal(await toast.locator('img').count(),0);
  assert.equal(await toast.getByText('Click to dismiss',{exact:true}).count(),1);
  assert.deepEqual(await page.evaluate(() => audioCalls.map(c=>[c.type,c.frequency])), [['sine',660],['triangle',880]]);
  await receive(1000); await receive(2000);
  assert.equal(await toast.count(),1,'duplicate and out-of-order events do not replay alerts');
  await page.clock.runFor(16000);
  assert.equal(await toast.count(),1,'warning persists beyond the ordinary 15 second timeout');
  await toast.click(); await toast.waitFor({state:'detached'});
  await page.evaluate(() => { window.blockAudio=true; });
  await receive(0);
  toast=page.locator('.moira-toast'); await toast.waitFor();
  await toast.focus(); await page.keyboard.press('Enter'); await toast.waitFor({state:'detached'});
  await page.evaluate(() => { window.oldCallback=broadcastTest.previous(); broadcastTest.room('room-b'); });
  await page.evaluate(() => oldCallback({epAlertText:'Wrong room',epAlertAt:new Date().toISOString()}));
  assert.equal(await toast.count(),0,'late callbacks from another newsroom ignored');
  await receive(0,'Room B alert'); await toast.waitFor(); await toast.click(); await toast.waitFor({state:'detached'});
  await page.evaluate(() => broadcastTest.room('room-a')); await receive(0);
  assert.equal(await toast.count(),0,'returning to a room does not replay its already-seen broadcast');
  await page.evaluate(() => broadcastTest.ordinary());
  await page.clock.runFor(7100); await toast.waitFor({state:'detached'});
  await receive(-1000,'Everyone back to the newsroom in 5 mins');
  await page.screenshot({path:'/private/tmp/moira-ep-alert.png'});
  assert.deepEqual(errors,[]);
  console.log('PASS: fresh alert delivery, stale/duplicate filtering, per-room tracking, persistent and keyboard dismissal, escaped text, two-note chime, blocked audio and ordinary notice timeout');
 } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
