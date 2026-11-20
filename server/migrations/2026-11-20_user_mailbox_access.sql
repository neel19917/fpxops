-- Applied to production 2026-11-20.
-- Per-user Support Mailbox access. Existing users keep what they had (draft).
alter table public.fpx_user_profiles add column if not exists mailbox_access text not null default 'draft' check (mailbox_access in ('none', 'view', 'draft'));
comment on column public.fpx_user_profiles.mailbox_access is 'Support Mailbox access: none | view (read only) | draft (read, link, AI-write and create Outlook drafts). Admins always have full access.';

-- Users may edit their own profile row but not their role, enabled flag or
-- mailbox access (admins can change anything). Applied 2026-11-20.
drop policy if exists "profile: update" on public.fpx_user_profiles;
create policy "profile: update" on public.fpx_user_profiles
  for update to authenticated
  using ((id = (select auth.uid())) or fpx_is_admin((select auth.uid())))
  with check (
    fpx_is_admin((select auth.uid()))
    or (
      id = (select auth.uid())
      and role = (select p.role from public.fpx_user_profiles p where p.id = (select auth.uid()))
      and enabled = (select p.enabled from public.fpx_user_profiles p where p.id = (select auth.uid()))
      and mailbox_access = (select p.mailbox_access from public.fpx_user_profiles p where p.id = (select auth.uid()))
    )
  );
