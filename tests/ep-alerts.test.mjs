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
const migration = await readFile(new URL('../supabase/migrations/20261023_ep_broadcast_alert.sql', import.meta.url), 'utf8');
await db.exec(migration); await db.exec(migration);
const admin = '00000000-0000-0000-0000-000000000001';
const tutor = '00000000-0000-0000-0000-000000000002';
const student = '00000000-0000-0000-0000-000000000003';
await db.exec(`insert into auth.users(id,email,email_confirmed_at,is_anonymous) values
 ('${admin}', 'admin@example.test', now(), false), ('${tutor}', 'tutor@example.test', now(), false), ('${student}', null, null, true);
 insert into admins(user_id) values ('${admin}');`);
async function asUser(id, role = 'authenticated') {
 await db.exec('set session authorization postgres');
 await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id || '']);
 await db.exec(`set session authorization ${role}`);
}
const send = (ids, message) => db.query('select tutor_send_alert($1, $2)', [ids, message]);
async function snapshot() {
 await asUser(admin, 'postgres');
 return (await db.query('select id, ep_alert_text, ep_alert_at from bulletins order by id')).rows;
}
await asUser(admin);
const a = (await db.query("select * from create_newsroom('Alert A', 'ALERTA12')")).rows[0].newsroom_id;
const b = (await db.query("select * from create_newsroom('Alert B', 'ALERTB12')")).rows[0].newsroom_id;
const c = (await db.query("select * from create_newsroom('Alert C', 'ALERTC12')")).rows[0].newsroom_id;
await db.query('select set_tutor_access($1,$2)', ['tutor@example.test', [a,b]]);
await asUser(tutor);
await send([a,b,a], '  Everyone back in 5  ');
let rows = await snapshot();
assert.equal(rows.find(r => r.id === a).ep_alert_text, 'Everyone back in 5');
assert.equal(rows.find(r => r.id === a).ep_alert_at.getTime(), rows.find(r => r.id === b).ep_alert_at.getTime());
assert.equal(rows.find(r => r.id === c).ep_alert_text, null);
const before = rows;
await asUser(tutor);
for (const ids of [[a,c], [null], [], null, [a,'missing']]) await assert.rejects(() => send(ids, 'Denied'));
for (const msg of ['', '   ', null]) await assert.rejects(() => send([a], msg));
assert.deepEqual(await snapshot(), before, 'invalid recipients and messages leave all alerts untouched');
await asUser(student); await db.query("select * from join_newsroom('ALERTA12')");
assert.equal((await db.query('select ep_alert_text from bulletins where id=$1',[a])).rows[0].ep_alert_text, 'Everyone back in 5');
await assert.rejects(() => send([a], 'Student spoof'));
await assert.rejects(() => db.query('update bulletins set ep_alert_text=$1 where id=$2',['Spoof',a]));
await asUser(null,'anon'); await assert.rejects(() => send([a], 'Anon spoof'));
await asUser(admin); await send([a,c], 'x'.repeat(260));
rows = await snapshot();
assert.equal(rows.find(r => r.id === c).ep_alert_text.length,240);
assert.ok(rows.find(r => r.id === a).ep_alert_at > before.find(r => r.id === a).ep_alert_at);
await asUser(admin); await db.query('select set_tutor_access($1,$2)', ['tutor@example.test', [b]]);
await asUser(tutor); await assert.rejects(() => send([a,b], 'Revoked'));
await send([b], 'Still assigned');
await asUser(admin,'postgres'); await db.exec(schema.replace('create extension if not exists pgcrypto;', ''));
console.log('PASS: staff broadcasts, all-or-nothing recipient checks, revoked access, 240-character limit, blank rejection, student read-only delivery and repeatable migration/schema');
await db.close();
