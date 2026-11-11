-- Story 21-2 (spec-invite-sms-download-link, CAP-2): the per-phone cap, checked
-- and reserved in one step.
--
-- Plain-English contract:
--   invite_sms_reserve_send(phone_hash, max, window_minutes)
--     Counts the counter rows for this phone inside the rolling window. Below
--     the cap, it writes one counter row and returns its id, and the caller may
--     send. At the cap, it writes nothing and returns null, and the caller must
--     not send.
--   The backend deletes that counter row again if the send fails, so a failed
--   send does not count (owner decision 2026-11-10). A timeout keeps its row,
--   because the SMS may have arrived (owner decision 2026-11-11).
--
-- Race safety: the advisory lock is taken for this phone before the count, and
-- it is held until the function's transaction ends. Two resends for the same
-- phone at count 4 therefore run one after the other: the first gets the fifth
-- slot, and the second sees 5 and is refused.
--
-- Why a function: the count and the insert must happen in one transaction. The
-- PostgREST client cannot hold a transaction across two calls, and the lock
-- must be taken in SQL.

create or replace function public.invite_sms_reserve_send(
  p_phone_hash text,
  p_max integer,
  p_window_minutes integer
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_count integer;
  v_id    uuid;
begin
  if p_phone_hash is null or p_phone_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'phone hash must be 64 lowercase hex characters'
      using errcode = 'PT400', hint = 'VALIDATION_ERROR';
  end if;
  if p_max is null or p_max < 1 or p_window_minutes is null or p_window_minutes < 1 then
    raise exception 'cap and window must be positive'
      using errcode = 'PT400', hint = 'VALIDATION_ERROR';
  end if;

  -- One reservation at a time for this phone. Released when the transaction ends.
  perform pg_advisory_xact_lock(hashtext('invite_sms:' || p_phone_hash));

  select count(*) into v_count
    from public.invite_sms_counter c
   where c.phone_hash = p_phone_hash
     and c.created_at > now() - make_interval(mins => p_window_minutes);

  if v_count >= p_max then
    return null;
  end if;

  insert into public.invite_sms_counter (phone_hash)
  values (p_phone_hash)
  returning id into v_id;

  return v_id;
end;
$function$;

-- Only the backend's service role may run this (same as the other membership functions).
revoke all on function public.invite_sms_reserve_send(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.invite_sms_reserve_send(text, integer, integer)
  to postgres, service_role;
