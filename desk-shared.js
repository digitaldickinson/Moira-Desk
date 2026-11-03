// Moira:Desk code shared by the tutor desk (tutor.html) and the admin desk
// (admin.html): the EP wall, the bulletin totals and the report page.
//
// A classic script, loaded before each page's own script. Its top-level names
// are shared with that script, so the page must not declare them again. Each
// page calls configureDesk() with its own RPC names.
//
// admin.html loads this file from GitHub Pages with an integrity hash, so any
// change here means a new hash and ?v= in admin.html. Publish this file first,
// then update both. The hash is the output of
//   openssl dgst -sha384 -binary desk-shared.js | openssl base64 -A
// and ?v= is the first 12 characters of
//   openssl dgst -sha384 desk-shared.js
// tests/desk-shared.test.cjs fails until they match.

window.MoiraDeskShared = true;

const desk = { rpc: null, conferenceRpc: null, noteRpc: null, zoomKey: 'moiradesk-wall-zoom', onWallClose: null };
function configureDesk(options) { Object.assign(desk, options); }

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CHECKED = { 'needs-checking': 'Needs checking', 'checked-ok': 'Checked OK', 'checked-needs-work': 'Needs work' };
const dur = (s) => { s = Math.max(0, Number(s) || 0); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const fullWhen = (t) => t ? new Date(t).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
const shortTime = (t) => t ? new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';

// Re-rendering replaces buttons, so put focus back on the same control afterwards.
function keepFocus(root, draw) {
  const a = document.activeElement;
  let key = null;
  if (a && a !== root && root.contains(a)) {
    const attr = (k) => (a.dataset[k] !== undefined ? `[data-${k}="${CSS.escape(a.dataset[k])}"]` : '');
    if (a.dataset.action) key = `[data-action="${CSS.escape(a.dataset.action)}"]${attr('id')}${attr('val')}`;
    else if (a.classList.contains('sel-room')) key = `.sel-room${attr('id')}`;
  }
  draw();
  if (key) root.querySelector(key)?.focus({ preventScroll: true });
}
const byName = (a, b) => a.name.localeCompare(b.name, 'en-GB', { sensitivity: 'base', numeric: true });

// Styles for the wall and its note dialog. They use each page's colour variables.
document.head.insertAdjacentHTML('beforeend', `<style id="desk-shared-style">
  .wall-view { display: contents; }
  .wall-note-dialog { font-size: 15px; width: min(600px, calc(100vw - 32px)); }
  .wall-note-dialog .note-story { margin: 0; font-weight: 700; overflow-wrap: anywhere; }
  .wall-note-dialog textarea { width: 100%; min-height: 150px; resize: vertical; padding: 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--ink); font: inherit; line-height: 1.5; }
  .wall-note-dialog textarea:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  .wall-note-dialog .note-help { display: flex; justify-content: space-between; gap: 12px; color: var(--muted); font-size: 13px; }

  /* EP wall: projected, so big type and high contrast */
  .wall { position: fixed; inset: 0; z-index: 90; background: var(--bg); display: flex; flex-direction: column; font-size: calc(16px * var(--zoom, 1)); }
  .wall-bar { display: flex; align-items: center; gap: 10px; padding: 10px 16px; background: var(--panel); border-bottom: 1px solid var(--line); flex-wrap: wrap; font-size: 15px; }
  .wall-bar h1 { margin: 0; font-size: 18px; }
  .wall-bar .spacer { flex: 1; }
  .wall-bar button[aria-pressed="true"] { background: var(--ink); border-color: var(--ink); color: var(--panel); }
  .wall-strip { display: flex; align-items: center; gap: 10px; padding: 3px 14px; font-size: 13px; color: var(--muted); }
  .wall-strip .spacer { flex: 1; }
  .wall-strip button { background: transparent; border-color: transparent; color: var(--muted); font-size: 12px; padding: 2px 8px; opacity: .55; }
  .wall-strip button:hover, .wall-strip button:focus-visible { opacity: 1; }
  /* Font size follows --zoom, so A+ means fewer, wider columns. Extra columns wrap to a new row. */
  .wall-cols { flex: 1; min-height: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(17.5em, 100%), 1fr)); grid-auto-rows: minmax(0, 1fr); gap: .75em; padding: .75em; overflow: hidden; }
  .wall-col { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; display: flex; flex-direction: column; min-height: 0; min-width: 0; }
  .wall-col .col-head { display: block; width: 100%; text-align: left; font-size: 1em; white-space: normal; color: var(--ink); background: transparent; border: 0; border-bottom: 1px solid var(--line); border-radius: 12px 12px 0 0; padding: .7em .9em; }
  .wall-col .col-head:hover { background: var(--chip); filter: none; }
  .col-head .name { display: block; font-weight: 800; font-size: 1.25em; overflow-wrap: anywhere; }
  .col-head .expand { float: right; color: var(--muted); margin-left: .4em; }
  .col-head .meta { display: block; color: var(--muted); font-size: .8em; margin-top: 2px; }
  .wall .list { flex: 1; min-height: 0; overflow-y: auto; padding: .6em; display: grid; gap: .5em; align-content: start; }
  .wall-sub { margin: .3em .1em 0; font-size: .72em; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
  .wall-pitch { display: block; width: 100%; text-align: left; font: inherit; white-space: normal; color: var(--ink); border: 1px solid var(--line); border-radius: 10px; padding: .55em .7em; background: var(--panel); }
  .wall-pitch:hover:not(:disabled) { border-color: var(--accent); filter: none; }
  .wall-pitch:disabled { opacity: 1; cursor: default; }
  .wall-pitch > span { display: block; }
  .wall-pitch .slug { font-weight: 800; text-transform: uppercase; letter-spacing: .02em; overflow-wrap: anywhere; }
  .wall-pitch .pill { font-size: .72em; text-transform: none; letter-spacing: 0; }
  .wall-pitch .angle { margin-top: 2px; }
  .wall-pitch .by { color: var(--muted); font-size: .78em; margin-top: 3px; }
  .wall-pitch.picked, .wall-pitch.picked:hover:not(:disabled) { border: 2px solid #126b43; }
  .wall-pitch.new { box-shadow: 0 0 0 3px #2563eb; }
  .wall-tag { display: inline-block; font-size: .68em; font-weight: 800; letter-spacing: .06em; color: #fff; border-radius: 4px; padding: .1em .45em; margin-right: .4em; vertical-align: .12em; }
  .wall-tag.picked { background: #126b43; }
  .wall-tag.new { background: #2563eb; }
  .wall-pitch .note { margin-top: .4em; font-size: .85em; background: var(--warn-bg); color: var(--warn); border-radius: 6px; padding: .3em .5em; }
  .spiked-toggle { width: 100%; text-align: left; font-size: .85em; white-space: normal; color: var(--muted); background: transparent; border: 1px dashed var(--line); border-radius: 8px; padding: .4em .7em; }
  .spiked-list { list-style: none; margin: 0; padding: 0 .3em; display: grid; gap: .25em; font-size: .85em; color: var(--muted); }
  .wall s { color: var(--ink); font-weight: 700; text-transform: uppercase; }
  .wall .empty { color: var(--muted); font-style: italic; padding: .5em; }
  /* Focus on one newsroom */
  .wall-focus { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: .6em; padding: .75em; font-size: 1.35em; }
  .focus-head { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr) minmax(0, 1fr) auto; align-items: center; gap: .6em; }
  .focus-head button { font-size: max(13px, .6em); overflow: hidden; text-overflow: ellipsis; }
  .focus-head .prev { justify-self: start; max-width: 100%; }
  .focus-head .next { justify-self: end; max-width: 100%; }
  .focus-title { text-align: center; min-width: 0; }
  .focus-title h2 { margin: 0; font-size: 1.4em; text-transform: none; letter-spacing: 0; color: var(--ink); overflow-wrap: anywhere; }
  .focus-title .meta { color: var(--muted); font-size: .7em; }
  .focus-panels { flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr 1fr; gap: .75em; }
  .focus-panel { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; display: flex; flex-direction: column; min-height: 0; }
  .focus-panel h3 { margin: 0; padding: .5em .8em; font-size: .75em; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); border-bottom: 1px solid var(--line); }
  .focus-spiked { margin: 0; font-size: .75em; color: var(--muted); }
  @media (max-width: 700px) { .focus-panels { grid-template-columns: 1fr; } .focus-head { grid-template-columns: 1fr 1fr; } .focus-title { grid-column: 1 / -1; grid-row: 1; } }
</style>`);

// ── EP wall ────────────────────────────────────────────────────────────
// The chosen newsrooms' conferences as columns, refreshed every 3 seconds.

let wall = null;

async function openWall(ids) {
  if (wall || !ids.length) return;
  let zoom = 1;
  try { zoom = Number(sessionStorage.getItem(desk.zoomKey)) || 1; } catch {}
  const el = document.createElement('div');
  el.className = 'wall';
  el.innerHTML = '<div class="wall-view"></div>';
  document.body.appendChild(el);
  // Display state lives here, not in the page: renderWall() rebuilds the screen after every poll.
  const w = wall = { ids, data: null, sig: '', el, zoom, error: null, updated: null,
    present: false, focus: null, hideNotes: false, openSpiked: new Set(), firstSeen: new Map(), primed: false };
  el.style.setProperty('--zoom', zoom);
  renderWall();
  el.requestFullscreen?.().catch(() => {});
  w.timer = setInterval(() => pollWall(true), 3000);
  await pollWall();
}

function closeWall() {
  if (!wall) return;
  clearInterval(wall.timer);
  wall.el.remove();
  wall = null;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  desk.onWallClose?.();
}

// On sign-out: remove the wall without refreshing anything.
function discardWall() {
  if (!wall) return;
  clearInterval(wall.timer);
  wall.el.remove();
  wall = null;
}

// The wall can be closed (or reopened) while a request is in flight, so the
// answer is only applied to the wall that asked for it.
// Timer ticks never overlap a request. Explicit refreshes (a saved note or
// returning to the tab) may supersede one, so only the latest answer is used.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') pollWall();
});

