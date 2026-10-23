-- Invalidate archived story recovery when its pitch is dropped.
-- Safe to apply again; existing function permissions are preserved.

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
