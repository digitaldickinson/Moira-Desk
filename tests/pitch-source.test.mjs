// PA-sourced pitches: source marker and link stored, validated, carried to the
// picked story and included in the EP wall / report snapshot.
// Run with a temporary PGlite installation via MOIRA_PGLITE_MODULE.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { PGlite } = await import(process.env.MOIRA_PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
const schema = await readFile(new URL('../supabase-schema.sql', import.meta.url), 'utf8');
const migration = await readFile(new URL('../supabase/migrations/20261117_pitch_source.sql', import.meta.url), 'utf8');
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
const baseline = process.env.MOIRA_BASELINE_SCHEMA
    ? await readFile(process.env.MOIRA_BASELINE_SCHEMA, 'utf8') : schema;
await db.exec(baseline.replace('create extension if not exists pgcrypto;', ''));
await db.exec(migration);
await db.exec(migration);
assert.equal((await db.query("select count(*)::int as n from pg_proc where proname = 'add_pitch'")).rows[0].n, 1, 'one add_pitch, no overload');

const admin = '00000000-0000-0000-0000-000000000001';
const student = '00000000-0000-0000-0000-000000000002';
await db.exec(`insert into auth.users values
 ('${admin}', 'admin@example.test', now(), false), ('${student}', null, null, true);
 insert into admins(user_id) values ('${admin}');`);
async function asUser(id) {
    await db.exec('set session authorization postgres');
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
    await db.exec('set session authorization authenticated');
}
async function value(sql, params = []) { return Object.values((await db.query(sql, params)).rows[0])[0]; }
async function row(sql, params = []) { return (await db.query(sql, params)).rows[0]; }

await asUser(admin);
const room = (await db.query("select * from create_newsroom('PA test', 'PASRC123')")).rows[0].newsroom_id;
await asUser(student);
await db.query("select * from join_newsroom('PASRC123')");
await db.query("select claim_producer($1, 'Producer')", [room]);

const url = 'https://explore.pa.media/story/abc-123';
const pa = await value("select add_pitch($1, 'COMMONS Tourism', 'Ministers outline proposals for visitor levy', '', 'Sam', ' PA ', $2)", [room, ` ${url} `]);
assert.deepEqual({ ...(await row('select source, source_url from pitches where id = $1', [pa])) }, { source: 'pa', source_url: url });
const plain = await value("select add_pitch($1, 'Council', 'Local angle', '', 'Sam')", [room]);
assert.deepEqual({ ...(await row('select source, source_url from pitches where id = $1', [plain])) }, { source: null, source_url: null });
const blank = await value("select add_pitch($1, 'Blank', '', '', 'Sam', '', '')", [room]);
assert.deepEqual({ ...(await row('select source, source_url from pitches where id = $1', [blank])) }, { source: null, source_url: null });
console.log('PASS: PA source and link stored; five-argument calls and blanks still work');

for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'ftp://example.org/x', 'https://exa mple.org', 'https://x.org/' + 'a'.repeat(2000)]) {
    await assert.rejects(db.query("select add_pitch($1, 'Bad', '', '', '', 'pa', $2)", [room, bad]), /web address/, bad);
}
await assert.rejects(db.query("select add_pitch($1, 'Bad', '', '', '', 'reuters', null)", [room]), /Unknown pitch source/);
await db.exec('set session authorization postgres');
await assert.rejects(db.query("update pitches set source_url = 'javascript:alert(1)' where id = $1", [pa]), /pitches_source_url_check/);
await assert.rejects(db.query("update pitches set source = 'other' where id = $1", [pa]), /pitches_source_check/);
await asUser(student);
console.log('PASS: unsafe links and unknown sources rejected by the function and the table');

await db.query("select update_pitch($1, 'COMMONS Levy', 'Edited angle', '', 'Sam')", [pa]);
assert.deepEqual({ ...(await row('select slug, source, source_url from pitches where id = $1', [pa])) }, { slug: 'COMMONS Levy', source: 'pa', source_url: url });
console.log('PASS: editing a pitch keeps its source');

const story = await value('select pick_pitch($1)', [pa]);
assert.deepEqual({ ...(await row('select brief, source_url, script from stories where id = $1', [story])) },
    { brief: 'Edited angle', source_url: url, script: '' });
const plainStory = await value('select pick_pitch($1)', [plain]);
assert.equal(await value('select source_url from stories where id = $1', [plainStory]), null);
await db.query('select delete_story($1, $2)', [room, story]);
await db.query('select restore_story($1, $2, 0)', [room, story]);
assert.equal(await value('select source_url from stories where id = $1', [story]), url);
console.log('PASS: picking carries the link to the story (not the script); delete and restore keep it');

await asUser(admin);
const snap = await value('select admin_conference($1)', [[room]]);
const p = snap[0].pitches.find(x => x.id === pa);
assert.equal(p.source, 'pa'); assert.equal(p.source_url, url);
assert.equal(snap[0].pitches.find(x => x.id === plain).source, null);
assert.equal(snap[0].stories.find(s => s.id === story).source_url, url);
console.log('PASS: EP wall / report snapshot includes pitch source and story link');

await db.exec('set session authorization anon');
await assert.rejects(db.query("select add_pitch($1, 'Anon', '', '', '', 'pa', $2)", [room, url]), /permission denied/);
console.log('PASS: anonymous callers cannot add pitches');
await db.close();
