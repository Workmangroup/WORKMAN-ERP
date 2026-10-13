-- 0054 — BAT, logos et validation client (personnalisation des commandes)
-- Additive. Aucune donnée inventée. Réutilise : GED (dossiers « logos » et « bat », empreinte sha256 par document, 0005),
-- contacts clients (0004), lignes de commande (0010, 0012, 0049), journal d'audit et empreinte (0003, 0043).
-- Distinct du BAT de développement (0014, par projet) : celui-ci porte sur une ligne de commande et une version de personnalisation.

-- ---------------------------------------------------------------------
-- 1. Droits
-- ---------------------------------------------------------------------
insert into public.permissions (code, module, label, description) values
  ('personalization.read',    'commercial', 'Voir les personnalisations', 'Logos, personnalisations, BAT et accords'),
  ('personalization.write',   'commercial', 'Gérer les personnalisations', 'Logos, spécifications, émission de BAT, enregistrement des accords'),
  ('personalization.operate', 'production', 'Lancer une personnalisation', 'Démarrer une opération de personnalisation avec BAT approuvé')
on conflict (code) do update set module = excluded.module, label = excluded.label, description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.code in ('personalization.read','personalization.write','personalization.operate')
where r.code = 'admin' on conflict do nothing;
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.code in ('personalization.read','personalization.write')
where r.code = 'commercial' on conflict do nothing;
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.code in ('personalization.read','personalization.operate')
where r.code = 'production' on conflict do nothing;
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.code = 'personalization.read'
where r.code in ('direction', 'qualite') on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Contact habilité à approuver un BAT (ajout d'une colonne, sans effet sur l'existant)
-- ---------------------------------------------------------------------
alter table public.client_contacts add column can_approve_bat boolean not null default false;

create function public.client_contact_set_bat_approver(p_contact uuid, p_allowed boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); c public.client_contacts%rowtype;
begin
  perform private.require_perm('clients.write');
  select * into c from public.client_contacts where id = p_contact and company_id = v_co for update;
  if not found then raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002'; end if;
  update public.client_contacts set can_approve_bat = coalesce(p_allowed, false), updated_at = now() where id = c.id;
  perform private.write_audit(v_co, 'client.bat_approver', 'client', c.client_id::text, c.full_name, jsonb_build_object('allowed', c.can_approve_bat),
    jsonb_build_object('allowed', coalesce(p_allowed, false)), jsonb_build_object('contact', c.id), 'rpc');
