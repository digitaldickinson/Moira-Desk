-- Moira:Desk schema for Supabase (Postgres)
--
-- A trimmed Moira:Rundown schema for an editorial desk that hands playout to
-- Cuez: no staff list, editor role, rundown lock or comms, plus columns that
-- record each newsroom's Cuez target and each story's Cuez item.
--
-- Run this in a Supabase project of its own (the one hosting the send-to-cuez
-- function), not in an existing Moira:Rundown project: the table names match,
-- and the column sets don't.
--
-- Every statement is idempotent, so it's safe to run again after an update.
--
-- ACCESS MODEL: newsroom join codes.
--   * Each browser signs in anonymously (Supabase gives it a hidden user id).
--   * A newsroom has a join code. Entering it calls join_newsroom(), which
--     records that user as a member of that newsroom.
--   * Row Level Security lets members read their own newsrooms only.
--     Non-members see nothing, so the project URL and anon key are safe to
--     publish in the page.
--   * Members can't write story rows or the running order directly. Every
--     change goes through a function below that checks membership and keeps
--     the safeguards on the server: revisions, who holds a lock, and Cuez send
--     state (written only by the send-to-cuez function). A modified page can
--     do no more than the real one.
--   * Newsrooms, codes and Cuez targets are managed by admins (admin.html or
--     the SQL Editor; see the ADMIN section at the bottom). Nothing a student
--     can call creates, lists or changes them.

create extension if not exists pgcrypto;

-- ==========================================================================
-- Tables
-- ==========================================================================

create table if not exists bulletins (
  id                  text primary key,              -- sanitized room id, e.g. 'bulletin-primary'
  order_ids           jsonb not null default '[]',   -- ordered story ids, includes 'marker-line'
  formats             jsonb not null default '["READ","WRAP","CLIP","OOV","ULAY","OOV/CLIP","ULAY/CLIP","OVO","LIVE"]',
  target_duration     integer,                       -- seconds; null = no target
  cuez_episode_id     text,                          -- Cuez episode this newsroom sends to
  cuez_episode_title  text,
  cuez_part_uid       text,                          -- part within that episode
  cuez_part_title     text,
  ep_alert_text       text,
  ep_alert_at         timestamptz,
  cuez_sending_at     timestamptz,                   -- set while a send is in progress
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table if not exists stories (
  id                 uuid primary key default gen_random_uuid(),
  bulletin_id        text not null references bulletins(id) on delete cascade,
  slug               text not null default '',
  script             text not null default '',
  format             text not null default '',
  presenter          text not null default '',      -- free-text names
  reporter           text not null default '',
  duration           integer not null default 0,
  completed          text,                          -- null | 'needs-checking' | 'checked-ok' | 'checked-needs-work'
  is_floated         boolean not null default false,
  type               text,                          -- null | 'segment'
  locked_by_session  text,
  locked_by_name     text,
  locked_at          bigint,
  rev                integer not null default 1,
  cuez_item_uid      text,                          -- set once the story is in Cuez
  cuez_sent_at       timestamptz,
  cuez_sent_rev      integer                        -- rev that was sent; rev > this = changed since
);
create index if not exists stories_bulletin_id_idx on stories(bulletin_id);

-- Added after the first release, hence the alters.
alter table bulletins add column if not exists name text;
alter table bulletins add column if not exists cuez_read_speed integer;   -- wpm Cuez times the prompter at
alter table stories   add column if not exists cuez_item_number text;     -- Cuez's item number, as of the last send
-- Recorded just before each send writes to Cuez, so a retry after an uncertain
-- outcome can find the item instead of creating a duplicate.
alter table stories   add column if not exists cuez_pending_uid text;
alter table stories   add column if not exists cuez_pending_at  timestamptz;
alter table stories   add column if not exists cuez_pending_rev integer;
alter table stories   add column if not exists cuez_pending_plan jsonb;  -- exactly what an unconfirmed send wrote, so a retry repeats it
-- The signed-in user holding the lock. locked_by_session is only the browser/tab
-- label the page shows; this is what the server checks.
alter table stories   add column if not exists locked_by_user uuid;

-- Deleted stories, kept server-side for a day so Undo restores the real row
-- (Cuez link included) rather than whatever a browser sends back.
create table if not exists deleted_stories (
  id           uuid primary key,
  bulletin_id  text not null references bulletins(id) on delete cascade,
  row_data     jsonb not null,
  deleted_at   timestamptz not null default now()
);

-- News conference: each newsroom has a current conference (a fresh one each
-- session, started from admin) with its pitches, and a producer who runs it.
-- The producer is whichever browser claimed the role; only they can pick or
-- spike pitches and, once claimed, send to Cuez. Starting a new conference
-- frees the role.
alter table bulletins add column if not exists producer_user          uuid;
alter table bulletins add column if not exists producer_name          text;
alter table bulletins add column if not exists producer_since         timestamptz;
alter table bulletins add column if not exists conference_id          uuid;
alter table bulletins add column if not exists conference_started_at  timestamptz;

create table if not exists pitches (
  id             uuid primary key default gen_random_uuid(),
  bulletin_id    text not null references bulletins(id) on delete cascade,
  conference_id  uuid not null,
  slug           text not null,
  angle          text not null default '',
  format         text not null default '',
  pitched_by     text not null default '',
  created_by     uuid,
  status         text not null default 'pitched',   -- 'pitched' | 'picked' | 'spiked'
  spike_reason   text,
  ep_note        text,                             -- the EP's comment, from admin
  story_id       uuid,                             -- the story it became, once picked
  position       integer not null default 0,
  created_at     timestamptz not null default now(),
  decided_at     timestamptz
);
create index if not exists pitches_conference_idx on pitches(bulletin_id, conference_id, position);

-- A story picked from conference keeps its pitch, shown in the editor and
-- never sent to Cuez.
alter table stories add column if not exists brief       text;
alter table stories add column if not exists pitched_by  text;
alter table stories add column if not exists pitch_id    uuid;

-- One join code per newsroom, stored only as a hash.
create table if not exists newsroom_codes (
  bulletin_id  text primary key references bulletins(id) on delete cascade,
  code_hash    text not null unique,
  updated_at   timestamptz not null default now()
);

-- Optional second student join code, retrievable by assigned staff only.
-- Never return this table through the public API or Realtime.
create table if not exists tutor_join_codes (
  bulletin_id text primary key references bulletins(id) on delete cascade,
  join_code text not null,
  code_hash text not null unique,
  updated_at timestamptz not null default now()
);
alter table tutor_join_codes enable row level security;
revoke all on tutor_join_codes from public, anon, authenticated;

-- Which (anonymous) users belong to which newsrooms.
create table if not exists newsroom_members (
  user_id      uuid not null,
  bulletin_id  text not null references bulletins(id) on delete cascade,
  joined_at    timestamptz not null default now(),
  primary key (user_id, bulletin_id)
);

-- Wrong-code attempts, for rate limiting guesses.
create table if not exists join_attempts (
  user_id  uuid not null,
  at       timestamptz not null default now()
);
create index if not exists join_attempts_user_idx on join_attempts(user_id, at);
create index if not exists join_attempts_at_idx   on join_attempts(at);

-- ==========================================================================
-- Row Level Security: members only
-- ==========================================================================

-- Security definer so policies can check membership without recursing.
create or replace function is_member(p_bulletin_id text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from newsroom_members m
    where m.user_id = auth.uid() and m.bulletin_id = p_bulletin_id
  );
$$;

alter table bulletins        enable row level security;
alter table stories          enable row level security;
alter table newsroom_codes   enable row level security;
alter table newsroom_members enable row level security;
alter table join_attempts    enable row level security;
alter table deleted_stories  enable row level security;
alter table pitches          enable row level security;

-- Remove the old open policies from the first release.
drop policy if exists open_all on bulletins;
drop policy if exists open_all on stories;
drop policy if exists members_read   on bulletins;
drop policy if exists members_update on bulletins;
drop policy if exists members_all    on stories;
drop policy if exists own_rows       on newsroom_members;
drop policy if exists members_read   on stories;
drop policy if exists members_read   on pitches;

-- Bulletins: members can read theirs, and change formats and target duration
-- (see the grant below). Nobody can create or delete them from the browser.
create policy members_read   on bulletins for select using (is_member(id));
create policy members_update on bulletins for update using (is_member(id)) with check (is_member(id));
-- Stories: members can read theirs. All writes go through the functions below.
create policy members_read   on stories for select using (is_member(bulletin_id));
-- Pitches: members can read their newsroom's. All writes go through functions.
create policy members_read   on pitches for select using (is_member(bulletin_id));
-- Memberships: you can see your own; rows are only added by join_newsroom().
create policy own_rows       on newsroom_members for select using (user_id = auth.uid());
-- newsroom_codes, join_attempts and deleted_stories have no policies: unreadable from the browser.

revoke all on bulletins, stories, newsroom_codes, newsroom_members, join_attempts, deleted_stories, pitches from anon, authenticated;
grant select                         on bulletins        to authenticated;
-- Directly, members may only change formats and target duration. The running
-- order changes through create/delete/restore/move_story; the Cuez target and
-- send state are staff-only (see set_cuez_target).
grant update (formats, target_duration, updated_at) on bulletins to authenticated;
grant select                         on stories          to authenticated;
grant select                         on newsroom_members to authenticated;
grant select                         on pitches          to authenticated;

-- ==========================================================================
-- Realtime
-- ==========================================================================

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'bulletins'
  ) then
    alter publication supabase_realtime add table bulletins;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'stories'
  ) then
    alter publication supabase_realtime add table stories;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'pitches'
  ) then
    alter publication supabase_realtime add table pitches;
  end if;