async function pollWall(background = false) {
  const w = wall;
  if (!w || document.visibilityState === 'hidden' || (background && w.inFlight)) return;
  w.inFlight = (w.inFlight || 0) + 1;
  const seq = w.seq = (w.seq || 0) + 1;
  let data = null, error = null;
  try { data = await desk.rpc(desk.conferenceRpc, { p_newsroom_ids: w.ids, p_scripts: false }); }
  catch (e) { error = e.message; }
  finally { w.inFlight--; }
  if (wall !== w || seq !== w.seq) return;
  if (error) { w.error = error; w.data = []; w.sig = ''; }
  else {
    w.error = null; w.updated = new Date();
    const sig = JSON.stringify(data);
    if (sig !== w.sig) { w.sig = sig; w.data = data; }
  }
  renderWall();
}

function renderWall() {
  if (!wall) return;
  // A–Z, like the newsroom cards, whatever order the poll returns.
  const w = wall, data = [...(w.data || [])].sort(byName);
  // Pitches already there when the wall opens are never new (time 0).
  if (w.data && !w.error) {
    const now = Date.now();
    data.forEach((n) => n.pitches.forEach((p) => { if (!w.firstSeen.has(p.id)) w.firstSeen.set(p.id, w.primed ? now : 0); }));
    w.primed = true;
    if (w.focus && !data.some((n) => n.id === w.focus)) w.focus = null;
  }
  const scroll = {};
  w.el.querySelectorAll('.list[data-id]').forEach((l) => { scroll[l.dataset.id] = l.scrollTop; });
  const status = w.error ? `<span style="color:var(--err)">Can't refresh: ${esc(w.error)}</span>` : null;
  const bar = w.present
    ? `<div class="wall-strip"><span>Conference · ${status || (w.updated ? `Live · ${shortTime(w.updated)}` : 'Loading…')}</span><span class="spacer"></span>
        <button data-action="wall-present">Show controls</button></div>`
    : `<div class="wall-bar">
      <h1>Conference</h1>
      <span class="muted">${status || (w.updated ? `Live · updated ${w.updated.toLocaleTimeString('en-GB')}` : 'Loading…')}</span>
      <span class="spacer"></span>
      <button data-action="wall-hide-notes" aria-pressed="${w.hideNotes}">${w.hideNotes ? 'Notes hidden' : 'Hide notes'}</button>
      <button data-action="wall-zoom" data-val="-1" title="Smaller text">A−</button>
      <button data-action="wall-zoom" data-val="1" title="Larger text">A+</button>
      <button data-action="wall-present" title="Hide the controls for the meeting (P)">Present</button>
      <button class="primary" data-action="wall-close">Close (Esc)</button>
    </div>`;
  const focused = w.focus && data.find((n) => n.id === w.focus);
  const body = !w.data ? '<div class="wall-cols"><div class="empty">Loading…</div></div>'
    : focused ? renderWallFocus(focused, data) : `<div class="wall-cols">${data.map(renderWallCol).join('')}</div>`;
  keepFocus(w.el, () => { w.el.querySelector('.wall-view').innerHTML = bar + body; });
  w.el.querySelectorAll('.list[data-id]').forEach((l) => { if (scroll[l.dataset.id]) l.scrollTop = scroll[l.dataset.id]; });
}

