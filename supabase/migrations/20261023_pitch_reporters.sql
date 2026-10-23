-- Default picked stories to the pitch author and allow producer assignment.
-- Existing reporter assignments are left unchanged.
begin;

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

revoke execute on function set_story_reporter(uuid, text) from public, anon, authenticated;
grant execute on function set_story_reporter(uuid, text) to authenticated;

commit;
