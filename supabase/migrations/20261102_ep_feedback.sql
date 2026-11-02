-- EP feedback on the running order and its stories, written by staff after a
-- session and shown to the whole newsroom as "EP". Safe to rerun.
begin;

-- One row per comment. No story means feedback on the running order as a whole.
-- Like pitches, feedback belongs to a conference: a new conference clears it
-- from the desk and the report, but the rows are kept.
create table if not exists ep_feedback (
  id             uuid primary key default gen_random_uuid(),
  bulletin_id    text not null references bulletins(id) on delete cascade,
  conference_id  uuid not null,
  -- No foreign key: a deleted story can be restored, and its feedback with it.
  story_id       uuid,
  story_slug     text,                       -- the slug when written, for removed stories
  quote          text,                       -- the passage of script it refers to
  body           text not null,
  created_by     uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists ep_feedback_conference_idx on ep_feedback(bulletin_id, conference_id, created_at);

-- Members can read their newsroom's feedback. All writes go through functions.
alter table ep_feedback enable row level security;
drop policy if exists members_read on ep_feedback;
create policy members_read on ep_feedback for select using (is_member(bulletin_id));
revoke all on ep_feedback from anon, authenticated;
grant select on ep_feedback to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'ep_feedback'
  ) then
    alter publication supabase_realtime add table ep_feedback;
  end if;
end $$;

-- Add (no id) or change (id) a comment. Any staff member assigned to the
-- newsroom may change any comment from its current conference.
create or replace function tutor_save_feedback(p_feedback_id uuid, p_newsroom_id text, p_story_id uuid, p_quote text, p_body text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_body text := nullif(left(trim(coalesce(p_body, '')), 2000), '');
  v_quote text := nullif(left(trim(coalesce(p_quote, '')), 500), '');
  v ep_feedback;
  v_id uuid;
  v_slug text;
begin
  if not (is_admin() or is_tutor()) then raise exception 'Staff access required.'; end if;
  if v_body is null then raise exception 'Write some feedback first.'; end if;
  if p_feedback_id is not null then
    select * into v from ep_feedback where id = p_feedback_id for update;
    if not found or not can_tutor_newsroom(v.bulletin_id) then raise exception 'Feedback unavailable.'; end if;
    if not exists (select 1 from bulletins where id = v.bulletin_id and conference_id = v.conference_id) then
      raise exception 'This feedback is from an earlier conference, so it can''t be changed.';
    end if;
    update ep_feedback set body = v_body, quote = case when v.story_id is null then null else v_quote end, updated_at = now()
    where id = p_feedback_id;
    return p_feedback_id;
  end if;
  if p_newsroom_id is null or not can_tutor_newsroom(p_newsroom_id)
     or not exists (select 1 from bulletins where id = p_newsroom_id) then
    raise exception 'Newsroom unavailable.';
  end if;
  if p_story_id is not null then
    select slug into v_slug from stories where id = p_story_id and bulletin_id = p_newsroom_id;
    if not found then raise exception 'That story is no longer in this running order. Refresh and try again.'; end if;
  end if;
  insert into ep_feedback (bulletin_id, conference_id, story_id, story_slug, quote, body, created_by)
  values (p_newsroom_id, current_conference(p_newsroom_id), p_story_id, v_slug,
          case when p_story_id is null then null else v_quote end, v_body, auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function tutor_delete_feedback(p_feedback_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v ep_feedback;
begin
  if not (is_admin() or is_tutor()) then raise exception 'Staff access required.'; end if;
  select * into v from ep_feedback where id = p_feedback_id for update;
  if not found or not can_tutor_newsroom(v.bulletin_id) then raise exception 'Feedback unavailable.'; end if;
  if not exists (select 1 from bulletins where id = v.bulletin_id and conference_id = v.conference_id) then
    raise exception 'This feedback is from an earlier conference, so it can''t be changed.';
  end if;
  delete from ep_feedback where id = p_feedback_id;
end;
$$;

-- The snapshot used by the EP wall, the reports and the review screen now
-- carries the current conference's feedback too.
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
        from stories s where s.bulletin_id = b.id), '[]'::jsonb),
      'feedback', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', f.id, 'story_id', f.story_id, 'story_slug', f.story_slug, 'quote', f.quote, 'body', f.body,
          'created_at', f.created_at, 'updated_at', f.updated_at
        ) order by f.created_at, f.id)
        from ep_feedback f where f.bulletin_id = b.id and f.conference_id = b.conference_id), '[]'::jsonb)
    ) order by coalesce(b.name, b.id))
    from bulletins b where b.id = any(p_newsroom_ids)), '[]'::jsonb);
end;
$$;

revoke execute on function tutor_save_feedback(uuid, text, uuid, text, text), tutor_delete_feedback(uuid),
  conference_snapshot(text[], boolean) from public, anon, authenticated;
grant execute on function tutor_save_feedback(uuid, text, uuid, text, text), tutor_delete_feedback(uuid) to authenticated;
notify pgrst, 'reload schema';
commit;
