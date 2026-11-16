-- Let tutors reset their assigned newsrooms for a new group, as admins can.
-- Needs 20261116_reset_newsroom.sql first. Safe to rerun.
begin;

-- The reset itself, with no access check: only reset_newsroom (admins) and
-- tutor_reset_newsroom (assigned staff) call it, and it isn't granted.
create or replace function reset_newsroom_now(p_newsroom_id text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_sending timestamptz;
begin
  select cuez_sending_at into v_sending from bulletins where id = p_newsroom_id for update;
  if not found then raise exception 'No newsroom with the id %.', p_newsroom_id; end if;
  if v_sending is not null and v_sending > now() - interval '120 seconds' then
    raise exception 'A Cuez send is in progress. Try again in a couple of minutes.';
  end if;
  delete from stories where bulletin_id = p_newsroom_id;
  delete from deleted_stories where bulletin_id = p_newsroom_id;
  delete from newsroom_members where bulletin_id = p_newsroom_id;
  update bulletins set order_ids = '["marker-line"]'::jsonb,
                       conference_id = gen_random_uuid(), conference_started_at = now(),
                       producer_user = null, producer_name = null, producer_since = null,
                       ep_alert_text = null, ep_alert_at = null, updated_at = now()
  where id = p_newsroom_id;
end;
$$;

-- Ready the newsroom for a new group: a new conference with no producer, an
-- empty running order, no members and no EP alert. The name, join codes,
-- tutors, folder and Cuez target stay. Earlier pitches and EP feedback stay
-- in the database but drop out of the board and the report.
create or replace function reset_newsroom(p_newsroom_id text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform require_admin();
  perform reset_newsroom_now(p_newsroom_id);
end;
$$;

-- The same, for staff assigned to the newsroom.
create or replace function tutor_reset_newsroom(p_newsroom_id text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (is_admin() or is_tutor()) then raise exception 'Staff access required.'; end if;
  if p_newsroom_id is null or not can_tutor_newsroom(p_newsroom_id)
     or not exists (select 1 from bulletins where id = p_newsroom_id) then
    raise exception 'Newsroom unavailable. Refresh your newsroom list.';
  end if;
  perform reset_newsroom_now(p_newsroom_id);
end;
$$;

revoke execute on function reset_newsroom_now(text), reset_newsroom(text), tutor_reset_newsroom(text) from public, anon, authenticated;
grant execute on function reset_newsroom(text), tutor_reset_newsroom(text) to authenticated;

commit;