end $$;
grant execute on function public.client_contact_set_bat_approver(uuid, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 3. Logos : pièce GED du dossier « logos » du client, droits d'usage datés et prouvés
-- ---------------------------------------------------------------------
create table public.client_logos (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null default private.current_company() references public.companies(id),
  client_id       uuid not null references public.clients(id),
  document_id     uuid not null unique references public.ged_documents(id),
  name            text not null check (length(btrim(name)) between 2 and 120),
  rights_kind     text not null check (rights_kind in ('owned', 'licensed', 'client_provided')),
  rights_proof    text not null check (length(btrim(rights_proof)) between 5 and 300),
  rights_valid_until date,
  registered_by   uuid default auth.uid(),
  registered_at   timestamptz not null default now(),
  withdrawn_by    uuid,
  withdrawn_at    timestamptz,
  withdraw_reason text check (withdraw_reason is null or length(btrim(withdraw_reason)) between 5 and 300),
  check ((withdrawn_at is null) = (withdrawn_by is null) and (withdrawn_at is null) = (withdraw_reason is null)),
  check (rights_kind <> 'licensed' or rights_valid_until is not null)
);
create function private.logo_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'APPEND_ONLY' using errcode = '55000'; end if;
  if old.withdrawn_at is null and new.withdrawn_at is not null
     and (new.company_id, new.client_id, new.document_id, new.name, new.rights_kind, new.rights_proof, new.rights_valid_until, new.registered_by, new.registered_at)
       is not distinct from (old.company_id, old.client_id, old.document_id, old.name, old.rights_kind, old.rights_proof, old.rights_valid_until, old.registered_by, old.registered_at) then
    return new;
  end if;
  raise exception 'APPEND_ONLY' using errcode = '55000';
end $$;
create trigger client_logos_guard before update or delete on public.client_logos
  for each row execute function private.logo_guard();
alter table public.client_logos enable row level security;
create policy client_logos_select on public.client_logos for select to authenticated
  using (company_id = private.current_company() and private.has_perm('personalization.read'));
grant select on public.client_logos to authenticated;

create function public.logo_register(p_client uuid, p_document uuid, p_name text, p_rights_kind text, p_proof text, p_valid_until date) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid;
begin
  perform private.require_perm('personalization.write');
  if not exists (select 1 from public.clients c where c.id = p_client and c.company_id = v_co and c.archived_at is null) then raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002'; end if;
  -- Le logo doit être un document du dossier « logos » de ce client
  if not exists (select 1 from public.ged_documents d join public.ged_folders f on f.id = d.folder_id
                  where d.id = p_document and d.client_id = p_client and d.company_id = v_co and f.system_key = 'logos') then
    raise exception 'LOGO_DOCUMENT_INVALID' using errcode = '22023';
  end if;
  insert into public.client_logos (company_id, client_id, document_id, name, rights_kind, rights_proof, rights_valid_until)
  values (v_co, p_client, p_document, btrim(p_name), p_rights_kind, btrim(p_proof), p_valid_until) returning id into v_id;
  perform private.write_audit(v_co, 'logo.register', 'client', p_client::text, btrim(p_name), null,
    jsonb_build_object('rights_kind', p_rights_kind, 'valid_until', p_valid_until), jsonb_build_object('logo', v_id), 'rpc');
  return v_id;
end $$;
grant execute on function public.logo_register(uuid, uuid, text, text, text, date) to authenticated, service_role;

-- Retrait des droits : les BAT en cours qui utilisent ce logo ne sont plus valides
create function public.logo_withdraw(p_logo uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); l public.client_logos%rowtype; v_n int;
begin
  perform private.require_perm('personalization.write');
  select * into l from public.client_logos where id = p_logo and company_id = v_co for update;
  if not found then raise exception 'LOGO_NOT_FOUND' using errcode = 'P0002'; end if;
  if l.withdrawn_at is not null then raise exception 'LOGO_BAD_STATUS' using errcode = '55000'; end if;
  update public.client_logos set withdrawn_by = auth.uid(), withdrawn_at = now(), withdraw_reason = btrim(coalesce(p_reason, '')) where id = l.id;
  with s as (select sp.id from public.personalization_specs sp where sp.logo_id = l.id and sp.status = 'current')
  update public.bat_proofs b set status = 'superseded' from s where b.spec_id = s.id and b.status in ('issued', 'approved');
  get diagnostics v_n = row_count;
  perform private.write_audit(v_co, 'logo.withdraw', 'client', l.client_id::text, l.name, jsonb_build_object('status', 'active'),
    jsonb_build_object('status', 'withdrawn', 'bat_superseded', v_n), jsonb_build_object('reason', btrim(coalesce(p_reason, ''))), 'rpc');
end $$;
grant execute on function public.logo_withdraw(uuid, text) to authenticated, service_role;

-- Droits valides à une date : non retiré et non échu
create function private.logo_rights_valid(p_logo uuid, p_on date) returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from public.client_logos l where l.id = p_logo and l.withdrawn_at is null
                  and (l.rights_valid_until is null or l.rights_valid_until >= p_on))
$$;

-- ---------------------------------------------------------------------
-- 4. Spécifications de personnalisation (versionnées par ligne de commande)
--    Toute modification du visuel (logo, technique, placement, dimensions, couleurs) crée une nouvelle version courante.
-- ---------------------------------------------------------------------
create table public.personalization_specs (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null default private.current_company() references public.companies(id),
  order_line_id  uuid not null references public.sales_order_lines(id),
  version_no     int not null check (version_no >= 1),
  logo_id        uuid not null references public.client_logos(id),
  technique      text not null check (technique in ('embroidery', 'screen_print', 'flock', 'digital_print')),
  placement      text not null check (length(btrim(placement)) between 2 and 120),
  width_mm       numeric(7,1) not null check (width_mm > 0),
  height_mm      numeric(7,1) not null check (height_mm > 0),
  colors         text[] not null check (cardinality(colors) between 1 and 12),
  notes          text check (notes is null or length(btrim(notes)) <= 500),
  status         text not null default 'current' check (status in ('current', 'superseded')),
  created_by     uuid default auth.uid(),
  created_at     timestamptz not null default now(),
  unique (order_line_id, version_no)
);
create unique index personalization_specs_current_uq on public.personalization_specs (order_line_id) where status = 'current';
create function private.spec_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'APPEND_ONLY' using errcode = '55000'; end if;
  if old.status = 'current' and new.status = 'superseded'
     and (new.company_id, new.order_line_id, new.version_no, new.logo_id, new.technique, new.placement, new.width_mm, new.height_mm, new.colors, new.notes)
       is not distinct from (old.company_id, old.order_line_id, old.version_no, old.logo_id, old.technique, old.placement, old.width_mm, old.height_mm, old.colors, old.notes) then
    return new;
  end if;
  raise exception 'APPEND_ONLY' using errcode = '55000';
