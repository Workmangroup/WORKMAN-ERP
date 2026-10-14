-- ===========================================================================
-- 0093 — Rapprochement des dépôts de caisse aux lignes de relevé bancaire (P077), additif
--
-- Un dépôt de caisse (0092) est rapproché à une ligne de relevé (0087) de même montant, dans la
-- devise de base, par une personne ayant bank.reconcile. Table d'appariement en ajout seul ; la
-- ligne passe à « matched » selon la même règle que bank_match_confirm (0087), sans la modifier.
-- Non couvert : le dépôt ne porte pas de compte bancaire (aucune donnée fournie) : le rapprochement
-- repose sur le montant et la devise, confirmé par une personne.
-- ===========================================================================

create table public.pos_deposit_bank_matches (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default private.current_company() references public.companies(id) on delete cascade,
  deposit_id    uuid not null unique references public.pos_deposits(id),
  bank_line_id  uuid not null unique references public.bank_lines(id),
  amount        numeric(15,2) not null check (amount > 0),
  matched_by    uuid default auth.uid(),
  matched_at    timestamptz not null default now()
);

create function private.pos_deposit_bank_matches_append() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'POS_APPEND_ONLY' using errcode = '55000';
end $$;
revoke execute on function private.pos_deposit_bank_matches_append() from public, anon, authenticated;
create trigger pos_deposit_bank_matches_append before update or delete on public.pos_deposit_bank_matches
  for each row execute function private.pos_deposit_bank_matches_append();

alter table public.pos_deposit_bank_matches enable row level security;
create policy pos_deposit_bank_matches_select on public.pos_deposit_bank_matches for select to authenticated
  using (company_id = private.current_company() and private.has_perm('finance.read'));
revoke all on public.pos_deposit_bank_matches from anon, authenticated;
grant select on public.pos_deposit_bank_matches to authenticated;
grant all on public.pos_deposit_bank_matches to service_role;

create function public.pos_deposit_match(p_line uuid, p_deposit uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_base char(3) := private.base_currency(); l public.bank_lines%rowtype;
  a public.bank_accounts%rowtype; d public.pos_deposits%rowtype; v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('bank.reconcile');
  select * into l from public.bank_lines where id = p_line and company_id = v_co for update;
  if not found then raise exception 'BANK_NOT_FOUND' using errcode = 'P0002'; end if;
  if l.status <> 'open' then raise exception 'BANK_BAD_STATUS' using errcode = '55000'; end if;
  select * into a from public.bank_accounts where id = l.bank_account_id;
  if a.currency <> v_base then raise exception 'BANK_CURRENCY_MISMATCH' using errcode = '22023'; end if;
  select * into d from public.pos_deposits where id = p_deposit and company_id = v_co;
  if not found then raise exception 'POS_NOT_FOUND' using errcode = 'P0002'; end if;
  if l.amount <> d.amount then raise exception 'POS_DEPOSIT_MISMATCH' using errcode = '22023', detail = l.amount::text || ' / ' || d.amount::text; end if;
  if exists (select 1 from public.pos_deposit_bank_matches m where m.deposit_id = d.id) then
    raise exception 'POS_DEPOSIT_ALREADY_MATCHED' using errcode = '55000';
  end if;
  insert into public.pos_deposit_bank_matches (id, company_id, deposit_id, bank_line_id, amount)
    values (v_id, v_co, d.id, l.id, d.amount);
  update public.bank_lines set status = 'matched' where id = l.id;
  perform private.write_audit(v_co, 'pos.deposit_match', 'bank_line', l.id::text, null, jsonb_build_object('status', 'open'),
    jsonb_build_object('status', 'matched', 'deposit_id', d.id), '{}'::jsonb, 'rpc');
  return v_id;
end $$;