end $$;

-- ==========================================================================
-- RPC functions
-- ==========================================================================

-- The story functions run as the table owner (members have no direct write
-- access), so each one checks membership itself before doing anything.

-- Rooms are no longer created from the browser (see create_newsroom).
drop function if exists seed_bulletin(text, text, uuid);

-- Normalises a code (case, spaces and dashes ignored) and hashes it.
create or replace function code_hash(p_code text)
returns text language sql immutable as $$
  select encode(sha256(convert_to(regexp_replace(upper(coalesce(p_code, '')), '[^A-Z0-9]', '', 'g'), 'UTF8')), 'hex');
$$;

-- Newsrooms this browser has joined.
create or replace function my_newsrooms()
returns table (newsroom_id text, newsroom_name text)
language sql stable set search_path = public as $$
  select b.id, coalesce(b.name, b.id) from bulletins b
  where is_member(b.id)
  order by coalesce(b.name, b.id);
$$;

-- Join a newsroom by code. Returns the newsroom, or no rows if the code is
-- wrong. Wrong guesses are limited two ways:
--   * per browser: 8 in 10 minutes locks that anonymous user out for a while
--   * overall: if wrong guesses across everyone pass 300 in 10 minutes, joining
--     pauses for everyone. That stops someone cycling through fresh anonymous
--     identities. A class making typos won't get near it; existing members are
--     unaffected, as they don't need to join.
-- The checks and the recording of a wrong guess happen under one lock, so
-- simultaneous requests can't all slip under a limit.
create or replace function join_newsroom(p_code text)
returns table (newsroom_id text, newsroom_name text)
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_bid text;
begin
  if v_uid is null then
    raise exception 'Not signed in';
  end if;
  perform pg_advisory_xact_lock(hashtext('moira-desk:join_newsroom'));

  delete from join_attempts where at < now() - interval '1 day';
  if (select count(*) from join_attempts j where j.user_id = v_uid and j.at > now() - interval '10 minutes') >= 8 then
    raise exception 'Too many wrong codes. Wait ten minutes and try again.';
  end if;
  if (select count(*) from join_attempts j where j.at > now() - interval '10 minutes') >= 300 then
    raise exception 'Joining is paused for a few minutes because of too many wrong codes. Try again shortly.';
  end if;

  select c.bulletin_id into v_bid from newsroom_codes c where c.code_hash = code_hash(p_code);
  if v_bid is null then
    select c.bulletin_id into v_bid from tutor_join_codes c where c.code_hash = code_hash(p_code);
  end if;
  if v_bid is null then
    insert into join_attempts (user_id) values (v_uid);
    return;  -- no rows: not recognised (returning, not raising, keeps the attempt recorded)
  end if;

  insert into newsroom_members (user_id, bulletin_id) values (v_uid, v_bid) on conflict do nothing;
  delete from join_attempts j where j.user_id = v_uid;
  return query select b.id, coalesce(b.name, b.id) from bulletins b where b.id = v_bid;
end;
$$;

-- Earlier signatures that trusted the browser's clock or story data.
drop function if exists lock_story(uuid, text, text, bigint, bigint);
drop function if exists take_lock(uuid, text, text, bigint, bigint);
drop function if exists restore_story(text, uuid, jsonb, int);

-- Server time in milliseconds, and how long an unrefreshed lock lasts
-- (the page refreshes its lock every 20 seconds while the editor is open).
create or replace function now_ms()
returns bigint language sql volatile as $$
  select (extract(epoch from clock_timestamp()) * 1000)::bigint;
$$;
create or replace function lock_stale_ms()
returns bigint language sql immutable as $$ select 45000::bigint; $$;

-- A story the caller may change, locked for the rest of the transaction.
-- "Story missing" for non-members too, so it reveals nothing.
create or replace function member_story(p_story_id uuid)
returns stories language plpgsql security definer set search_path = public as $$
declare
  v stories;
begin
  select * into v from stories where id = p_story_id for update;
  if not found or not is_member(v.bulletin_id) then
    raise exception 'Story missing';
  end if;
  return v;
end;
$$;

-- True if someone else holds a live lock on the story.
create or replace function locked_by_other(v stories)
returns boolean language sql stable set search_path = public as $$
  select v.locked_by_session is not null
     and v.locked_at is not null
     and now_ms() - v.locked_at <= lock_stale_ms()
     and v.locked_by_user is distinct from auth.uid();
$$;

create or replace function check_story_values(p_completed text, p_type text)
returns void language plpgsql immutable as $$
begin
  if p_completed is not null and p_completed not in ('needs-checking', 'checked-ok', 'checked-needs-work') then
    raise exception 'Unknown status %.', p_completed;
  end if;
  if p_type is not null and p_type <> 'segment' then
    raise exception 'Unknown story type %.', p_type;
  end if;
end;
$$;

