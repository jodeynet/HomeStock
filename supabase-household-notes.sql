-- Run this once in the Supabase SQL Editor for the HomeStock project.

create table if not exists public.household_notes (
    household_id uuid primary key references public.households(id) on delete cascade,
    notes text not null default '',
    updated_at timestamptz not null default pg_catalog.now()
);

alter table public.household_notes enable row level security;
revoke all on table public.household_notes from public, anon, authenticated;
grant select, insert, update on table public.household_notes to authenticated;

drop policy if exists "Household members can read household notes" on public.household_notes;
create policy "Household members can read household notes"
    on public.household_notes
    for select
    to authenticated
    using (
        exists (
            select 1
            from public.household_members as hm
            where hm.household_id = household_notes.household_id
              and hm.user_id = (select auth.uid())
        )
    );

drop policy if exists "Household members can create household notes" on public.household_notes;
create policy "Household members can create household notes"
    on public.household_notes
    for insert
    to authenticated
    with check (
        exists (
            select 1
            from public.household_members as hm
            where hm.household_id = household_notes.household_id
              and hm.user_id = (select auth.uid())
        )
    );

drop policy if exists "Household members can update household notes" on public.household_notes;
create policy "Household members can update household notes"
    on public.household_notes
    for update
    to authenticated
    using (
        exists (
            select 1
            from public.household_members as hm
            where hm.household_id = household_notes.household_id
              and hm.user_id = (select auth.uid())
        )
    )
    with check (
        exists (
            select 1
            from public.household_members as hm
            where hm.household_id = household_notes.household_id
              and hm.user_id = (select auth.uid())
        )
    );

do $$
begin
    if exists (
        select 1
        from pg_catalog.pg_publication
        where pubname = 'supabase_realtime'
    ) and not exists (
        select 1
        from pg_catalog.pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'household_notes'
    ) then
        alter publication supabase_realtime add table public.household_notes;
    end if;
end;
$$;