end $$;
create trigger personalization_specs_guard before update or delete on public.personalization_specs
  for each row execute function private.spec_guard();
alter table public.personalization_specs enable row level security;
create policy personalization_specs_select on public.personalization_specs for select to authenticated
  using (company_id = private.current_company() and private.has_perm('personalization.read'));
grant select on public.personalization_specs to authenticated;

create function public.personalization_spec_set(p_order_line uuid, p_logo uuid, p_technique text, p_placement text, p_width numeric, p_height numeric,
  p_colors text[], p_notes text default null) returns int
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); l public.sales_order_lines%rowtype; o public.sales_orders%rowtype; g public.client_logos%rowtype;
  v_cur public.personalization_specs%rowtype; v_seq int; v_id uuid; v_n int;
begin
  perform private.require_perm('personalization.write');
  select * into l from public.sales_order_lines where id = p_order_line;
  if not found then raise exception 'ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into o from public.sales_orders where id = l.order_id and company_id = v_co;
  if not found then raise exception 'ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status not in ('draft', 'confirmed') then raise exception 'PERSO_ORDER_LOCKED' using errcode = '55000'; end if;
  if exists (select 1 from public.personalization_operations op join public.personalization_specs s on s.id = op.spec_id where s.order_line_id = l.id) then
    raise exception 'PERSO_OPERATION_STARTED' using errcode = '55000';
  end if;
  select * into g from public.client_logos where id = p_logo and company_id = v_co;
  if not found or g.client_id <> o.client_id then raise exception 'LOGO_NOT_FOUND' using errcode = 'P0002'; end if;
  if not private.logo_rights_valid(g.id, current_date) then raise exception 'LOGO_RIGHTS_INVALID' using errcode = '55000'; end if;
  if p_technique not in ('embroidery', 'screen_print', 'flock', 'digital_print') then raise exception 'PERSO_TECHNIQUE_INVALID' using errcode = '22023'; end if;
  if p_width is null or p_height is null or p_width <= 0 or p_height <= 0 then raise exception 'PERSO_DIMENSION_INVALID' using errcode = '22023'; end if;
  if p_colors is null or cardinality(p_colors) < 1 or cardinality(p_colors) > 12 then raise exception 'PERSO_COLORS_INVALID' using errcode = '22023'; end if;
  select * into v_cur from public.personalization_specs where order_line_id = l.id and status = 'current' for update;
  v_seq := coalesce(v_cur.version_no, 0) + 1;
  if found then
    update public.personalization_specs set status = 'superseded' where id = v_cur.id;
    -- Le visuel a changé : tout BAT non approuvé ou approuvé pour l'ancienne version n'est plus valide
    update public.bat_proofs set status = 'superseded' where spec_id = v_cur.id and status in ('issued', 'approved');
    get diagnostics v_n = row_count;
  else
    v_n := 0;
  end if;
  insert into public.personalization_specs (company_id, order_line_id, version_no, logo_id, technique, placement, width_mm, height_mm, colors, notes)
  values (v_co, l.id, v_seq, g.id, p_technique, btrim(p_placement), p_width, p_height, p_colors, nullif(btrim(coalesce(p_notes, '')), ''))
  returning id into v_id;
  perform private.write_audit(v_co, 'perso.spec_set', 'order', o.id::text, o.code, jsonb_build_object('version', v_seq - 1),
    jsonb_build_object('version', v_seq, 'technique', p_technique, 'logo', g.id, 'bat_superseded', v_n), jsonb_build_object('line', l.id), 'rpc');
  return v_seq;
