-- Run this once in the Supabase SQL Editor for the HomeStock project.
-- Re-run safely if any household tables are added to the app's live updates.

do $$
declare
    table_name text;
begin
    if not exists (
        select 1
        from pg_catalog.pg_publication
        where pubname = 'supabase_realtime'
    ) then
        raise exception 'The supabase_realtime publication does not exist.';
    end if;

    foreach table_name in array array['shopping_list', 'items', 'shopping_trips', 'household_notes']
    loop
        if pg_catalog.to_regclass(pg_catalog.format('public.%I', table_name)) is null then
            if table_name = 'household_notes' then
                raise exception 'Table public.% does not exist. Run supabase-household-notes.sql first.', table_name;
            end if;
            raise exception 'Table public.% does not exist.', table_name;
        end if;

        if not exists (
            select 1
            from pg_catalog.pg_publication_tables
            where pubname = 'supabase_realtime'
              and schemaname = 'public'
              and tablename = table_name
        ) then
            execute pg_catalog.format(
                'alter publication supabase_realtime add table public.%I',
                table_name
            );
        end if;
    end loop;
end;
$$;
