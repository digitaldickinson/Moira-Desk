// Follow pitches (BBC News / MEN): page details stored, three questions gate
// the pick (in pick_pitch and by trigger), the story starts with the follow
// note, and an untouched follow story can still be dropped back.
// Run with a temporary PGlite installation via MOIRA_PGLITE_MODULE.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { PGlite } = await import(process.env.MOIRA_PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
const read = (f) => readFile(new URL(f, import.meta.url), 'utf8');
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema auth;
  create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz, is_anonymous boolean);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  $$;
  grant usage on schema auth, public to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  create publication supabase_realtime;
`);
const baseline = process.env.MOIRA_BASELINE_SCHEMA ? await readFile(process.env.MOIRA_BASELINE_SCHEMA, 'utf8') : await read('../supabase-schema.sql');
await db.exec(baseline.replace('create extension if not exists pgcrypto;', ''));
for (const f of ['20261117_pitch_source.sql', '20261117_pitch_source_sites.sql', '20261118_follow_pitches.sql', '20261118_follow_pitches.sql',
    '20261119_source_mix.sql', '20261119_source_mix.sql']) {
    await db.exec(await read(`../supabase/migrations/${f}`));
}
for (const fn of ['add_pitch', 'pick_pitch']) {
    assert.equal((await db.query('select count(*)::int as n from pg_proc where proname = $1', [fn])).rows[0].n, 1, `one ${fn}, no overload`);
}

const admin = '00000000-0000-0000-0000-000000000001';
const producer = '00000000-0000-0000-0000-000000000002';
const pitcher = '00000000-0000-0000-0000-000000000003';
const other = '00000000-0000-0000-0000-000000000004';
await db.exec(`insert into auth.users values
 ('${admin}', 'admin@example.test', now(), false), ('${producer}', null, null, true),
 ('${pitcher}', null, null, true), ('${other}', null, null, true);
 insert into admins(user_id) values ('${admin}');`);
async function asUser(id) {
    await db.exec('set session authorization postgres');
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
    await db.exec('set session authorization authenticated');
}
const value = async (sql, params = []) => Object.values((await db.query(sql, params)).rows[0])[0];
const row = async (sql, params = []) => ({ ...(await db.query(sql, params)).rows[0] });

await asUser(admin);
const room = (await db.query("select * from create_newsroom('Follow test', 'FOLLOW12')")).rows[0].newsroom_id;
for (const u of [producer, pitcher, other]) { await asUser(u); await db.query("select * from join_newsroom('FOLLOW12')"); }
await asUser(producer);
await db.query("select claim_producer($1, 'Producer')", [room]);

// Adding: page details kept for BBC/MEN only, cleaned; bad dates dropped.
await asUser(pitcher);
const BBC = 'https://www.bbc.co.uk/news/articles/c8752wyv155xo';
const add = (slug, src, url, title, desc, pub, mod) => value(
    'select add_pitch($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)', [room, slug, src === 'bbc' ? 'Hundreds hit by power cuts' : '', '', 'Pitcher', src, url, title, desc, pub, mod]);
const f1 = await add('POWER CUTS', 'bbc', BBC, '  Hundreds of properties\n hit by power cuts ', 'Customers remain without electricity.', '2026-11-17T08:46:54.678Z', 'not a date');
assert.deepEqual(await row('select source_title, source_description, source_published_at, source_modified_at, follow_when, follow_origin, angle from pitches where id = $1', [f1]), {
    source_title: 'Hundreds of properties hit by power cuts', source_description: 'Customers remain without electricity.',
    source_published_at: new Date('2026-11-17T08:46:54.678Z'), source_modified_at: null, follow_when: null, follow_origin: null, angle: 'Hundreds hit by power cuts' });
const pa = await add('PA STORY', 'pa', 'https://explore.pa.media/x', '  PA   headline ', 'Ignored', '2026-11-17T08:00:00Z', null);
assert.deepEqual(await row('select source_title, source_description, source_published_at from pitches where id = $1', [pa]), { source_title: 'PA headline', source_description: null, source_published_at: null },
    'a PA drop keeps its headline, nothing else');
const typed = await value("select add_pitch($1, 'TYPED', 'Own idea', '', 'Pitcher')", [room]);
// Every pitch has a source type, worked out from how it was added.
const otherLink = await value("select add_pitch($1, 'OTHER', '', '', 'Pitcher', null, 'https://news.example.org/x')", [room]);
assert.deepEqual((await db.query('select id, source_type from pitches where id = any($1)', [[f1, pa, typed, otherLink]])).rows.map(r => [r.id, r.source_type]).sort(),
    [[f1, 'follow'], [pa, 'wire'], [typed, 'original'], [otherLink, 'original']].sort());
await db.exec('set session authorization postgres');
await assert.rejects(db.query("update pitches set source_type = 'wire' where id = $1", [typed]), /generated column|can only be updated to DEFAULT/);
await asUser(pitcher);
console.log('PASS: BBC/MEN page details stored and cleaned; PA keeps its headline; every pitch has a source type');

// Answers: pitcher and producer only; blanks allowed before picking.
await db.query("select set_follow_answers($1, 'Sunday night', '', 'Second night without power')", [f1]);
assert.deepEqual(await row('select follow_when, follow_origin, follow_angle, angle from pitches where id = $1', [f1]),
    { follow_when: 'Sunday night', follow_origin: null, follow_angle: 'Second night without power', angle: 'Hundreds hit by power cuts' }, 'the headline angle is untouched');
await db.query("select set_follow_answers($1, 'Sunday night', '', 'Second night without power', '  Power cuts latest  ')", [f1]);
assert.equal(await value('select slug from pitches where id = $1', [f1]), 'Power cuts latest');
await assert.rejects(db.query("select set_follow_answers($1, 'Sunday night', '', 'x', '  ')", [f1]), /Give the pitch a slug/);
await db.query("select set_follow_answers($1, 'Sunday night', '', 'Second night without power', 'POWER CUTS')", [f1]);
await asUser(other);
await assert.rejects(db.query("select set_follow_answers($1, 'x', 'y', 'z')", [f1]), /Only whoever added this pitch, or the producer/);
await asUser(pitcher);
await assert.rejects(db.query("select set_follow_answers($1, 'x', 'y', 'z')", [pa]), /Only BBC News and MEN pitches/);
console.log('PASS: follow answers saved by the pitcher; others and non-follow pitches refused');

// The gate: 0- and 2-character answers refused, by pick_pitch and by the trigger.
await asUser(producer);
await assert.rejects(db.query('select pick_pitch($1)', [f1]), /Follow-up pitch needs: who the original source is\./);
await assert.rejects(db.query("select pick_pitch($1, null, ' a b ', null)", [f1]), /who the original source is/, '2 characters is not enough');
await assert.rejects(db.query("select pick_pitch($1, '  ', 'Electricity North West', 'ok')", [f1]), /when it actually happened, what's new, or our angle/);
assert.equal(await value('select status from pitches where id = $1', [f1]), 'pitched');
await db.exec('set session authorization postgres');
await assert.rejects(db.query("update pitches set status = 'picked' where id = $1", [f1]), /Follow-up pitch needs: who the original source is/, 'trigger blocks a direct update');
await asUser(pitcher);
await assert.rejects(db.query('select pick_pitch($1)', [f1]), /producer/i, 'students cannot pick');
console.log('PASS: the gate refuses missing and 2-character answers in pick_pitch and by trigger');

// Picking with answers: they're saved, the angle is the brief, the script opens with the note.
await asUser(producer);
const story = await value("select pick_pitch($1, null, 'Electricity North West [statement]', null)", [f1]);
assert.deepEqual(await row('select status, follow_when, follow_origin, follow_angle from pitches where id = $1', [f1]),
    { status: 'picked', follow_when: 'Sunday night', follow_origin: 'Electricity North West [statement]', follow_angle: 'Second night without power' });
const s = await row('select brief, script, script_seed, source_url from stories where id = $1', [story]);
const note = ['[FOLLOW-UP NOTE: delete these lines once the story is written]',
    '[Follow-up to BBC News: "Hundreds of properties hit by power cuts"]',
    '[When it happened: Sunday night]', '[Original source: Electricity North West (statement)]',
    "[What's new / our angle: Second night without power]"].join('\n');
assert.deepEqual(s, { brief: 'Hundreds hit by power cuts', script: note, script_seed: note, source_url: BBC });
const typedStory = await value('select pick_pitch($1)', [typed]);
assert.deepEqual(await row('select script, script_seed from stories where id = $1', [typedStory]), { script: '', script_seed: null });
console.log('PASS: picking saves the answers, uses our angle as the brief and opens the script with the follow note');

// Answers stay editable after picking but can't be emptied.
await asUser(pitcher);
await db.query("select set_follow_answers($1, 'Sunday 16 November', 'Electricity North West', 'Second night without power')", [f1]);
await assert.rejects(db.query("select set_follow_answers($1, 'ok', 'Electricity North West', 'Second night')", [f1]), /when it actually happened/);
console.log('PASS: picked answers editable, never below the minimum');

// An untouched follow story can be dropped back; a written one can't.
await asUser(producer);
await db.query('select unpick_pitch($1)', [f1]);
assert.equal(await value('select status from pitches where id = $1', [f1]), 'pitched');
assert.equal(await value('select count(*)::int from stories where id = $1', [story]), 0);
const story2 = await value('select pick_pitch($1)', [f1]);
await db.exec('set session authorization postgres');
await db.query("update stories set script = script || E'\\nPower is back for most homes.' where id = $1", [story2]);
await asUser(producer);
await assert.rejects(db.query('select unpick_pitch($1)', [f1]), /has been worked on/);
console.log('PASS: untouched follow stories drop back; written ones are kept');

// EP wall / report snapshot carries the follow details.
await asUser(admin);
const snap = await value('select admin_conference($1)', [[room]]);
const p = snap[0].pitches.find(x => x.id === f1);
assert.equal(p.source_title, 'Hundreds of properties hit by power cuts');
assert.equal(p.follow_when, 'Sunday 16 November');
assert.equal(p.follow_origin, 'Electricity North West');
assert.equal(p.follow_angle, 'Second night without power');
assert.equal(p.angle, 'Hundreds hit by power cuts');
assert.deepEqual(snap[0].pitches.map(x => x.source_type).sort(), ['follow', 'original', 'original', 'wire']);
assert.ok(p.source_published_at && 'source_modified_at' in p);
console.log('PASS: snapshot includes headline, page dates and answers');

// Re-running the migration copies a third answer an earlier version kept in angle.
await asUser(pitcher);
const old = await add('OLD STYLE', 'men', 'https://www.manchestereveningnews.co.uk/news/x-1', 'T', '', null, null);
await db.exec('set session authorization postgres');
await db.query("update pitches set angle = 'Our own angle', follow_when = 'Monday' where id = $1", [old]);
await db.exec(await read('../supabase/migrations/20261118_follow_pitches.sql'));
assert.equal(await value('select follow_angle from pitches where id = $1', [old]), 'Our own angle');
assert.equal(await value('select follow_angle from pitches where id = $1', [typed]), null, 'typed pitches untouched');
console.log('PASS: re-running the migration moves an old-style third answer across');

await db.exec('set session authorization anon');
await assert.rejects(db.query("select set_follow_answers($1, 'a', 'b', 'c')", [f1]), /permission denied/);
await db.exec('set session authorization authenticated');
await assert.rejects(db.query("select follow_note(p) from pitches p limit 1"), /permission denied/);
console.log('PASS: anonymous callers refused; helpers not callable directly');
await db.close();