function wallSplit(n) {
  const of = (k) => n.pitches.filter((p) => p.status === k);
  return { undecided: of('pitched'), picked: of('picked'), spiked: of('spiked'), fmtOf: Object.fromEntries(n.stories.map((s) => [s.id, s.format])) };
}
const wallMeta = (n, g) => `${n.producer_name ? `Producer: ${esc(n.producer_name)}` : 'No producer yet'} · ${g.undecided.length} undecided · ${g.picked.length} picked`;

// The whole card opens the note dialog, except in Present mode.
function wallPitch(p, fmtOf) {
  const seen = wall.firstSeen.get(p.id), isNew = seen > 0 && Date.now() - seen < 30000, picked = p.status === 'picked';
  return `<button class="wall-pitch${picked ? ' picked' : ''}${isNew ? ' new' : ''}" data-action="wall-note" data-id="${esc(p.id)}" ${wall.present ? 'disabled' : `title="${p.ep_note ? 'Edit your EP note' : 'Add an EP note'}"`}>
    <span class="slug">${isNew ? '<span class="wall-tag new">NEW</span>' : ''}${picked ? '<span class="wall-tag picked">PICKED</span>' : ''}${esc(p.slug)}${picked && fmtOf[p.story_id] ? ` <span class="pill">${esc(fmtOf[p.story_id])}</span>` : ''}</span>
    ${p.angle ? `<span class="angle">${esc(p.angle)}</span>` : ''}
    ${p.pitched_by ? `<span class="by">${esc(p.pitched_by)}</span>` : ''}
    ${p.ep_note && !wall.hideNotes ? `<span class="note">EP: ${esc(p.ep_note)}</span>` : ''}
  </button>`;
}
const spikedLine = (p) => `<s>${esc(p.slug)}</s>${p.spike_reason ? ` · ${esc(p.spike_reason)}` : ''}`;