end $$;
grant execute on function public.personalization_spec_set(uuid, uuid, text, text, numeric, numeric, text[], text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 5. BAT : une version par spécification ; accord enregistré par un contact habilité, à la version exacte
-- ---------------------------------------------------------------------
create table public.bat_proofs (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null default private.current_company() references public.companies(id),
  spec_id          uuid not null references public.personalization_specs(id),
  version_no       int not null check (version_no >= 1),
  document_id      uuid not null references public.ged_documents(id),
  pdf_sha256       text not null check (pdf_sha256 ~ '^[a-f0-9]{64}$'),
  spec_hash        text not null check (spec_hash ~ '^[a-f0-9]{64}$'),
  status           text not null default 'issued' check (status in ('issued', 'approved', 'rejected', 'superseded')),
  issued_by        uuid default auth.uid(),
  issued_at        timestamptz not null default now(),
  decided_by       uuid,
  decided_at       timestamptz,
  contact_id       uuid references public.client_contacts(id),
  contact_name     text check (contact_name is null or length(btrim(contact_name)) between 2 and 120),
  acceptance_channel text check (acceptance_channel is null or acceptance_channel in ('email', 'signed_form', 'portal', 'meeting')),
  acceptance_proof text check (acceptance_proof is null or length(btrim(acceptance_proof)) between 10 and 500),
  accepted_on      date,
  decision_note    text check (decision_note is null or length(btrim(decision_note)) <= 300),
  unique (spec_id, version_no),
  constraint bat_sod_ck check (decided_by is null or decided_by is distinct from issued_by),
  constraint bat_approved_ck check (status <> 'approved' or (contact_id is not null and contact_name is not null and acceptance_channel is not null
     and acceptance_proof is not null and accepted_on is not null and decided_by is not null and decided_at is not null)),
  constraint bat_rejected_ck check (status <> 'rejected' or (contact_id is not null and decided_by is not null and decision_note is not null))
);
create index bat_proofs_spec_idx on public.bat_proofs (spec_id, status);
create function private.bat_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'APPEND_ONLY' using errcode = '55000'; end if;
  if (new.company_id, new.spec_id, new.version_no, new.document_id, new.pdf_sha256, new.spec_hash, new.issued_by, new.issued_at)
     is distinct from (old.company_id, old.spec_id, old.version_no, old.document_id, old.pdf_sha256, old.spec_hash, old.issued_by, old.issued_at) then
    raise exception 'APPEND_ONLY' using errcode = '55000';
  end if;
  if old.status = 'issued' and new.status in ('approved', 'rejected', 'superseded') then return new; end if;
  if old.status = 'approved' and new.status = 'superseded' then return new; end if;
  raise exception 'BAT_BAD_STATUS' using errcode = '55000';
end $$;
create trigger bat_proofs_guard before update or delete on public.bat_proofs
  for each row execute function private.bat_guard();
alter table public.bat_proofs enable row level security;
create policy bat_proofs_select on public.bat_proofs for select to authenticated
  using (company_id = private.current_company() and private.has_perm('personalization.read'));
grant select on public.bat_proofs to authenticated;

-- Empreinte de la spécification (version exacte du visuel)
create function private.spec_snapshot(p_spec uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('spec_id', s.id, 'version', s.version_no, 'line', s.order_line_id, 'logo', s.logo_id, 'technique', s.technique,
    'placement', s.placement, 'width_mm', s.width_mm, 'height_mm', s.height_mm, 'colors', s.colors, 'notes', s.notes)
  from public.personalization_specs s where s.id = p_spec
$$;

create function public.bat_issue(p_spec uuid, p_document uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); s public.personalization_specs%rowtype; l public.sales_order_lines%rowtype; o public.sales_orders%rowtype;
  d public.ged_documents%rowtype; v_seq int; v_id uuid; v_snap jsonb;
begin
  perform private.require_perm('personalization.write');
  select * into s from public.personalization_specs where id = p_spec and company_id = v_co;
  if not found then raise exception 'PERSO_NOT_FOUND' using errcode = 'P0002'; end if;
  if s.status <> 'current' then raise exception 'PERSO_SPEC_SUPERSEDED' using errcode = '55000'; end if;
  select * into l from public.sales_order_lines where id = s.order_line_id;
  select * into o from public.sales_orders where id = l.order_id;
  if not private.logo_rights_valid((select id from public.client_logos where id = s.logo_id), current_date) then raise exception 'LOGO_RIGHTS_INVALID' using errcode = '55000'; end if;
  select d2.* into d from public.ged_documents d2 join public.ged_folders f on f.id = d2.folder_id
   where d2.id = p_document and d2.client_id = o.client_id and d2.company_id = v_co and f.system_key = 'bat';
  if not found then raise exception 'BAT_DOCUMENT_INVALID' using errcode = '22023', detail = 'dossier BAT du client attendu'; end if;
  if d.sha256 is null then raise exception 'BAT_DOCUMENT_NO_HASH' using errcode = '22023'; end if;
  select coalesce(max(version_no), 0) + 1 into v_seq from public.bat_proofs where spec_id = s.id;
  v_snap := private.spec_snapshot(s.id);
  insert into public.bat_proofs (company_id, spec_id, version_no, document_id, pdf_sha256, spec_hash, issued_by)
  values (v_co, s.id, v_seq, d.id, d.sha256, private.approval_hash(v_snap), auth.uid()) returning id into v_id;
  perform private.write_audit(v_co, 'bat.issue', 'order', o.id::text, o.code, null,
    jsonb_build_object('bat', v_id, 'version', v_seq, 'pdf_sha256', d.sha256, 'spec_version', s.version_no), '{}'::jsonb, 'rpc');
  return v_id;
end $$;
grant execute on function public.bat_issue(uuid, uuid) to authenticated, service_role;

-- Accord : contact habilité, version exacte (empreinte du PDF saisie et comparée), preuve et date ; jamais implicite
create function public.bat_record_acceptance(p_bat uuid, p_contact uuid, p_channel text, p_proof text, p_accepted_on date, p_pdf_sha256 text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); b public.bat_proofs%rowtype; s public.personalization_specs%rowtype; o public.sales_orders%rowtype;
  c public.client_contacts%rowtype; l public.sales_order_lines%rowtype; v_proof text := btrim(coalesce(p_proof, '')); v_name text;
begin
  perform private.require_perm('personalization.write');
  select * into b from public.bat_proofs where id = p_bat and company_id = v_co for update;
  if not found then raise exception 'BAT_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into s from public.personalization_specs where id = b.spec_id;
  if s.status <> 'current' or b.status = 'superseded' then raise exception 'BAT_SUPERSEDED' using errcode = '55000', detail = 'version non courante : accord refusé'; end if;
  if b.status <> 'issued' then raise exception 'BAT_BAD_STATUS' using errcode = '55000'; end if;
  if lower(coalesce(p_pdf_sha256, '')) is distinct from b.pdf_sha256 then raise exception 'BAT_VERSION_MISMATCH' using errcode = '22023', detail = 'empreinte du PDF différente'; end if;
  if b.issued_by = auth.uid() then raise exception 'SOD_SELF_APPROVAL' using errcode = '42501', detail = 'bat'; end if;
  if length(v_proof) < 10 then raise exception 'BAT_PROOF_REQUIRED' using errcode = '22023'; end if;
  if p_channel not in ('email', 'signed_form', 'portal', 'meeting') then raise exception 'BAT_CHANNEL_INVALID' using errcode = '22023'; end if;
  if p_accepted_on is null or p_accepted_on > current_date or p_accepted_on < b.issued_at::date then raise exception 'BAT_DATE_INVALID' using errcode = '22023'; end if;
  select * into c from public.client_contacts where id = p_contact and company_id = v_co;
  if not found then raise exception 'CONTACT_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into l from public.sales_order_lines where id = s.order_line_id;
  select * into o from public.sales_orders where id = l.order_id;
  if c.client_id <> o.client_id then raise exception 'BAT_CONTACT_NOT_HABILITATED' using errcode = '42501', detail = 'contact d’un autre client'; end if;
  if not c.can_approve_bat then raise exception 'BAT_CONTACT_NOT_HABILITATED' using errcode = '42501'; end if;
  v_name := c.full_name;
  update public.bat_proofs set status = 'approved', decided_by = auth.uid(), decided_at = now(), contact_id = c.id, contact_name = v_name,
         acceptance_channel = p_channel, acceptance_proof = v_proof, accepted_on = p_accepted_on where id = b.id;
  perform private.write_audit(v_co, 'bat.approve', 'order', o.id::text, o.code, jsonb_build_object('status', 'issued'),
    jsonb_build_object('status', 'approved', 'version', b.version_no, 'pdf_sha256', b.pdf_sha256), jsonb_build_object('contact', c.id, 'contact_name', v_name, 'channel', p_channel, 'proof', v_proof, 'accepted_on', p_accepted_on), 'rpc');
end $$;
grant execute on function public.bat_record_acceptance(uuid, uuid, text, text, date, text) to authenticated, service_role;

create function public.bat_record_rejection(p_bat uuid, p_contact uuid, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); b public.bat_proofs%rowtype; c public.client_contacts%rowtype; o public.sales_orders%rowtype; l public.sales_order_lines%rowtype; s public.personalization_specs%rowtype;
begin
  perform private.require_perm('personalization.write');
  select * into b from public.bat_proofs where id = p_bat and company_id = v_co for update;
  if not found then raise exception 'BAT_NOT_FOUND' using errcode = 'P0002'; end if;
  if b.status <> 'issued' then raise exception 'BAT_BAD_STATUS' using errcode = '55000'; end if;
  if length(btrim(coalesce(p_note, ''))) < 5 then raise exception 'BAT_NOTE_REQUIRED' using errcode = '22023'; end if;
  select * into c from public.client_contacts where id = p_contact and company_id = v_co;
  select * into s from public.personalization_specs where id = b.spec_id;
  select * into l from public.sales_order_lines where id = s.order_line_id;
  select * into o from public.sales_orders where id = l.order_id;
  if not found or c.client_id <> o.client_id or not c.can_approve_bat then raise exception 'BAT_CONTACT_NOT_HABILITATED' using errcode = '42501'; end if;
  update public.bat_proofs set status = 'rejected', decided_by = auth.uid(), decided_at = now(), contact_id = c.id, contact_name = c.full_name,
         decision_note = btrim(p_note) where id = b.id;
  perform private.write_audit(v_co, 'bat.reject', 'order', o.id::text, o.code, jsonb_build_object('status', 'issued'),
    jsonb_build_object('status', 'rejected', 'version', b.version_no), jsonb_build_object('contact', c.id, 'note', btrim(p_note)), 'rpc');
end $$;
grant execute on function public.bat_record_rejection(uuid, uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 6. Opération de personnalisation : bloquée sans BAT approuvé de la version courante et sans droits valides
-- ---------------------------------------------------------------------
create table public.personalization_operations (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null default private.current_company() references public.companies(id),
  spec_id      uuid not null unique references public.personalization_specs(id),
  bat_id       uuid not null references public.bat_proofs(id),
  bat_sha256   text not null check (bat_sha256 ~ '^[a-f0-9]{64}$'),
  technique    text not null,
  started_by   uuid default auth.uid(),
  started_at   timestamptz not null default now()
);
create trigger personalization_operations_no_change before update or delete on public.personalization_operations
  for each row execute function private.append_only_guard();
alter table public.personalization_operations enable row level security;
create policy personalization_operations_select on public.personalization_operations for select to authenticated
  using (company_id = private.current_company() and private.has_perm('personalization.read'));
grant select on public.personalization_operations to authenticated;

create function public.personalization_operation_start(p_spec uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); s public.personalization_specs%rowtype; b public.bat_proofs%rowtype; v_id uuid; o public.sales_orders%rowtype; l public.sales_order_lines%rowtype;
begin
  perform private.require_perm('personalization.operate');
  select * into s from public.personalization_specs where id = p_spec and company_id = v_co for update;
  if not found then raise exception 'PERSO_NOT_FOUND' using errcode = 'P0002'; end if;
  if s.status <> 'current' then raise exception 'PERSO_SPEC_SUPERSEDED' using errcode = '55000'; end if;
  select * into l from public.sales_order_lines where id = s.order_line_id;
  select * into o from public.sales_orders where id = l.order_id;
  if o.status <> 'confirmed' then raise exception 'PERSO_ORDER_NOT_CONFIRMED' using errcode = '55000'; end if;
  if not private.logo_rights_valid(s.logo_id, current_date) then raise exception 'LOGO_RIGHTS_INVALID' using errcode = '55000'; end if;
  -- BAT approuvé pour la version courante, et une seule version approuvée peut exister
  select * into b from public.bat_proofs where spec_id = s.id and status = 'approved' order by version_no desc limit 1;
  if not found then raise exception 'PERSO_NO_VALID_BAT' using errcode = '55000'; end if;
  insert into public.personalization_operations (company_id, spec_id, bat_id, bat_sha256, technique)
  values (v_co, s.id, b.id, b.pdf_sha256, s.technique) returning id into v_id;
  perform private.write_audit(v_co, 'perso.operation_start', 'order', o.id::text, o.code, null,
    jsonb_build_object('bat', b.id, 'bat_version', b.version_no, 'pdf_sha256', b.pdf_sha256, 'technique', s.technique), '{}'::jsonb, 'rpc');
  return v_id;
end $$;
grant execute on function public.personalization_operation_start(uuid) to authenticated, service_role;

-- Verrouillage : écritures par fonctions uniquement
revoke all on public.client_logos, public.personalization_specs, public.bat_proofs, public.personalization_operations from anon;
revoke insert, update, delete, truncate on public.client_logos, public.personalization_specs, public.bat_proofs, public.personalization_operations from authenticated;
