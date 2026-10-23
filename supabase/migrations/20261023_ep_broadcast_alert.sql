-- Live EP broadcasts to selected newsrooms. Safe to rerun.
begin;
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
notify pgrst, 'reload schema';
commit;