function renderWallCol(n) {
  const g = wallSplit(n), open = wall.openSpiked.has(n.id), card = (p) => wallPitch(p, g.fmtOf);
  const spiked = g.spiked.length ? `<button class="spiked-toggle" data-action="wall-spiked" data-id="${esc(n.id)}" aria-expanded="${open}">${open ? '▾' : '▸'} ${g.spiked.length} spiked</button>
    ${open ? `<ul class="spiked-list">${g.spiked.map((p) => `<li>${spikedLine(p)}</li>`).join('')}</ul>` : ''}` : '';
  return `<section class="wall-col">
    <button class="col-head" data-action="wall-focus" data-id="${esc(n.id)}" title="Focus on this newsroom"><span class="expand" aria-hidden="true">⤢</span>
      <span class="name">${esc(n.name)}</span><span class="meta">${wallMeta(n, g)}</span></button>
    <div class="list" data-id="${esc(n.id)}">${n.pitches.length
      ? `<h3 class="wall-sub">Undecided · ${g.undecided.length}</h3>${g.undecided.map(card).join('')}
        <h3 class="wall-sub">Picked · ${g.picked.length}</h3>${g.picked.map(card).join('')}${spiked}`
      : '<div class="empty">No pitches yet</div>'}</div>
  </section>`;
}

function renderWallFocus(n, data) {
  const g = wallSplit(n), i = data.indexOf(n), len = data.length;
  const prev = data[(i - 1 + len) % len], next = data[(i + 1) % len], one = len < 2 ? 'disabled' : '';
  const panel = (title, key, list) => `<section class="focus-panel"><h3>${title} · ${list.length}</h3>
    <div class="list" data-id="focus-${esc(n.id)}-${key}">${list.length ? list.map((p) => wallPitch(p, g.fmtOf)).join('') : '<div class="empty">None</div>'}</div></section>`;
  return `<div class="wall-focus">
    <div class="focus-head">
      <button class="prev" data-action="wall-step" data-val="-1" ${one}>← ${esc(prev.name)}</button>
      <div class="focus-title"><h2>${esc(n.name)}</h2><div class="meta">${wallMeta(n, g)} · ${i + 1} of ${len}</div></div>
      <button class="next" data-action="wall-step" data-val="1" ${one}>${esc(next.name)} →</button>
      <button data-action="wall-focus" data-id="">All newsrooms</button>
    </div>
    <div class="focus-panels">${panel('Undecided', 'u', g.undecided)}${panel('Picked', 'p', g.picked)}</div>
    ${g.spiked.length ? `<p class="focus-spiked"><strong>Spiked · ${g.spiked.length}:</strong> ${g.spiked.map(spikedLine).join('; ')}</p>` : ''}
  </div>`;
}

