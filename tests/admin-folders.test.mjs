// Run with MOIRA_PGLITE_MODULE pointing to an external PGlite installation.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { PGlite } = await import(process.env.MOIRA_PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
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
const schema = await readFile(new URL('../supabase-schema.sql', import.meta.url), 'utf8');
const baseline = process.env.MOIRA_BASELINE_SCHEMA ? await readFile(process.env.MOIRA_BASELINE_SCHEMA, 'utf8') : schema;
await db.exec(baseline.replace('create extension if not exists pgcrypto;', ''));
const migration = await readFile(new URL('../supabase/migrations/20261023_admin_folders.sql', import.meta.url), 'utf8');
await db.exec(migration); await db.exec(migration);
const admin = '00000000-0000-0000-0000-000000000001';
const other = '00000000-0000-0000-0000-000000000002';
const tutor = '00000000-0000-0000-0000-000000000003';
const student = '00000000-0000-0000-0000-000000000004';
await db.exec(`insert into auth.users(id, email, email_confirmed_at, is_anonymous) values
 ('${admin}', 'admin@example.test', now(), false), ('${other}', 'other@example.test', now(), false),
 ('${tutor}', 'tutor@example.test', now(), false), ('${student}', null, null, true);
 insert into admins(user_id) values ('${admin}'), ('${other}');`);
async function asUser(id, role = 'authenticated') {
  await db.exec('set session authorization postgres');
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id || '']);
  await db.exec(`set session authorization ${role}`);
}
async function value(sql, params = []) { return Object.values((await db.query(sql, params)).rows[0])[0]; }
const folders = () => value('select get_admin_folders()');
const move = (ids, id) => db.query('select move_admin_newsrooms($1, $2)', [ids, id]);
await asUser(admin);
const a = (await db.query("select * from create_newsroom('Folder A', 'FOLDERA1')")).rows[0].newsroom_id;
const b = (await db.query("select * from create_newsroom('Folder B', 'FOLDERB1')")).rows[0].newsroom_id;
await db.query('select set_tutor_access($1, $2)', ['tutor@example.test', [a]]);
const one = await value('select save_admin_folder($1)', ['  Autumn 2026  ']);
const two = await value('select save_admin_folder($1)', ['Archive']);
await assert.rejects(() => value('select save_admin_folder($1)', ['autumn 2026']), /already/);
for (const name of ['', '   ', 'x'.repeat(61)]) await assert.rejects(() => value('select save_admin_folder($1)', [name]));
await move([a, a, b], one);
assert.deepEqual((await folders()).find(f => f.id === one).newsroom_ids, [a,b]);
await assert.rejects(() => move([a, 'missing'], two), /no longer/);
await assert.rejects(() => move([null], two));
await assert.rejects(() => move([], two));
assert.deepEqual((await folders()).find(f => f.id === one).newsroom_ids, [a,b], 'invalid bulk moves are atomic');
await value('select save_admin_folder($1, $2)', ['Year 2', one]);
await asUser(other);
assert.deepEqual(await folders(), []);
const otherFolder = await value('select save_admin_folder($1)', ['Year 2']);
for (const action of [() => value('select save_admin_folder($1, $2)', ['Hijacked', one]),
  () => move([a], one), () => value('select delete_admin_folder($1)', [one])]) await assert.rejects(action, /unavailable/);
await move([a], otherFolder);
await asUser(admin);
assert.deepEqual((await folders()).find(f => f.id === one).newsroom_ids, [a,b]);
await assert.rejects(() => db.query('select * from admin_folders'));
await assert.rejects(() => db.query('select * from admin_folder_newsrooms'));
for (const id of [tutor, student]) {
  await asUser(id);
  for (const [sql, params] of [['select get_admin_folders()', []], ['select save_admin_folder($1)', ['Secret']],
    ['select move_admin_newsrooms($1, $2)', [[a], one]], ['select delete_admin_folder($1)', [one]],
    ['select * from admin_folders', []], ['select * from admin_folder_newsrooms', []]]) {
    await assert.rejects(() => db.query(sql, params));
  }
}
await asUser(null, 'anon'); await assert.rejects(folders);
await asUser(tutor);
assert.equal((await db.query('select * from tutor_newsrooms()')).rows[0].newsroom_id, a);
await asUser(admin);
await move([b], null);
assert.deepEqual((await folders()).find(f => f.id === one).newsroom_ids, [a]);
const before = await db.query('select * from admin_newsrooms()');
await value('select delete_admin_folder($1)', [one]);
assert.deepEqual(await db.query('select * from admin_newsrooms()'), before, 'removing folders preserves newsroom data');
await asUser(other);
assert.deepEqual((await folders())[0].newsroom_ids, [a], 'another admin organisation is preserved');
await asUser(admin); await db.query('select delete_newsroom($1)', [a]);
await asUser(other); assert.deepEqual((await folders())[0].newsroom_ids, [], 'deleted newsrooms leave no stale assignments');
await db.exec('set session authorization postgres');
await db.exec(schema.replace('create extension if not exists pgcrypto;', ''));
console.log('PASS: folder lifecycle, validation, atomic moves, account isolation, staff/student denial, room preservation, cascading cleanup and repeatable migration/schema');
await db.close();
