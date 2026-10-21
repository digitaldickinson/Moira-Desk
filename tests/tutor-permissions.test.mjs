// Run with Node and a temporary PGlite installation; no app dependencies needed.
// MOIRA_PGLITE_MODULE may point to the installed package's dist/index.js.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { PGlite } = await import(process.env.MOIRA_PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
const schema = await readFile(new URL('../supabase-schema.sql', import.meta.url), 'utf8');
const migration = await readFile(new URL('../supabase/migrations/20261021_tutor_access.sql', import.meta.url), 'utf8');
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
// The schema uses core sha256/gen_random_uuid, so no pgcrypto extension is
// needed in this WASM PostgreSQL test environment. Production SQL is unchanged.
const prepare = sql => sql.replace('create extension if not exists pgcrypto;', '');
if (process.env.MOIRA_BASELINE_SCHEMA) {
  await db.exec(prepare(await readFile(process.env.MOIRA_BASELINE_SCHEMA, 'utf8')));
} else {
  await db.exec(prepare(schema));
  await db.exec(prepare(schema));
}
await db.exec(migration);
await db.exec(migration);
let passed = 0;
const check = (condition, message) => { assert.ok(condition, message); passed++; console.log('PASS:', message); };
const admin = '00000000-0000-0000-0000-000000000001';
const tutor = '00000000-0000-0000-0000-000000000002';
const student = '00000000-0000-0000-0000-000000000003';
const outsider = '00000000-0000-0000-0000-000000000004';
await db.exec(`insert into auth.users values
  ('${admin}', 'admin@example.test', now(), false),
  ('${tutor}', 'tutor@example.test', now(), false),
  ('${student}', null, null, true),
  ('${outsider}', 'other@example.test', now(), false);
  insert into admins(user_id) values ('${admin}');`);
async function asUser(id, role = 'authenticated') {
  await db.exec('reset session authorization');
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id || '']);
  await db.exec(`set session authorization ${role}`);
}
async function value(sql, params = []) { return Object.values((await db.query(sql, params)).rows[0])[0]; }
async function denied(sql, params, message) {
  await assert.rejects(() => db.query(sql, params)); passed++; console.log('PASS:', message);
}
await asUser(admin);
const a = (await db.query("select * from create_newsroom('Tutor A', 'MAINA123')")).rows[0].newsroom_id;
const b = (await db.query("select * from create_newsroom('Tutor B', 'MAINB123')")).rows[0].newsroom_id;
await db.query('select set_tutor_access($1, $2::text[])', ['tutor@example.test', [a]]);
const codeA = await value('select set_tutor_join_code($1)', [a]);
const codeB = await value('select set_tutor_join_code($1)', [b]);
check(codeA !== codeB, 'separate generated tutor codes');
await denied('select set_tutor_access($1, $2::text[])', ['missing@example.test', [a]], 'unknown accounts cannot be assigned');
await denied('select set_tutor_access($1, $2::text[])', ['tutor@example.test', ['missing']], 'invalid assignments rejected atomically');

await asUser(student);
check((await db.query('select * from join_newsroom($1)', [codeA.toLowerCase().replaceAll('-', ' ')])).rows[0].newsroom_id === a, 'student can join with normalised tutor code');
const pitch = await value("select add_pitch($1, 'Council', 'Local angle', '', 'Student')", [a]);
await denied('select * from tutor_newsrooms()', [], 'student cannot list tutor newsrooms');
await denied('select get_tutor_join_code($1)', [a], 'student member cannot retrieve tutor code');
await denied('select * from tutor_join_codes', [], 'student cannot read code table');
await denied('select * from tutors', [], 'student cannot read staff list');
await denied('select conference_snapshot($1::text[], true)', [[a,b]], 'private report helper is not callable by students');
await denied('select set_tutor_access($1, $2::text[])', ['other@example.test', [b]], 'student cannot grant tutor access');