// Focus is kept as an id, since polls can return newsrooms in a different order.
function setWallFocus(id) {
  if (!wall) return;
  const prev = wall.focus;
  wall.focus = id || null;
  renderWall();
  if (!wall.focus && prev) wall.el.querySelector(`.col-head[data-id="${CSS.escape(prev)}"]`)?.focus({ preventScroll: true });
}
function stepWall(dir) {
  const data = [...(wall?.data || [])].sort(byName), i = data.findIndex((n) => n.id === wall?.focus);
  if (i < 0 || data.length < 2) return;
  setWallFocus(data[(i + dir + data.length) % data.length].id);
}
function setPresent(on) {
  if (!wall) return;
  wall.present = on;
  if (on && wall.noteDialog) { const d = wall.noteDialog; wall.noteDialog = null; d.close(); d.remove(); }
  renderWall();
  wall.el.querySelector(on ? '.wall-strip [data-action="wall-present"]' : '.wall-bar [data-action="wall-present"]')?.focus({ preventScroll: true });
}

function wallNote(pitchId) {
  const w = wall;
  const p = (w?.data || []).flatMap(n => n.pitches).find(x => x.id === pitchId);
  if (!p || w.noteDialog) return;
  const dialog = document.createElement('dialog');
  dialog.className = 'wall-note-dialog';
  dialog.setAttribute('aria-labelledby', 'wall-note-title');
  dialog.innerHTML = `<form>
    <div class="head"><h3 id="wall-note-title">${p.ep_note ? 'Edit EP note' : 'Add EP note'}</h3><button type="button" class="small" data-note-cancel aria-label="Close note">✕</button></div>
    <div class="body">
      <p class="note-story">${esc(p.slug)}</p>
      <label for="wall-note-text">Your note to the newsroom</label>
      <textarea id="wall-note-text" maxlength="500" aria-describedby="wall-note-help" autofocus>${esc(p.ep_note || '')}</textarea>
      <div class="note-help"><span id="wall-note-help">Visible to the group. Leave blank to remove the note.</span><span data-note-count></span></div>
      <div class="msg err" data-note-error role="alert" hidden></div>
    </div>
    <div class="foot"><button type="button" data-note-cancel>Cancel</button><button type="submit" class="primary">Save note</button></div>
  </form>`;
  // Keep the dialog inside the fullscreen element and outside the live content
  // that polling replaces, so fullscreen, focus and drafts all survive refreshes.
  w.noteDialog = dialog;
  w.el.appendChild(dialog);
  const input = dialog.querySelector('textarea');
  const save = dialog.querySelector('[type="submit"]');
  const error = dialog.querySelector('[data-note-error]');
  let saving = false;
  const count = () => { dialog.querySelector('[data-note-count]').textContent = `${input.value.length}/500`; };
  const close = () => {
    if (saving) return;
    dialog.close(); dialog.remove();
    if (w.noteDialog === dialog) w.noteDialog = null;
    if (wall === w) [...w.el.querySelectorAll('[data-action="wall-note"]')].find(b => b.dataset.id === pitchId)?.focus();
  };
  dialog.querySelectorAll('[data-note-cancel]').forEach(b => b.addEventListener('click', close));
  dialog.addEventListener('cancel', e => { e.preventDefault(); close(); });
  dialog.addEventListener('keydown', e => { e.stopPropagation(); });
  input.addEventListener('input', count);
  dialog.querySelector('form').addEventListener('submit', async e => {
    e.preventDefault(); e.stopPropagation();
    if (saving || wall !== w) return;
    saving = true; error.hidden = true;
    dialog.querySelectorAll('button').forEach(b => { b.disabled = true; });
    input.readOnly = true; save.textContent = 'Saving…';
    try {
      await desk.rpc(desk.noteRpc, { p_pitch_id: pitchId, p_note: input.value });
      if (wall !== w || w.noteDialog !== dialog) return;
      saving = false; close();
      await pollWall();
    } catch (e) {
      if (wall !== w || w.noteDialog !== dialog) return;
      error.textContent = e.message || 'Could not save your note. Please try again.';
      error.hidden = false;
    } finally {
      saving = false;
      dialog.querySelectorAll('button').forEach(b => { b.disabled = false; });
      input.readOnly = false; save.textContent = 'Save note';
    }
  });
  count(); dialog.showModal(); input.focus();
}

