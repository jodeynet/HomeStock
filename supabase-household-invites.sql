-- Run this once in the Supabase SQL Editor for the HomeStock project.
-- Invite codes expire after 7 days and can be used by up to 10 new members.
-- New codes are 8 hexadecimal characters; existing longer codes remain valid.

create table if not exists public.household_invites (
    id uuid primary key default pg_catalog.gen_random_uuid(),
    household_id uuid not null references public.households(id) on delete cascade,
    invite_code text not null unique,
    created_by uuid not null references auth.users(id) on delete cascade,
    created_at timestamptz not null default pg_catalog.now(),
    expires_at timestamptz not null default (pg_catalog.now() + interval '7 days'),
    max_uses integer not null default 10 check (max_uses > 0),
    use_count integer not null default 0 check (use_count >= 0)
);

alter table public.household_invites enable row level security;
revoke all on table public.household_invites from public, anon, authenticated;

create or replace function public.create_household_invite()
returns table (invite_code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_household_id uuid;
    v_invite_code text;
    v_inserted_count integer;
begin
    if auth.uid() is null then
        raise exception 'You must be signed in to create a household invite.';
    end if;

    select hm.household_id
    into v_household_id
    from public.household_members as hm
    where hm.user_id = auth.uid()
    limit 1;

    if v_household_id is null then
        raise exception 'Your account is not assigned to a household.';
    end if;

    loop
        v_invite_code := pg_catalog.substr(
            pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', ''),
            1,
            8
        );

        return query
        insert into public.household_invites as hi (household_id, invite_code, created_by)
        values (v_household_id, v_invite_code, auth.uid())
        on conflict do nothing
        returning hi.invite_code, hi.expires_at;

        get diagnostics v_inserted_count = row_count;
        if v_inserted_count > 0 then
            return;
        end if;
    end loop;
end;
$$;

create or replace function public.accept_household_invite(p_invite_code text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_user_id uuid := auth.uid();
    v_invite_id uuid;
    v_household_id uuid;
    v_max_uses integer;
    v_use_count integer;
    v_existing_household_id uuid;
begin
    if v_user_id is null then
        raise exception 'You must be signed in to join a household.';
    end if;
    if p_invite_code is null or pg_catalog.char_length(pg_catalog.btrim(p_invite_code)) < 5 then
        raise exception 'Enter a household invite code with at least 5 characters.';
    end if;

    select hi.id, hi.household_id, hi.max_uses, hi.use_count
    into v_invite_id, v_household_id, v_max_uses, v_use_count
    from public.household_invites as hi
    where hi.invite_code = pg_catalog.lower(pg_catalog.btrim(p_invite_code))
      and hi.expires_at > pg_catalog.now()
    for update;

    if not found then
        raise exception 'This invite code is invalid or has expired.';
    end if;
    if v_use_count >= v_max_uses then
        raise exception 'This invite code has reached its usage limit.';
    end if;

    select hm.household_id
    into v_existing_household_id
    from public.household_members as hm
    where hm.user_id = v_user_id
    limit 1;

    if found then
        if v_existing_household_id = v_household_id then
            return v_household_id;
        end if;
        raise exception 'Your account is already assigned to a different household.';
    end if;

    insert into public.household_members (household_id, user_id, role)
    values (v_household_id, v_user_id, 'member');

    update public.household_invites
    set use_count = v_use_count + 1
    where id = v_invite_id;

    return v_household_id;
end;
$$;

revoke all on function public.create_household_invite() from public, anon;
revoke all on function public.accept_household_invite(text) from public, anon;
grant execute on function public.create_household_invite() to authenticated;
grant execute on function public.accept_household_invite(text) to authenticated;