await asUser(tutor);
check(await value('select is_tutor()'), 'assigned staff recognised as tutor');
check((await db.query('select * from tutor_newsrooms()')).rows.map(r => r.newsroom_id).join() === a, 'tutor sees only assigned newsroom');
check(await value('select get_tutor_join_code($1)', [a]) === codeA, 'assigned tutor can retrieve second code');
await denied('select get_tutor_join_code($1)', [b], 'other newsroom code denied');
await denied('select * from tutor_join_codes', [], 'tutor cannot read code table directly');
await denied('select * from newsroom_codes', [], 'main code hashes remain inaccessible');
const report = await value('select tutor_conference($1::text[], true)', [[a]]);
check(report.length === 1 && report[0].id === a && report[0].stories[0].script, 'assigned report includes requested scripts');
const noScripts = await value('select tutor_conference($1::text[], false)', [[a]]);
check(noScripts[0].stories.every(s => s.script === null), 'scripts excluded when not requested');
await denied('select tutor_conference($1::text[], true)', [[a,b]], 'mixed authorised and unauthorised report is rejected');
await denied('select conference_snapshot($1::text[], true)', [[b]], 'tutor cannot call private report helper');
await db.query('select tutor_set_pitch_note($1, $2)', [pitch, 'Check the figures']);
check((await value('select tutor_conference($1::text[], false)', [[a]]))[0].pitches[0].ep_note === 'Check the figures', 'tutor can add EP note');
for (const [sql, params, name] of [
  ['select * from admin_newsrooms()', [], 'admin overview'],
  ['select * from admin_tutors()', [], 'staff list'],
  ['select start_conference($1)', [a], 'conference reset'],
  ['select clear_producer($1)', [a], 'producer reset'],
  ['select delete_newsroom($1)', [a], 'newsroom deletion'],
  ['select remove_newsroom_members($1)', [a], 'member removal'],
  ['select rename_newsroom($1, $2)', [a, 'Changed'], 'room rename'],
  ['select set_newsroom_code($1)', [a], 'main code rotation'],
  ['select set_tutor_join_code($1)', [a], 'tutor code rotation'],
  ['select set_tutor_access($1, $2::text[])', ['other@example.test', [b]], 'granting staff access'],
  ['select remove_tutor($1)', [tutor], 'removing tutors'],
  ['select set_cuez_target($1, null, null, null, null)', [a], 'Cuez target change'],
  ['select pick_pitch($1)', [pitch], 'producer decision'],
]) await denied(sql, params, `tutor cannot perform ${name}`);

await asUser(admin);
await db.query('select start_conference($1)', [a]);
await asUser(tutor);
await denied('select tutor_set_pitch_note($1, $2)', [pitch, 'Old conference'], 'tutor cannot change archived pitch note');
await asUser(admin);
await db.query('select set_tutor_access($1, $2::text[])', ['tutor@example.test', [b]]);
await asUser(tutor);
await denied('select get_tutor_join_code($1)', [a], 'removing assignment immediately blocks code retrieval');
await denied('select tutor_conference($1::text[], false)', [[a]], 'removing assignment immediately blocks reports');
check((await db.query('select * from tutor_newsrooms()')).rows[0].newsroom_id === b, 'new assignment replaces previous list');
await asUser(admin);
const rotated = await value('select set_tutor_join_code($1)', [b]);
await asUser(outsider);
check((await db.query('select * from join_newsroom($1)', [codeB])).rows.length === 0, 'rotating tutor code rejects previous code');
check((await db.query('select * from join_newsroom($1)', [rotated])).rows[0].newsroom_id === b, 'rotated tutor code accepts new joins');
await asUser(admin);
await db.query('select set_newsroom_code($1, $2, true)', [b, 'NEWMAIN123']);
check(await value('select get_tutor_join_code($1)', [b]) === null, 'main code rotation disables tutor code');
await asUser(outsider);
check((await db.query('select * from join_newsroom($1)', [rotated])).rows.length === 0, 'disabled tutor code cannot rejoin after removal');
check((await db.query('select * from join_newsroom($1)', ['NEWMAIN123'])).rows[0].newsroom_id === b, 'main code still works');
await asUser(admin);
await db.query('select remove_tutor($1)', [tutor]);
await asUser(tutor);
await denied('select * from tutor_newsrooms()', [], 'removing tutor revokes staff view');
await denied('select tutor_conference($1::text[], false)', [[b]], 'removing tutor revokes reports');
await asUser(null, 'anon');
await denied('select get_tutor_join_code($1)', [a], 'unauthenticated visitor cannot call code RPC');
await denied('select * from tutor_newsrooms()', [], 'unauthenticated visitor cannot list rooms');
console.log(`${passed} permission and lifecycle checks passed; ${process.env.MOIRA_BASELINE_SCHEMA ? 'previous schema upgraded' : 'full schema rerun'} and migration rerun successfully.`);
await db.close();