// Wall controls, called from each page's own click and keydown listeners.
// Returns true when it handled the action or key.
async function wallClick(action, id, btn) {
  if (!wall || !action.startsWith('wall-')) return false;
  if (action === 'wall-close') closeWall();
  else if (action === 'wall-note') { if (!wall.present) await wallNote(id); }
  else if (action === 'wall-zoom') {
    wall.zoom = Math.min(2.2, Math.max(0.7, Math.round((wall.zoom + Number(btn.dataset.val) * 0.15) * 100) / 100));
    wall.el.style.setProperty('--zoom', wall.zoom);
    try { sessionStorage.setItem(desk.zoomKey, String(wall.zoom)); } catch {}
  }
  else if (action === 'wall-hide-notes') { wall.hideNotes = !wall.hideNotes; renderWall(); }
  else if (action === 'wall-present') setPresent(!wall.present);
  else if (action === 'wall-focus') setWallFocus(id);
  else if (action === 'wall-step') stepWall(Number(btn.dataset.val));
  else if (action === 'wall-spiked') { wall.openSpiked.has(id) ? wall.openSpiked.delete(id) : wall.openSpiked.add(id); renderWall(); }
  else return false;
  return true;
}
// Esc: focus view, then the wall. ← / →: step in focus view. P: Present mode.
// The note dialog stops its own key events, so typing "p" in a note is safe.
function wallKeydown(e, dialogOpen) {
  if (!wall || dialogOpen || wall.noteDialog) return false;
  if (e.key === 'Escape') { if (wall.focus) setWallFocus(null); else closeWall(); }
  else if (wall.focus && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); stepWall(e.key === 'ArrowLeft' ? -1 : 1); }
  else if ((e.key === 'p' || e.key === 'P') && !e.ctrlKey && !e.metaKey && !e.altKey) setPresent(!wall.present);
  else return false;
  return true;
}

// ── Report ─────────────────────────────────────────────────────────────

// The bulletin above END OF PROGRAMME: running time (segments included,
// floated stories not), story count and editorial checks. Used by the cards,
// the review and the report so they always agree. Checks use the desk's four
// states: OK, needs work, needs checking, and not yet marked.
function bulletinStats(n) {
  const byId = Object.fromEntries((n.stories || []).map((s) => [s.id, s]));
  let trt = 0, stories = 0;
  const checks = { ok: 0, work: 0, todo: 0, none: 0 };
  for (const id of Array.isArray(n.order) ? n.order : []) {
    if (id === 'marker-line') break;
    const s = byId[id];
    if (!s) continue;
    if (s.type === 'segment') { trt += s.duration || 0; continue; }
    if (!s.is_floated) trt += s.duration || 0;
    stories++;
    checks[{ 'checked-ok': 'ok', 'checked-needs-work': 'work', 'needs-checking': 'todo' }[s.completed] || 'none']++;
  }
  return { trt, stories, checks, feedback: Array.isArray(n.feedback) ? n.feedback.length : 0 };
}

// EP feedback grouped for the report: the bulletin as a whole, then each story
// in running-order order, then stories that have since been removed.
function feedbackGroups(n) {
  const fb = Array.isArray(n.feedback) ? n.feedback : [];
  if (!fb.length) return [];
  const byId = Object.fromEntries(n.stories.map((s) => [s.id, s]));
  const order = (Array.isArray(n.order) ? n.order : []).filter((id) => byId[id] && byId[id].type !== 'segment');
  const ids = [...new Set([...order, ...fb.map((f) => f.story_id).filter(Boolean)])];
  return [{ title: 'The bulletin as a whole', items: fb.filter((f) => !f.story_id) },
    ...ids.map((id) => ({ title: byId[id] ? byId[id].slug || 'Untitled' : `${fb.find((f) => f.story_id === id).story_slug || 'Untitled'} (removed from the running order)`,
      items: fb.filter((f) => f.story_id === id) }))].filter((g) => g.items.length);
}