-- Insert a story and splice its id into order_ids just before 'marker-line'.
-- New stories always start at revision 1, unlocked and not sent.
create or replace function create_story(p_bulletin_id text, p_story_id uuid, p_story jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_order text[];
  v_marker_idx int;
  v_id_text text := p_story_id::text;
begin
  if not is_member(p_bulletin_id) then
    raise exception 'Bulletin missing';
  end if;
  select array(select jsonb_array_elements_text(order_ids)) into v_order
  from bulletins where id = p_bulletin_id for update;
  if v_order is null then
    raise exception 'Bulletin missing';
  end if;
  perform check_story_values(p_story->>'completed', p_story->>'type');

  insert into stories (id, bulletin_id, slug, script, format, presenter, reporter, duration, completed, is_floated, type, rev)
  values (
    p_story_id, p_bulletin_id,
    coalesce(p_story->>'slug', ''), coalesce(p_story->>'script', ''), coalesce(p_story->>'format', ''),
    coalesce(p_story->>'presenter', ''), coalesce(p_story->>'reporter', ''),
    coalesce((p_story->>'duration')::int, 0), p_story->>'completed',
    coalesce((p_story->>'is_floated')::boolean, false), p_story->>'type', 1
  );

  v_marker_idx := array_position(v_order, 'marker-line');
  if v_marker_idx is not null then
    v_order := v_order[1:v_marker_idx-1] || v_id_text || v_order[v_marker_idx:];
  else
    v_order := v_order || v_id_text || 'marker-line';
  end if;
  update bulletins set order_ids = to_jsonb(v_order), updated_at = now() where id = p_bulletin_id;
end;
$$;

-- Delete a story and remove its id from order_ids, keeping a server copy for a
-- day so it can be restored. (Its Cuez item, if any, stays in Cuez.)
create or replace function delete_story(p_bulletin_id text, p_story_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_order text[];
  v stories;
begin
  if not is_member(p_bulletin_id) then return; end if;
  select array(select jsonb_array_elements_text(order_ids)) into v_order
  from bulletins where id = p_bulletin_id for update;
  if v_order is null then return; end if;

  delete from deleted_stories where deleted_at < now() - interval '1 day';
  select * into v from stories where id = p_story_id and bulletin_id = p_bulletin_id for update;
  if found then
    insert into deleted_stories (id, bulletin_id, row_data) values (v.id, v.bulletin_id, to_jsonb(v))
    on conflict (id) do update set row_data = excluded.row_data, deleted_at = now();
    delete from stories where id = p_story_id;
  end if;
  v_order := array_remove(v_order, p_story_id::text);
  update bulletins set order_ids = to_jsonb(v_order), updated_at = now() where id = p_bulletin_id;
end;
$$;

-- Put a deleted story back at p_insert_at, exactly as the server kept it
-- (Cuez link included), unlocked.
create or replace function restore_story(p_bulletin_id text, p_story_id uuid, p_insert_at int)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_order text[];
  v_pos int;
  v_data jsonb;
begin
  if not is_member(p_bulletin_id) then
    raise exception 'Bulletin missing';
  end if;
  select array(select jsonb_array_elements_text(order_ids)) into v_order
  from bulletins where id = p_bulletin_id for update;
  if v_order is null then
    raise exception 'Bulletin missing';
  end if;
  select d.row_data into v_data from deleted_stories d
  where d.id = p_story_id and d.bulletin_id = p_bulletin_id for update;
  if v_data is null then
    raise exception 'That story can no longer be restored.';
  end if;

  insert into stories select (jsonb_populate_record(null::stories, v_data)).*;
  update stories set locked_by_session = null, locked_by_name = null, locked_at = null, locked_by_user = null
  where id = p_story_id;
  delete from deleted_stories where id = p_story_id;

  v_pos := least(p_insert_at, coalesce(array_length(v_order, 1), 0));
  if v_pos is null or v_pos < 0 then v_pos := 0; end if;
  v_order := array_remove(v_order, p_story_id::text);
  v_order := v_order[1:v_pos] || p_story_id::text || v_order[v_pos+1:];
  update bulletins set order_ids = to_jsonb(v_order), updated_at = now() where id = p_bulletin_id;
end;
$$;

-- Optimistic-concurrency save: applies only if p_expected_rev matches, otherwise
-- returns the server row for the conflict prompt. Absent keys keep their value.
-- The revision is the server's; a live lock held by someone else blocks it.
create or replace function save_story(p_story_id uuid, p_data jsonb, p_expected_rev int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_row stories;
begin
  v_row := member_story(p_story_id);
  if v_row.rev <> p_expected_rev then
    return jsonb_build_object('status', 'conflict', 'server', to_jsonb(v_row));
  end if;
  if locked_by_other(v_row) then
    raise exception '% is editing this story now. Copy your text somewhere safe, then try again when they''ve finished.', coalesce(v_row.locked_by_name, 'Someone else');
  end if;
  perform check_story_values(coalesce(p_data->>'completed', v_row.completed), coalesce(p_data->>'type', v_row.type));

  update stories set
    slug = coalesce(p_data->>'slug', slug),
    script = coalesce(p_data->>'script', script),
    format = coalesce(p_data->>'format', format),
    presenter = coalesce(p_data->>'presenter', presenter),
    reporter = coalesce(p_data->>'reporter', reporter),
    duration = coalesce((p_data->>'duration')::int, duration),
    completed = coalesce(p_data->>'completed', completed),
    is_floated = coalesce((p_data->>'is_floated')::boolean, is_floated),
    type = coalesce(p_data->>'type', type),
    rev = v_row.rev + 1,
    locked_by_session = null, locked_by_name = null, locked_at = null, locked_by_user = null
  where id = p_story_id;

  return jsonb_build_object('status', 'ok');
end;
$$;

-- Move a row in the running order, atomically: the bulletin row is locked,
-- so concurrent adds, deletes and moves can't overwrite each other.
-- p_before_id null (or not found) moves it to the end.
create or replace function move_story(p_bulletin_id text, p_story_id text, p_before_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_order text[];
  v_idx int;
begin
  if not is_member(p_bulletin_id) then
    raise exception 'Bulletin missing';
  end if;
  select array(select jsonb_array_elements_text(order_ids)) into v_order
  from bulletins where id = p_bulletin_id for update;
  if v_order is null then
    raise exception 'Bulletin missing';
  end if;
  if array_position(v_order, p_story_id) is null then
    raise exception 'That item is no longer in the running order.';
  end if;
  v_order := array_remove(v_order, p_story_id);
  v_idx := case when p_before_id is null then null else array_position(v_order, p_before_id) end;
  if v_idx is null then
    v_order := v_order || p_story_id;
  else
    v_order := v_order[1:v_idx - 1] || p_story_id || v_order[v_idx:];
  end if;
  update bulletins set order_ids = to_jsonb(v_order), updated_at = now() where id = p_bulletin_id;
  return to_jsonb(v_order);
end;
$$;

-- Take the lock if it's free or has gone stale. The server records who holds
-- it and when, by its own clock.
create or replace function lock_story(p_story_id uuid, p_session_id text, p_user_name text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_row stories;
begin
  v_row := member_story(p_story_id);
  -- Free, stale, or already this exact tab's. Another tab of the same browser
  -- uses take_lock ("Edit here") instead, so a second tab never steals silently.
  if v_row.locked_by_session is null
     or v_row.locked_at is null
     or now_ms() - v_row.locked_at > lock_stale_ms()
     or (v_row.locked_by_session = p_session_id and v_row.locked_by_user is not distinct from auth.uid()) then
    update stories set locked_by_session = left(p_session_id, 100), locked_by_name = left(p_user_name, 60),
                       locked_at = now_ms(), locked_by_user = auth.uid()
    where id = p_story_id;
  end if;
end;
$$;

-- Force-acquire a lock ("Edit here" / take over). Allowed if the lock is free,
-- stale, or held by this same signed-in browser (another tab, or a page
-- reloaded mid-edit). Otherwise raises.
create or replace function take_lock(p_story_id uuid, p_session_id text, p_user_name text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_row stories;
begin
  v_row := member_story(p_story_id);
  if locked_by_other(v_row) then
    raise exception 'Lock held by another session';
  end if;
  update stories set locked_by_session = left(p_session_id, 100), locked_by_name = left(p_user_name, 60),
                     locked_at = now_ms(), locked_by_user = auth.uid()
  where id = p_story_id;
end;
$$;

-- Heartbeat: only the holder can keep a lock alive. Returns false if it's gone.
create or replace function renew_lock(p_story_id uuid, p_session_id text)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_row stories;
begin
  v_row := member_story(p_story_id);
  if v_row.locked_by_user is distinct from auth.uid() or v_row.locked_by_session is distinct from p_session_id then
    return false;
  end if;
  update stories set locked_at = now_ms() where id = p_story_id;
  return true;
end;
$$;

-- Release a lock: only the holder can.
create or replace function unlock_story(p_story_id uuid, p_session_id text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_row stories;
begin
  v_row := member_story(p_story_id);
  if v_row.locked_by_user is not distinct from auth.uid() and v_row.locked_by_session = p_session_id then
    update stories set locked_by_session = null, locked_by_name = null, locked_at = null, locked_by_user = null
    where id = p_story_id;
  end if;
end;
$$;

-- Save just the slug (inline edit) and release the lock.
create or replace function save_slug(p_story_id uuid, p_slug text, p_session_id text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_row stories;
begin
  v_row := member_story(p_story_id);
  if locked_by_other(v_row) then
    raise exception 'Lock mismatch';
  end if;
  update stories set slug = coalesce(p_slug, ''), rev = v_row.rev + 1,
    locked_by_session = null, locked_by_name = null, locked_at = null, locked_by_user = null
  where id = p_story_id;
end;
$$;

-- Row toggles that don't change the script, so they don't bump the revision
-- (someone editing the story isn't pushed into a conflict).
create or replace function set_story_status(p_story_id uuid, p_completed text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform member_story(p_story_id);
  perform check_story_values(p_completed, null);
  update stories set completed = p_completed where id = p_story_id;
end;
$$;

create or replace function set_story_floated(p_story_id uuid, p_floated boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform member_story(p_story_id);
  update stories set is_floated = coalesce(p_floated, false) where id = p_story_id;
end;
$$;

-- "Mark as not sent": the one change members can make to Cuez send state, and
-- it can only clear it. Setting it is the send-to-cuez function's job.
create or replace function mark_story_not_sent(p_story_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform member_story(p_story_id);
  update stories set cuez_item_uid = null, cuez_sent_at = null, cuez_sent_rev = null, cuez_item_number = null,
                     cuez_pending_uid = null, cuez_pending_at = null, cuez_pending_rev = null, cuez_pending_plan = null
  where id = p_story_id;
end;
$$;

-- ==========================================================================
-- News conference
-- ==========================================================================

-- The newsroom's current conference, starting one if there isn't one yet.
create or replace function current_conference(p_bulletin_id text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v uuid;
begin
  select conference_id into v from bulletins where id = p_bulletin_id for update;
  if v is null then
    v := gen_random_uuid();
    update bulletins set conference_id = v, conference_started_at = now() where id = p_bulletin_id;
  end if;
  return v;
end;
$$;

create or replace function require_producer(p_bulletin_id text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_user uuid;
begin
  if not is_member(p_bulletin_id) then
    raise exception 'Bulletin missing';
  end if;
  select producer_user into v_user from bulletins where id = p_bulletin_id;
  if v_user is null then
    raise exception 'Nobody is producer yet. Claim the role first.';
  end if;
  if v_user <> auth.uid() then
    raise exception 'Only the producer can do that.';
  end if;
end;
$$;

-- A pitch the caller may act on, locked for the rest of the transaction.
create or replace function member_pitch(p_pitch_id uuid)
returns pitches language plpgsql security definer set search_path = public as $$
declare
  v pitches;
begin
  select * into v from pitches where id = p_pitch_id for update;
  if not found or not is_member(v.bulletin_id) then
    raise exception 'Pitch missing';
  end if;
  -- Earlier conferences are the record: read-only.
  if not exists (select 1 from bulletins b where b.id = v.bulletin_id and b.conference_id = v.conference_id) then
    raise exception 'That pitch is from an earlier conference, so it can''t be changed.';
  end if;
  return v;
end;
$$;

-- Claim the producer role (the queen of hearts). Fails if someone else holds it.
create or replace function claim_producer(p_bulletin_id text, p_name text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v bulletins;
begin
  if not is_member(p_bulletin_id) then
    raise exception 'Bulletin missing';
  end if;
  select * into v from bulletins where id = p_bulletin_id for update;
  -- A producer who is no longer a member (removed, or the code changed) doesn't
  -- hold the role any more, so it can be claimed.
  if v.producer_user is not null and v.producer_user <> auth.uid()
     and exists (select 1 from newsroom_members m where m.bulletin_id = p_bulletin_id and m.user_id = v.producer_user) then
    raise exception '% is already the producer.', coalesce(v.producer_name, 'Someone');
  end if;
  update bulletins set producer_user = auth.uid(), producer_name = left(coalesce(nullif(trim(p_name), ''), 'Producer'), 60),
                       producer_since = coalesce(case when v.producer_user = auth.uid() then v.producer_since end, now())
  where id = p_bulletin_id;
end;
$$;

-- Whenever a membership goes (a code change that removes members, "Remove
-- members", or by hand), a producer who was that member loses the role, so the
-- newsroom isn't left with a producer nobody can reach.
create or replace function release_removed_producer()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update bulletins set producer_user = null, producer_name = null, producer_since = null
  where id = old.bulletin_id and producer_user = old.user_id;
  return null;
end;
$$;
drop trigger if exists newsroom_members_release_producer on newsroom_members;
create trigger newsroom_members_release_producer after delete on newsroom_members
  for each row execute function release_removed_producer();

-- Step down, so someone else can claim it.
create or replace function release_producer(p_bulletin_id text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform require_producer(p_bulletin_id);
  update bulletins set producer_user = null, producer_name = null, producer_since = null where id = p_bulletin_id;
end;
$$;

-- Anyone in the newsroom can pitch (usually the producer types them in).
create or replace function add_pitch(p_bulletin_id text, p_slug text, p_angle text, p_format text, p_pitched_by text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_conf uuid;
  v_id uuid := gen_random_uuid();
begin
  if not is_member(p_bulletin_id) then
    raise exception 'Bulletin missing';
  end if;
  if coalesce(trim(p_slug), '') = '' then
    raise exception 'Give the pitch a slug.';
  end if;
  v_conf := current_conference(p_bulletin_id);
  insert into pitches (id, bulletin_id, conference_id, slug, angle, format, pitched_by, created_by, position)
  values (v_id, p_bulletin_id, v_conf, left(trim(p_slug), 80), left(coalesce(trim(p_angle), ''), 500),
          left(coalesce(trim(p_format), ''), 20), left(coalesce(trim(p_pitched_by), ''), 60), auth.uid(),
          coalesce((select max(position) + 1 from pitches where bulletin_id = p_bulletin_id and conference_id = v_conf), 0));
  return v_id;
end;
$$;

-- Edit or withdraw a pitch that hasn't been decided: its author or the producer.
create or replace function update_pitch(p_pitch_id uuid, p_slug text, p_angle text, p_format text, p_pitched_by text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v pitches;
  v_producer uuid;
begin
  v := member_pitch(p_pitch_id);
  select producer_user into v_producer from bulletins where id = v.bulletin_id;
  if v.created_by is distinct from auth.uid() and v_producer is distinct from auth.uid() then
    raise exception 'Only whoever added this pitch, or the producer, can change it.';
  end if;
  if v.status <> 'pitched' then
    raise exception 'This pitch has already been decided.';
  end if;
  if coalesce(trim(p_slug), '') = '' then
    raise exception 'Give the pitch a slug.';
  end if;
  update pitches set slug = left(trim(p_slug), 80), angle = left(coalesce(trim(p_angle), ''), 500),
                     format = left(coalesce(trim(p_format), ''), 20), pitched_by = left(coalesce(trim(p_pitched_by), ''), 60)
  where id = p_pitch_id;
end;
$$;

create or replace function delete_pitch(p_pitch_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v pitches;
  v_producer uuid;
begin
  v := member_pitch(p_pitch_id);
  select producer_user into v_producer from bulletins where id = v.bulletin_id;
  if v.created_by is distinct from auth.uid() and v_producer is distinct from auth.uid() then
    raise exception 'Only whoever added this pitch, or the producer, can remove it.';
  end if;
  if v.status <> 'pitched' then
    raise exception 'This pitch has already been decided.';
  end if;
  delete from pitches where id = p_pitch_id;
end;
$$;

-- Producer picks a pitch: it becomes a story at the end of the running order
-- (above END OF PROGRAMME), carrying the pitch as its brief.
create or replace function pick_pitch(p_pitch_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v pitches;
  v_story uuid := gen_random_uuid();
  v_order text[];
  v_idx int;
  v_format text;
begin
  v := member_pitch(p_pitch_id);
  perform require_producer(v.bulletin_id);
  if v.status = 'picked' then
    raise exception 'Already picked.';
  end if;
  select array(select jsonb_array_elements_text(order_ids)), coalesce(nullif(v.format, ''), formats->>0, 'READ')
    into v_order, v_format
  from bulletins where id = v.bulletin_id for update;

  insert into stories (id, bulletin_id, slug, format, reporter, duration, rev, brief, pitched_by, pitch_id)
  values (v_story, v.bulletin_id, upper(v.slug), v_format, left(coalesce(trim(v.pitched_by), ''), 60), 10, 1, nullif(v.angle, ''), nullif(v.pitched_by, ''), v.id);

  v_idx := array_position(v_order, 'marker-line');
  if v_idx is not null then
    v_order := v_order[1:v_idx-1] || v_story::text || v_order[v_idx:];
  else
    v_order := v_order || v_story::text || 'marker-line';
  end if;
  update bulletins set order_ids = to_jsonb(v_order), updated_at = now() where id = v.bulletin_id;
  update pitches set status = 'picked', story_id = v_story, spike_reason = null, decided_at = now() where id = p_pitch_id;
  return v_story;
end;
$$;

-- Undo a pick, removing its story, but only while nobody has written it yet
-- (and it hasn't gone to Cuez). A story deleted from the running order
-- already can always be un-picked.
create or replace function unpick_pitch(p_pitch_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v pitches;
  s stories;
begin
  v := member_pitch(p_pitch_id);
  perform require_producer(v.bulletin_id);
  if v.status <> 'picked' then
    raise exception 'This pitch isn''t picked.';
  end if;
  perform 1 from bulletins where id = v.bulletin_id for update;
  select * into s from stories where id = v.story_id for update;
  if found then
    if coalesce(s.script, '') <> '' or s.cuez_item_uid is not null or s.cuez_pending_uid is not null then
      raise exception '"%" has been worked on. Delete it from the running order first if you want to drop it.', s.slug;
    end if;
    -- Someone may be writing it right now with nothing saved yet: their text
    -- would be lost and their save would fail. Any live lock counts, even the
    -- producer's own in another tab.
    if s.locked_by_session is not null and s.locked_at is not null and now_ms() - s.locked_at <= lock_stale_ms() then
      raise exception '% is editing "%" right now, so it can''t be dropped. Try again when they''ve closed it.', coalesce(s.locked_by_name, 'Someone'), s.slug;
    end if;
    delete from stories where id = s.id;
    update bulletins set order_ids = to_jsonb(array_remove(array(select jsonb_array_elements_text(order_ids)), s.id::text)),
                         updated_at = now()
    where id = v.bulletin_id;
  end if;
  -- Drop also invalidates Undo for a story already deleted from the rundown.
  -- The bulletin lock serialises this with delete_story and restore_story.
  delete from deleted_stories where id = v.story_id and bulletin_id = v.bulletin_id;
  update pitches set status = 'pitched', story_id = null, decided_at = null where id = p_pitch_id;
end;
$$;

-- Producer decides how a picked story is covered: sets its format in the
-- running order. Refused while someone is editing it (they'd overwrite it on
-- save); the revision moves on, so a story already sent shows as changed.
create or replace function set_story_format(p_story_id uuid, p_format text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v stories;
begin
  v := member_story(p_story_id);
  perform require_producer(v.bulletin_id);
  if v.type = 'segment' then
    raise exception 'Segments don''t have a format.';
  end if;
  if locked_by_other(v) then
    raise exception '% is editing "%". Change the format in the editor instead.', coalesce(v.locked_by_name, 'Someone'), v.slug;
  end if;
  update stories set format = left(coalesce(trim(p_format), ''), 20), rev = v.rev + 1 where id = p_story_id;
end;
$$;

-- Assign directly from a picked pitch without opening the script editor.
create or replace function set_story_reporter(p_story_id uuid, p_reporter text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v stories;
  v_reporter text := coalesce(trim(p_reporter), '');
begin
  v := member_story(p_story_id);
  perform require_producer(v.bulletin_id);
  if not exists (
    select 1 from pitches p join bulletins b on b.id = p.bulletin_id
    where p.id = v.pitch_id and p.story_id = v.id and p.status = 'picked'
      and p.bulletin_id = v.bulletin_id and p.conference_id = b.conference_id
  ) then
    raise exception 'This story is not a picked pitch in the current conference.';
  end if;
  if length(v_reporter) > 60 then raise exception 'Reporter names must be 60 characters or fewer.'; end if;
  if v.reporter = v_reporter then return; end if;
  -- Even this producer may have an unsaved editor open in another tab.
  if v.locked_by_session is not null and v.locked_at is not null and now_ms() - v.locked_at <= lock_stale_ms() then
    raise exception '% is editing "%". Change the reporter in the editor instead.', coalesce(v.locked_by_name, 'Someone'), v.slug;
  end if;
  update stories set reporter = v_reporter, rev = v.rev + 1 where id = p_story_id;
end;
$$;

-- Producer spikes a pitch, optionally saying why (kept for the record).
-- Spiking an already spiked pitch just updates the reason.
create or replace function spike_pitch(p_pitch_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v pitches;
begin
  v := member_pitch(p_pitch_id);
  perform require_producer(v.bulletin_id);
  if v.status = 'picked' then
    raise exception 'Un-pick it first.';
  end if;
  update pitches set status = 'spiked', spike_reason = nullif(left(trim(coalesce(p_reason, '')), 300), ''),
                     decided_at = coalesce(v.decided_at, now())
  where id = p_pitch_id;
end;
$$;

create or replace function unspike_pitch(p_pitch_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v pitches;
begin
  v := member_pitch(p_pitch_id);
  perform require_producer(v.bulletin_id);
  if v.status = 'spiked' then
    update pitches set status = 'pitched', decided_at = null where id = p_pitch_id;
  end if;
end;
$$;

-- Claim the newsroom for a Cuez send (used by the send-to-cuez function only).
-- Returns false if another send started within p_stale_seconds.
create or replace function claim_cuez_send(p_bulletin_id text, p_stale_seconds int)
returns boolean language plpgsql as $$
declare
  v_count int;
begin
  update bulletins set cuez_sending_at = now()
  where id = p_bulletin_id
    and (cuez_sending_at is null or cuez_sending_at < now() - make_interval(secs => p_stale_seconds));
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

-- ==========================================================================
-- ADMIN
-- ==========================================================================
-- Admin actions are available two ways:
--   * admin.html, signed in with an email/password account listed in `admins`
--   * the SQL Editor (which runs as the database owner)
-- Nothing here is callable by students' anonymous sessions.
--
-- Make yourself an admin (once): create a user under Authentication → Users →
-- Add user (tick "Auto Confirm User"), then run:
--   insert into admins (user_id, email)
--   select id, email from auth.users where email = 'you@mmu.ac.uk';
--
-- SQL Editor equivalents of the admin page:
--   select * from create_newsroom('Newsday Blue');
--   select set_newsroom_code('bulletin-newsday-blue');            -- new code, removes members
--   select set_newsroom_code('bulletin-newsday-blue', null, false); -- new code, keeps members
--   select * from admin_newsrooms();

create table if not exists admins (
  user_id   uuid primary key,
  email     text,
  added_at  timestamptz not null default now()
);
alter table admins enable row level security;  -- no policies: unreadable from the browser
revoke all on admins from anon, authenticated;

create or replace function is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from admins a where a.user_id = auth.uid());
$$;

-- Raises unless the caller is a listed admin, or is the SQL Editor (no user,
-- connected directly as the database owner rather than through the API).
create or replace function require_admin()
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if is_admin() then return; end if;
  if auth.uid() is null and session_user in ('postgres', 'supabase_admin') then return; end if;
  raise exception 'Admins only.';
end;
$$;

-- Readable 8-character code from an alphabet without 0/O or 1/I/L.
create or replace function random_code()
returns text language plpgsql volatile as $$
declare
  v_alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_hex text := replace(gen_random_uuid()::text, '-', '');
  v_out text := '';
begin
  for i in 0..7 loop
    v_out := v_out || substr(v_alphabet, 1 + (('x' || substr(v_hex, i * 2 + 1, 2))::bit(8)::int % length(v_alphabet)), 1);
  end loop;
  return substr(v_out, 1, 4) || '-' || substr(v_out, 5, 4);
end;
$$;

create or replace function create_newsroom(p_name text, p_code text default null)
returns table (newsroom_id text, join_code text)
language plpgsql security definer set search_path = public as $$
declare
  v_id text := 'bulletin-' || trim(both '-' from regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', '-', 'g'));
  v_code text := coalesce(nullif(trim(p_code), ''), random_code());
  v_story uuid := gen_random_uuid();
begin
  perform require_admin();
  perform pg_advisory_xact_lock(hashtext('moira-desk:codes'));
  if v_id = 'bulletin-' then
    raise exception 'Give the newsroom a name.';
  end if;
  if exists (select 1 from bulletins b where b.id = v_id) then
    raise exception 'A newsroom with the id % already exists.', v_id;
  end if;
  if length(regexp_replace(upper(v_code), '[^A-Z0-9]', '', 'g')) < 6 then
    raise exception 'Codes need at least 6 letters or numbers.';
  end if;
  if exists (select 1 from newsroom_codes c where c.code_hash = code_hash(v_code)) or exists (select 1 from tutor_join_codes c where c.code_hash = code_hash(v_code)) then
    raise exception 'That code is already used by another newsroom.';
  end if;

  insert into bulletins (id, name, order_ids) values (v_id, trim(p_name), jsonb_build_array(v_story::text, 'marker-line'));
  insert into stories (id, bulletin_id, slug, script, format, duration)
  values (v_story, v_id, 'TOP STORY', 'Good evening. Welcome to the news from ' || trim(p_name) || '...', 'OVO', 30);
  insert into newsroom_codes (bulletin_id, code_hash) values (v_id, code_hash(v_code));
  return query select v_id, v_code;
end;
$$;

-- New code for a newsroom (also gives one to a newsroom created before codes existed).
create or replace function set_newsroom_code(p_newsroom_id text, p_code text default null, p_remove_members boolean default true)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_code text := coalesce(nullif(trim(p_code), ''), random_code());
begin
  perform require_admin();
  perform pg_advisory_xact_lock(hashtext('moira-desk:codes'));
  if not exists (select 1 from bulletins b where b.id = p_newsroom_id) then
    raise exception 'No newsroom with the id %.', p_newsroom_id;
  end if;
  if length(regexp_replace(upper(v_code), '[^A-Z0-9]', '', 'g')) < 6 then
    raise exception 'Codes need at least 6 letters or numbers.';
  end if;
  if exists (select 1 from newsroom_codes c where c.code_hash = code_hash(v_code) and c.bulletin_id <> p_newsroom_id) or exists (select 1 from tutor_join_codes c where c.code_hash = code_hash(v_code)) then
    raise exception 'That code is already used by another newsroom.';
  end if;
  insert into newsroom_codes (bulletin_id, code_hash, updated_at) values (p_newsroom_id, code_hash(v_code), now())
  on conflict (bulletin_id) do update set code_hash = excluded.code_hash, updated_at = now();
  -- Rotating the main code closes the tutor-code route too.
  delete from tutor_join_codes where bulletin_id = p_newsroom_id;
  if p_remove_members then
    delete from newsroom_members m where m.bulletin_id = p_newsroom_id;
  end if;
  return v_code;
end;
$$;

create or replace function rename_newsroom(p_newsroom_id text, p_name text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform require_admin();
  if coalesce(trim(p_name), '') = '' then raise exception 'Give the newsroom a name.'; end if;
  update bulletins set name = trim(p_name), updated_at = now() where id = p_newsroom_id;
  if not found then raise exception 'No newsroom with the id %.', p_newsroom_id; end if;
end;
$$;

-- Deletes the newsroom, its stories, code and memberships. Cuez is untouched.
create or replace function delete_newsroom(p_newsroom_id text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform require_admin();
  delete from bulletins where id = p_newsroom_id;
  if not found then raise exception 'No newsroom with the id %.', p_newsroom_id; end if;
end;
$$;

create or replace function remove_newsroom_members(p_newsroom_id text)
returns integer language plpgsql security definer set search_path = public as $$
declare v_count int;
begin
  perform require_admin();
  delete from newsroom_members where bulletin_id = p_newsroom_id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Point a newsroom at a Cuez episode and part (nulls clear it), recording the
-- template's prompter read speed. Optionally mark every story as not sent,
-- e.g. when moving to a new day's episode.
drop function if exists set_cuez_target(text, text, text, text, text, boolean);
create or replace function set_cuez_target(
  p_newsroom_id text, p_episode_id text, p_episode_title text,
  p_part_uid text, p_part_title text, p_clear_sent boolean default false,
  p_read_speed integer default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_uuid text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  perform require_admin();
  if (p_episode_id is null) <> (p_part_uid is null) then
    raise exception 'Set both the episode and the part, or neither.';
  end if;
  if p_episode_id is not null and (p_episode_id !~* v_uuid or p_part_uid !~* v_uuid) then
    raise exception 'Episode and part must be Cuez IDs.';
  end if;
  update bulletins set
    cuez_episode_id = lower(p_episode_id), cuez_episode_title = p_episode_title,
    cuez_part_uid = lower(p_part_uid), cuez_part_title = p_part_title,
    cuez_read_speed = case when p_read_speed between 60 and 400 then p_read_speed else cuez_read_speed end,
    updated_at = now()
  where id = p_newsroom_id;
  if not found then raise exception 'No newsroom with the id %.', p_newsroom_id; end if;
  if p_clear_sent then
    update stories set cuez_item_uid = null, cuez_sent_at = null, cuez_sent_rev = null, cuez_item_number = null,
                       cuez_pending_uid = null, cuez_pending_at = null, cuez_pending_rev = null, cuez_pending_plan = null
    where bulletin_id = p_newsroom_id and (cuez_item_uid is not null or cuez_pending_uid is not null);
  end if;
end;
$$;

-- The return columns grew (producer and conference), so drop the old shape first.
drop function if exists admin_newsrooms();
create or replace function admin_newsrooms()
returns table (
  newsroom_id text, name text, members bigint, stories bigint, sent_stories bigint,
  has_code boolean, code_updated_at timestamptz,
  cuez_episode_id text, cuez_episode_title text, cuez_part_uid text, cuez_part_title text,
  created_at timestamptz,
  producer_name text, conference_started_at timestamptz, pitches bigint, picked bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_admin();
  return query
    select b.id, coalesce(b.name, b.id),
           (select count(*) from newsroom_members m where m.bulletin_id = b.id),
           (select count(*) from stories s where s.bulletin_id = b.id and s.type is distinct from 'segment'),
           (select count(*) from stories s where s.bulletin_id = b.id and s.cuez_item_uid is not null),
           c.bulletin_id is not null, c.updated_at,
           b.cuez_episode_id, b.cuez_episode_title, b.cuez_part_uid, b.cuez_part_title, b.created_at,
           b.producer_name, b.conference_started_at,
           (select count(*) from pitches p where p.bulletin_id = b.id and p.conference_id = b.conference_id),
           (select count(*) from pitches p where p.bulletin_id = b.id and p.conference_id = b.conference_id and p.status = 'picked')
    from bulletins b left join newsroom_codes c on c.bulletin_id = b.id
    order by b.created_at desc;
end;
$$;

-- ── News conference, from the EP's side ─────────────────────────────────

-- A fresh conference for a newsroom: a clean board, and the producer role is
-- free for whoever drew the queen. Earlier pitches are kept for the record.
create or replace function start_conference(p_newsroom_id text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform require_admin();
  update bulletins set conference_id = gen_random_uuid(), conference_started_at = now(),
                       producer_user = null, producer_name = null, producer_since = null
  where id = p_newsroom_id;
  if not found then raise exception 'No newsroom with the id %.', p_newsroom_id; end if;
end;
$$;

-- Free the producer role (a laptop died, or the wrong person claimed it).
create or replace function clear_producer(p_newsroom_id text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform require_admin();
  update bulletins set producer_user = null, producer_name = null, producer_since = null where id = p_newsroom_id;
  if not found then raise exception 'No newsroom with the id %.', p_newsroom_id; end if;
end;
$$;

-- The EP's note on a pitch: advice for the group, not a decision.
create or replace function set_pitch_note(p_pitch_id uuid, p_note text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform require_admin();
  update pitches set ep_note = nullif(left(trim(coalesce(p_note, '')), 500), '') where id = p_pitch_id;
  if not found then raise exception 'Pitch missing'; end if;
end;
$$;

-- Everything the EP wall and the report need for the chosen newsrooms: the
-- current conference's pitches and the running order (scripts optional).
create or replace function conference_snapshot(p_newsroom_ids text[], p_scripts boolean default false)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', b.id, 'name', coalesce(b.name, b.id),
      'producer_name', b.producer_name, 'producer_since', b.producer_since,
      'conference_started_at', b.conference_started_at,
      'target_duration', b.target_duration,
      'cuez_episode_title', b.cuez_episode_title, 'cuez_part_title', b.cuez_part_title,
      'order', b.order_ids,
      'pitches', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', p.id, 'slug', p.slug, 'angle', p.angle, 'format', p.format, 'pitched_by', p.pitched_by,
          'status', p.status, 'spike_reason', p.spike_reason, 'ep_note', p.ep_note,
          'story_id', p.story_id, 'created_at', p.created_at, 'decided_at', p.decided_at
        ) order by p.position)
        from pitches p where p.bulletin_id = b.id and p.conference_id = b.conference_id), '[]'::jsonb),
      'stories', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', s.id, 'slug', s.slug, 'format', s.format, 'presenter', s.presenter, 'reporter', s.reporter,
          'duration', s.duration, 'completed', s.completed, 'is_floated', s.is_floated, 'type', s.type,
          'brief', s.brief, 'pitched_by', s.pitched_by, 'rev', s.rev,
          'cuez_item_uid', s.cuez_item_uid, 'cuez_item_number', s.cuez_item_number,
          'cuez_sent_rev', s.cuez_sent_rev, 'cuez_pending_uid', s.cuez_pending_uid,
          'script', case when p_scripts then s.script end
        ))
        from stories s where s.bulletin_id = b.id), '[]'::jsonb)
    ) order by coalesce(b.name, b.id))
    from bulletins b where b.id = any(p_newsroom_ids)), '[]'::jsonb);
end;
$$;

create or replace function admin_conference(p_newsroom_ids text[], p_scripts boolean default false)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform require_admin();
  return conference_snapshot(p_newsroom_ids, p_scripts);
end;
$$;

-- Staff accounts and explicit newsroom assignments. No direct browser access.
create table if not exists tutors (
  user_id uuid primary key references auth.users(id) on delete cascade,
  added_at timestamptz not null default now()
);
create table if not exists tutor_newsroom_access (
  user_id uuid not null references tutors(user_id) on delete cascade,
  bulletin_id text not null references bulletins(id) on delete cascade,
  primary key (user_id, bulletin_id)
);
alter table tutors enable row level security;
alter table tutor_newsroom_access enable row level security;
revoke all on tutors, tutor_newsroom_access from public, anon, authenticated;

create or replace function is_tutor()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from tutors t where t.user_id = auth.uid());
$$;

create or replace function can_tutor_newsroom(p_newsroom_id text)
returns boolean language sql stable security definer set search_path = public as $$
  select is_admin() or exists (
    select 1 from tutor_newsroom_access t
    where t.user_id = auth.uid() and t.bulletin_id = p_newsroom_id
  );
$$;

-- Account creation remains in Supabase Auth. This only assigns confirmed staff.
create or replace function set_tutor_access(p_email text, p_newsroom_ids text[])
returns void language plpgsql security definer set search_path = public as $$
declare v_user uuid;
begin
  perform require_admin();
  select u.id into v_user from auth.users u
  where lower(u.email) = lower(trim(p_email))
    and u.email_confirmed_at is not null and not coalesce(u.is_anonymous, false);
  if v_user is null then
    raise exception 'Create and confirm this staff email account in Supabase Authentication first.';
  end if;
  if exists (select 1 from unnest(p_newsroom_ids) as requested(newsroom_id)
             where requested.newsroom_id is null or not exists
               (select 1 from bulletins b where b.id = requested.newsroom_id)) then
    raise exception 'One of the selected newsrooms no longer exists.';
  end if;
  insert into tutors (user_id) values (v_user) on conflict do nothing;
  perform 1 from tutors where user_id = v_user for update;
  delete from tutor_newsroom_access where user_id = v_user;
  insert into tutor_newsroom_access (user_id, bulletin_id)
    select v_user, id from (select distinct unnest(p_newsroom_ids) id) selected;
end;
$$;

create or replace function remove_tutor(p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform require_admin();
  delete from tutors where user_id = p_user_id;
end;
$$;

create or replace function admin_tutors()
returns table (user_id uuid, email text, newsroom_ids text[])
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_admin();
  return query select t.user_id, u.email::text,
    array(select a.bulletin_id from tutor_newsroom_access a where a.user_id = t.user_id order by a.bulletin_id)
  from tutors t join auth.users u on u.id = t.user_id order by u.email;
end;
$$;

create or replace function tutor_newsrooms()
returns table (newsroom_id text, name text, producer_name text, pitches bigint, picked bigint,
               members bigint, stories bigint, tutor_code_available boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (is_admin() or is_tutor()) then raise exception 'Staff access required.'; end if;
  return query select b.id, coalesce(b.name, b.id), b.producer_name,
    (select count(*) from pitches p where p.bulletin_id = b.id and p.conference_id = b.conference_id),
    (select count(*) from pitches p where p.bulletin_id = b.id and p.conference_id = b.conference_id and p.status = 'picked'),
    (select count(*) from newsroom_members m where m.bulletin_id = b.id),
    (select count(*) from stories s where s.bulletin_id = b.id and s.type is distinct from 'segment'),
    exists (select 1 from tutor_join_codes c where c.bulletin_id = b.id)
  from bulletins b where can_tutor_newsroom(b.id) order by coalesce(b.name, b.id);
end;
$$;

create or replace function get_tutor_join_code(p_newsroom_id text)
returns text language plpgsql stable security definer set search_path = public as $$
declare v_code text;
begin
  if not can_tutor_newsroom(p_newsroom_id) then raise exception 'Newsroom unavailable.'; end if;
  select join_code into v_code from tutor_join_codes where bulletin_id = p_newsroom_id;
  return v_code;
end;
$$;

-- Only an admin can create, rotate or disable the second code. Replacing it
-- stops future joins with the previous code; existing memberships remain.
create or replace function set_tutor_join_code(p_newsroom_id text, p_enabled boolean default true)
returns text language plpgsql security definer set search_path = public as $$
declare v_code text;
begin
  perform require_admin();
  perform pg_advisory_xact_lock(hashtext('moira-desk:codes'));
  if not exists (select 1 from bulletins where id = p_newsroom_id) then raise exception 'Newsroom unavailable.'; end if;
  if not coalesce(p_enabled, false) then
    delete from tutor_join_codes where bulletin_id = p_newsroom_id;
    return null;
  end if;
  loop
    v_code := random_code();
    exit when not exists (select 1 from newsroom_codes where code_hash = public.code_hash(v_code))
      and not exists (select 1 from tutor_join_codes where code_hash = public.code_hash(v_code));
  end loop;
  insert into tutor_join_codes (bulletin_id, join_code, code_hash) values (p_newsroom_id, v_code, public.code_hash(v_code))
  on conflict (bulletin_id) do update set join_code = excluded.join_code, code_hash = excluded.code_hash, updated_at = now();
  return v_code;
end;
$$;

create or replace function tutor_conference(p_newsroom_ids text[], p_scripts boolean default false)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not (is_admin() or is_tutor()) then raise exception 'Staff access required.'; end if;
  if exists (select 1 from unnest(p_newsroom_ids) id where id is null or not can_tutor_newsroom(id)) then
    raise exception 'One or more newsrooms are unavailable. Refresh your newsroom list.';
  end if;
  return conference_snapshot(p_newsroom_ids, p_scripts);
end;
$$;

create or replace function tutor_set_pitch_note(p_pitch_id uuid, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare v_room text; v_conf uuid;
begin
  select bulletin_id, conference_id into v_room, v_conf from pitches where id = p_pitch_id;
  if not found or not can_tutor_newsroom(v_room) then raise exception 'Pitch unavailable.'; end if;
  if not exists (select 1 from bulletins where id = v_room and conference_id = v_conf) then
    raise exception 'This conference has ended. Refresh the wall.';
  end if;
  update pitches set ep_note = nullif(left(trim(coalesce(p_note, '')), 500), '') where id = p_pitch_id;
end;
$$;

revoke execute on function is_tutor(), can_tutor_newsroom(text), set_tutor_access(text, text[]),
  remove_tutor(uuid), admin_tutors(), tutor_newsrooms(), get_tutor_join_code(text),
  set_tutor_join_code(text, boolean), conference_snapshot(text[], boolean),
  tutor_conference(text[], boolean), tutor_set_pitch_note(uuid, text)
from public, anon, authenticated;
grant execute on function is_tutor(), set_tutor_access(text, text[]), remove_tutor(uuid), admin_tutors(),
  tutor_newsrooms(), get_tutor_join_code(text), set_tutor_join_code(text, boolean),
  tutor_conference(text[], boolean), tutor_set_pitch_note(uuid, text)
to authenticated;


drop view if exists newsroom_overview;

-- ==========================================================================
-- Function permissions. Postgres lets PUBLIC execute new functions by
-- default, so revoke everything, then grant only what's needed.
-- ==========================================================================

revoke execute on function
  is_member(text), code_hash(text), my_newsrooms(), join_newsroom(text),
  now_ms(), lock_stale_ms(), member_story(uuid), locked_by_other(stories), check_story_values(text, text),
  create_story(text, uuid, jsonb), delete_story(text, uuid), move_story(text, text, text),
  restore_story(text, uuid, int), save_story(uuid, jsonb, int),
  lock_story(uuid, text, text), take_lock(uuid, text, text), renew_lock(uuid, text), unlock_story(uuid, text),
  save_slug(uuid, text, text), set_story_status(uuid, text), set_story_floated(uuid, boolean),
  mark_story_not_sent(uuid), claim_cuez_send(text, int),
  current_conference(text), require_producer(text), member_pitch(uuid), release_removed_producer(),
  claim_producer(text, text), release_producer(text), add_pitch(text, text, text, text, text),
  update_pitch(uuid, text, text, text, text), delete_pitch(uuid), pick_pitch(uuid), unpick_pitch(uuid),
  spike_pitch(uuid, text), unspike_pitch(uuid), set_story_format(uuid, text), set_story_reporter(uuid, text),
  start_conference(text), clear_producer(text), set_pitch_note(uuid, text), admin_conference(text[], boolean),
  is_admin(), require_admin(), random_code(),
  create_newsroom(text, text), set_newsroom_code(text, text, boolean),
  rename_newsroom(text, text), delete_newsroom(text), remove_newsroom_members(text),
  set_cuez_target(text, text, text, text, text, boolean, integer), admin_newsrooms()
from public, anon, authenticated;

-- Signed-in browsers (anonymous students and the admin page alike).
-- is_member must stay callable because the policies use it. The helpers
-- (member_story, locked_by_other, ...) are internal and not granted.
grant execute on function
  is_member(text), code_hash(text), my_newsrooms(), join_newsroom(text),
  create_story(text, uuid, jsonb), delete_story(text, uuid), move_story(text, text, text),
  restore_story(text, uuid, int), save_story(uuid, jsonb, int),
  lock_story(uuid, text, text), take_lock(uuid, text, text), renew_lock(uuid, text), unlock_story(uuid, text),
  save_slug(uuid, text, text), set_story_status(uuid, text), set_story_floated(uuid, boolean),
  mark_story_not_sent(uuid),
  claim_producer(text, text), release_producer(text), add_pitch(text, text, text, text, text),
  update_pitch(uuid, text, text, text, text), delete_pitch(uuid), pick_pitch(uuid), unpick_pitch(uuid),
  spike_pitch(uuid, text), unspike_pitch(uuid), set_story_format(uuid, text), set_story_reporter(uuid, text)
to authenticated;

-- Admin functions: callable when signed in, but each one checks require_admin().
grant execute on function
  is_admin(), create_newsroom(text, text), set_newsroom_code(text, text, boolean),
  rename_newsroom(text, text), delete_newsroom(text), remove_newsroom_members(text),
  set_cuez_target(text, text, text, text, text, boolean, integer), admin_newsrooms(),
  start_conference(text), clear_producer(text), set_pitch_note(uuid, text), admin_conference(text[], boolean)
to authenticated;

-- The send-to-cuez function only.
grant execute on function claim_cuez_send(text, int) to service_role;

-- ── Personal admin newsroom folders ────────────────────────────────────

create table if not exists admin_folders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 60),
  unique (id, user_id)
);
create unique index if not exists admin_folders_unique_name on admin_folders(user_id, lower(trim(name)));
create table if not exists admin_folder_newsrooms (
  user_id uuid not null references auth.users(id) on delete cascade,
  bulletin_id text not null references bulletins(id) on delete cascade,
  folder_id uuid not null,
  primary key (user_id, bulletin_id),
  foreign key (folder_id, user_id) references admin_folders(id, user_id) on delete cascade
);
alter table admin_folders enable row level security;
alter table admin_folder_newsrooms enable row level security;
revoke all on admin_folders, admin_folder_newsrooms from public, anon, authenticated;

create or replace function get_admin_folders()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id', f.id, 'name', f.name, 'newsroom_ids', coalesce((
      select jsonb_agg(n.bulletin_id order by n.bulletin_id) from admin_folder_newsrooms n
      where n.folder_id = f.id and n.user_id = auth.uid()), '[]'::jsonb)
  ) order by lower(f.name), f.id) from admin_folders f where f.user_id = auth.uid()), '[]'::jsonb);
end;
$$;

create or replace function save_admin_folder(p_name text, p_folder_id uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_name text := trim(coalesce(p_name, ''));
begin
  if not is_admin() then raise exception 'Admins only.'; end if;
  perform pg_advisory_xact_lock(hashtext('moira:admin-folders'), hashtext(auth.uid()::text));
  if length(v_name) not between 1 and 60 then raise exception 'Folder names need 1 to 60 characters.'; end if;
  if exists (select 1 from admin_folders where user_id = auth.uid() and lower(trim(name)) = lower(v_name)
             and (p_folder_id is null or id <> p_folder_id)) then
    raise exception 'You already have a folder with that name.';
  end if;
  if p_folder_id is null then
    insert into admin_folders(user_id, name) values (auth.uid(), v_name) returning id into v_id;
  else
    update admin_folders set name = v_name where id = p_folder_id and user_id = auth.uid() returning id into v_id;
    if not found then raise exception 'Folder unavailable. Refresh the list.'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function move_admin_newsrooms(p_newsroom_ids text[], p_folder_id uuid default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only.'; end if;
  perform pg_advisory_xact_lock(hashtext('moira:admin-folders'), hashtext(auth.uid()::text));
  if p_folder_id is not null and not exists (select 1 from admin_folders where id = p_folder_id and user_id = auth.uid()) then
    raise exception 'Folder unavailable. Refresh the list.';
  end if;
  if coalesce(cardinality(p_newsroom_ids), 0) = 0 then raise exception 'Choose at least one newsroom.'; end if;
  if exists (select 1 from unnest(p_newsroom_ids) n(id) where n.id is null or not exists
             (select 1 from bulletins b where b.id = n.id)) then
    raise exception 'A newsroom no longer exists. Refresh the list.';
  end if;
  if p_folder_id is null then
    delete from admin_folder_newsrooms where user_id = auth.uid() and bulletin_id = any(p_newsroom_ids);
  else
    insert into admin_folder_newsrooms(user_id, bulletin_id, folder_id)
      select auth.uid(), id, p_folder_id from (select distinct unnest(p_newsroom_ids) id) chosen
    on conflict (user_id, bulletin_id) do update set folder_id = excluded.folder_id;
  end if;
end;
$$;

create or replace function delete_admin_folder(p_folder_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only.'; end if;
  perform pg_advisory_xact_lock(hashtext('moira:admin-folders'), hashtext(auth.uid()::text));
  -- Cascades only the organisation entries; newsrooms become Unfiled.
  delete from admin_folders where id = p_folder_id and user_id = auth.uid();
  if not found then raise exception 'Folder unavailable. Refresh the list.'; end if;
end;
$$;

revoke execute on function get_admin_folders(), save_admin_folder(text, uuid),
  move_admin_newsrooms(text[], uuid), delete_admin_folder(uuid) from public, anon, authenticated;
grant execute on function get_admin_folders(), save_admin_folder(text, uuid),
  move_admin_newsrooms(text[], uuid), delete_admin_folder(uuid) to authenticated;


-- ── Live EP broadcast alerts ──────────────────────────────────────────
alter table bulletins add column if not exists ep_alert_text text;
alter table bulletins add column if not exists ep_alert_at timestamptz;

create or replace function tutor_send_alert(p_newsroom_ids text[], p_message text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (is_admin() or is_tutor()) then raise exception 'Staff access required.'; end if;
  if coalesce(cardinality(p_newsroom_ids), 0) = 0 then
    raise exception 'Select at least one newsroom.';
  end if;
  if exists (select 1 from unnest(p_newsroom_ids) as requested(id)
             where id is null or not can_tutor_newsroom(id)
               or not exists (select 1 from bulletins b where b.id = requested.id)) then
    raise exception 'One or more newsrooms are unavailable. Refresh your newsroom list.';
  end if;
  if nullif(trim(p_message), '') is null then raise exception 'Enter an alert message.'; end if;
  update bulletins set ep_alert_text = left(trim(p_message), 240), ep_alert_at = now()
  where id = any(p_newsroom_ids);
end;
$$;
revoke execute on function tutor_send_alert(text[], text) from public, anon, authenticated;
grant execute on function tutor_send_alert(text[], text) to authenticated;
