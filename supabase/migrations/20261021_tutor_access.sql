-- Tutor access, assigned newsrooms and optional staff-visible student join codes.
-- Run once in the Supabase SQL Editor before using tutor.html. Safe to re-run.
begin;

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


notify pgrst, 'reload schema';
commit;