// What a report shows for one newsroom, as plain text: the web page on both
// desks, and the admin desk's PDFs.
function reportModel(n) {
  const byId = Object.fromEntries(n.stories.map((s) => [s.id, s]));
  const order = Array.isArray(n.order) ? n.order : [];
  // Running order, as the desk shows it.
  let below = false, num = 0;
  const { trt } = bulletinStats(n);
  const rows = [];
  for (const id of order) {
    if (id === 'marker-line') { below = true; rows.push({ kind: 'eop' }); continue; }
    const s = byId[id]; if (!s) continue;
    if (s.type === 'segment') {
      rows.push({ kind: 'seg', label: `${s.slug}${s.duration ? ` · ${dur(s.duration)}` : ''}` });
      continue;
    }
    const cuez = s.cuez_item_uid ? (s.rev > (s.cuez_sent_rev ?? 0) ? `Item ${s.cuez_item_number || '?'}, changed since` : `Item ${s.cuez_item_number || '?'}`)
      : s.cuez_pending_uid ? 'Unconfirmed' : 'Not sent';
    rows.push({ kind: 'story', s, num: below ? '' : ++num, dim: below || s.is_floated, cuez,
      tags: [s.is_floated ? 'floated' : '', below ? 'below the line' : ''].filter(Boolean).join(', ') });
  }
  const target = n.target_duration != null ? ` against a target of ${dur(n.target_duration)} (${trt - n.target_duration >= 0 ? '+' : '−'}${dur(Math.abs(trt - n.target_duration))})` : '';

  const outcome = (p) => {
    if (p.status === 'picked') return byId[p.story_id] ? { tone: 'ok', label: 'Picked', time: shortTime(p.decided_at) } : { tone: 'ok', label: 'Picked', extra: ', later dropped from the running order' };
    if (p.status === 'spiked') return { tone: 'no', label: 'Spiked', extra: p.spike_reason ? `: ${p.spike_reason}` : '', time: shortTime(p.decided_at) };
    return { tone: 'sub', label: 'Not decided' };
  };
  const pitches = n.pitches.map((p) => ({ p, outcome: outcome(p), format: p.status === 'picked' ? byId[p.story_id]?.format || '' : '' }));
  const meta = [n.conference_started_at ? `Conference ${fullWhen(n.conference_started_at)}` : 'No conference held',
    `Producer: ${n.producer_name || 'none claimed'}`,
    n.cuez_part_title ? `Cuez: ${n.cuez_episode_title || ''} › ${n.cuez_part_title}` : ''].filter(Boolean).join(' · ');
  return {
    rows, trt, target, pitches, meta,
    counts: `${n.pitches.length} pitched · ${n.pitches.filter((p) => p.status === 'picked').length} picked · ${n.pitches.filter((p) => p.status === 'spiked').length} spiked`,
    scripts: order.map((id) => byId[id]).filter((s) => s && s.type !== 'segment' && s.script),
    feedback: feedbackGroups(n),
  };
}

function reportSection(n, withScripts) {
  const m = reportModel(n);
  const roRows = m.rows.map((r) => {
    if (r.kind === 'eop') return `<tr class="eop"><td colspan="7">End of programme</td></tr>`;
    if (r.kind === 'seg') return `<tr class="seg"><td colspan="7">${esc(r.label)}</td></tr>`;
    const s = r.s;
    return `<tr class="${r.dim ? 'dim' : ''}">
      <td class="num">${r.num}</td>
      <td><strong>${esc(s.slug)}</strong>${r.tags ? ` <span class="tag">${r.tags}</span>` : ''}${s.brief ? `<div class="sub">Pitch: ${esc(s.brief)}${s.pitched_by ? ` (${esc(s.pitched_by)})` : ''}</div>` : ''}</td>
      <td>${esc(s.format)}</td>
      <td>${esc(s.reporter)}${s.reporter && s.presenter ? '<br>' : ''}<span class="sub">${esc(s.presenter)}</span></td>
      <td class="num">${dur(s.duration)}</td>
      <td>${CHECKED[s.completed] || '—'}</td>
      <td>${esc(r.cuez)}</td></tr>`;
  }).join('');
  const confRows = m.pitches.map(({ p, outcome: o, format }, i) => `<tr>
      <td class="num">${i + 1}</td>
      <td><strong>${esc(p.slug)}</strong>${format ? ` <span class="tag">${esc(format)}</span>` : ''}${p.angle ? `<div>${esc(p.angle)}</div>` : ''}</td>
      <td>${esc(p.pitched_by)}</td>
      <td><span class="${o.tone}">${o.label}</span>${o.extra ? esc(o.extra) : ''}${o.time ? ` <span class="sub">${o.time}</span>` : ''}</td>
      <td>${p.ep_note ? esc(p.ep_note) : ''}</td></tr>`).join('');
  const scripts = withScripts ? m.scripts.map((s) => `<div class="script"><h4>${esc(s.slug)}</h4><pre>${esc(s.script)}</pre></div>`).join('') : '';
  const feedback = m.feedback.map((g) => `<div class="fb"><h4>${esc(g.title)}</h4>${g.items.map((f) =>
    `${f.quote ? `<blockquote>${esc(f.quote)}</blockquote>` : ''}<p>${esc(f.body)}</p>`).join('')}</div>`).join('');

  return `<section class="newsroom" id="nr-${esc(n.id)}">
    <h2>${esc(n.name)}</h2>
    <p class="meta">${esc(m.meta)}</p>
    <h3>News conference <span class="sub">${m.counts}</span></h3>
    ${m.pitches.length ? `<table><thead><tr><th class="num">#</th><th>Pitch</th><th>Pitched by</th><th>Outcome</th><th>EP note</th></tr></thead><tbody>${confRows}</tbody></table>` : '<p class="sub">No pitches recorded.</p>'}
    <h3>Running order <span class="sub">TRT ${dur(m.trt)}${m.target}</span></h3>
    ${roRows ? `<table><thead><tr><th class="num">#</th><th>Slug</th><th>Format</th><th>Reporter / presenter</th><th class="num">Dur</th><th>Checked</th><th>Cuez</th></tr></thead><tbody>${roRows}</tbody></table>` : '<p class="sub">No stories.</p>'}
    ${feedback ? `<h3>EP feedback</h3>${feedback}` : ''}
    ${scripts ? `<h3>Scripts</h3>${scripts}` : ''}
  </section>`;
}

function buildReport(data, withScripts, generated = new Date()) {
  const title = data.length === 1 ? `${data[0].name}: conference and running order` : 'Conference and running orders';
  const contents = data.length > 1 ? `<nav><strong>Newsrooms</strong><ol>${data.map((n) =>
    `<li><a href="#nr-${esc(n.id)}">${esc(n.name)}</a> <span class="sub">${n.pitches.length} pitched · ${n.pitches.filter((p) => p.status === 'picked').length} picked${n.producer_name ? ` · producer ${esc(n.producer_name)}` : ''}</span></li>`).join('')}</ol></nav>` : '';
  return `<!DOCTYPE html>
<html lang="en-GB"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { --ink:#1b1f27; --muted:#667085; --line:#dfe3ea; --head:#f4f6f9; --ok:#18794e; --no:#9a3412; --eop:#b42318; --seg:#4338ca; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #fff; color: var(--ink); font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .page { max-width: 980px; margin: 0 auto; padding: 28px 16px 60px; }
  h1 { font-size: 26px; margin: 0 0 4px; }
  h2 { font-size: 22px; margin: 0 0 4px; padding-top: 8px; }
  h3 { font-size: 15px; margin: 22px 0 8px; text-transform: uppercase; letter-spacing: .06em; }
  h3 .sub { text-transform: none; letter-spacing: 0; font-weight: 400; margin-left: 6px; }
  h4 { margin: 14px 0 4px; font-size: 14px; }
  .meta, .sub { color: var(--muted); font-size: 13px; }
  nav { border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px; margin: 18px 0 8px; }
  nav ol { margin: 6px 0 0; padding-left: 20px; }
  .newsroom { border-top: 2px solid var(--ink); margin-top: 32px; padding-top: 8px; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { text-align: left; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); background: var(--head); padding: 6px 8px; border-bottom: 1px solid var(--line); }
  td { padding: 7px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  td.num, th.num { text-align: right; width: 1%; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .tag { font-size: 11px; color: var(--muted); border: 1px solid var(--line); border-radius: 4px; padding: 0 5px; margin-left: 4px; white-space: nowrap; }
  .ok { color: var(--ok); font-weight: 600; }
  .no { color: var(--no); font-weight: 600; }
  tr.eop td { background: var(--eop); color: #fff; font-weight: 800; text-transform: uppercase; letter-spacing: .1em; font-size: 12px; }
  tr.seg td { color: var(--seg); font-weight: 700; text-transform: uppercase; letter-spacing: .08em; font-size: 12px; background: #eef0ff; }
  tr.dim td { color: var(--muted); }
  .fb { border-left: 3px solid #b45309; padding: 2px 0 2px 12px; margin: 10px 0 14px; }
  .fb h4 { margin: 0 0 6px; }
  .fb blockquote { margin: 6px 0 2px; color: var(--muted); font-style: italic; white-space: pre-wrap; }
  .fb blockquote::before { content: "“"; } .fb blockquote::after { content: "”"; }
  .fb p { margin: 0 0 8px; white-space: pre-wrap; }
  .script pre { white-space: pre-wrap; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--head); border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; margin: 0; }
  footer { margin-top: 40px; color: var(--muted); font-size: 12px; }
  @media (max-width: 640px) { table { font-size: 13px; } td, th { padding: 6px 5px; } }
  @media print {
    .page { max-width: none; padding: 0; }
    .newsroom { break-before: page; border-top: 0; margin-top: 0; }
    .newsroom:first-of-type { break-before: auto; }
    nav { break-after: page; }
    tr, .script, .fb { break-inside: avoid; }
    tr.eop td, tr.seg td, th { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style></head>
<body><div class="page">
  <h1>${esc(title)}</h1>
  <p class="meta">Snapshot generated ${fullWhen(generated)}. Running orders may have changed since.</p>
  ${contents}
  ${data.map((n) => reportSection(n, withScripts)).join('').replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, '</table></div>')}
  <footer>Generated by Moira:Desk</footer>
</div></body></html>`;
}
