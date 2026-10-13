-- 0078_norm_standards_evidence — Normes EPI et preuves documentaires (P054) : registre des normes (édition, amendement, marché),
-- applicabilité confirmée par la qualité par produit, essais et certificats rattachés au produit ET à sa version, échéances.
--
-- Règles :
--  * Aucun statut « certifié produit » n'est créé ici. Le seul statut produit est « preuve documentaire valide » : un certificat
--    daté, rattaché à la version et à l'édition, avec son document GED. Un essai (rapport) n'alimente jamais un statut.
--  * Une norme de périmètre « organisation » (ISO 9001) se rattache à la société, jamais à un produit.
--  * Une norme de périmètre « produit » (EN ISO 20471, EN 343, EN ISO 13688, EN 14058) : certificat et essai exigent produit,
--    version du produit, édition de la norme et document GED du même client.
--  * Applicabilité : confirmée par la qualité (quality.approve). Sans confirmation, la norme est « à confirmer ».
--  * Édition, amendement et marché sont saisis par la société ; aucune édition n'est inventée. Intitulés et éditions restent vides
--    tant que la qualité ne les a pas renseignés.
--  * Écritures uniquement par fonctions (aucun DML direct), toutes auditées.
-- Droits existants réutilisés : certifications.read / certifications.write (0003), quality.approve (0003), products.write (0013).
-- Erreurs : NORM_STANDARD_NOT_FOUND, NORM_SCOPE_MISMATCH, NORM_EDITION_MISMATCH, NORM_VERSION_MISMATCH, NORM_VERSION_OBSOLETE,
-- NORM_DOCUMENT_NOT_FOUND, NORM_DOCUMENT_CLIENT_MISMATCH, NORM_RATIONALE_REQUIRED, NORM_REASON_REQUIRED, NORM_BAD_STATUS,
-- NORM_ALERT_DAYS_INVALID, NORM_PRODUCT_NOT_FOUND, RBAC_FORBIDDEN.

-- ---------------------------------------------------------------------------
-- 1. Registre des normes
-- ---------------------------------------------------------------------------
create table public.norm_standards (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null default private.current_company() references public.companies(id) on delete cascade,
  code        text not null check (length(btrim(code)) between 2 and 40),
  scope       text not null check (scope in ('product', 'organization')),
  title       text check (title is null or length(btrim(title)) between 2 and 200),   -- renseigné par la qualité
  note        text check (note is null or length(note) <= 500),
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid(),
  unique (company_id, code)
);

create table public.norm_editions (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null default private.current_company() references public.companies(id) on delete cascade,
  standard_id  uuid not null references public.norm_standards(id) on delete restrict,
  edition      text not null check (length(btrim(edition)) between 1 and 60),
  amendment    text check (amendment is null or length(btrim(amendment)) between 1 and 60),
  market       text check (market is null or length(btrim(market)) between 1 and 60),
  published_on date,
  created_at   timestamptz not null default now(),
  created_by   uuid default auth.uid()
);
create unique index norm_editions_uq on public.norm_editions (standard_id, edition, coalesce(amendment, ''), coalesce(market, ''));

-- Applicabilité d'une norme produit, confirmée par la qualité
create table public.product_norm_requirements (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null default private.current_company() references public.companies(id) on delete cascade,
  product_id   uuid not null references public.product_master(id) on delete cascade,
  standard_id  uuid not null references public.norm_standards(id) on delete restrict,
  applies      boolean not null,
  edition_id   uuid references public.norm_editions(id) on delete restrict,
  rationale    text not null check (length(btrim(rationale)) between 5 and 500),
  confirmed_by uuid not null,
  confirmed_at timestamptz not null default now(),
  unique (product_id, standard_id)
);

-- Essais (rapports) : preuve de test, sans effet sur le statut
create table public.norm_tests (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null default private.current_company() references public.companies(id) on delete cascade,
  product_id         uuid not null references public.product_master(id) on delete restrict,
  product_version_id uuid not null references public.product_versions(id) on delete restrict,
  standard_id        uuid not null references public.norm_standards(id) on delete restrict,
  edition_id         uuid not null references public.norm_editions(id) on delete restrict,
  laboratory         text not null check (length(btrim(laboratory)) between 2 and 120),
  report_no          text not null check (length(btrim(report_no)) between 1 and 80),
  tested_on          date not null,
  result             text not null check (result in ('pass', 'fail')),
  ged_document_id    uuid not null references public.ged_documents(id) on delete restrict,
  recorded_by        uuid default auth.uid(),
  recorded_at        timestamptz not null default now(),
  unique (product_version_id, standard_id, report_no)
);

-- Certificats : preuve documentaire datée. Produit : produit + version + édition. Organisation : société seule.
create table public.norm_certificates (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null default private.current_company() references public.companies(id) on delete cascade,
  product_id          uuid references public.product_master(id) on delete restrict,
  product_version_id  uuid references public.product_versions(id) on delete restrict,
  standard_id         uuid not null references public.norm_standards(id) on delete restrict,
  edition_id          uuid not null references public.norm_editions(id) on delete restrict,
  certificate_no      text not null check (length(btrim(certificate_no)) between 1 and 80),
  issuer              text not null check (length(btrim(issuer)) between 2 and 120),
  issued_on           date not null,
  valid_until         date not null,
  status              text not null default 'valid' check (status in ('valid', 'suspended', 'withdrawn')),
  status_reason       text check (status_reason is null or length(btrim(status_reason)) between 5 and 500),
  status_changed_by   uuid,
  status_changed_at   timestamptz,
  ged_document_id     uuid not null references public.ged_documents(id) on delete restrict,
  recorded_by         uuid default auth.uid(),
  recorded_at         timestamptz not null default now(),
  constraint norm_cert_dates_ck check (valid_until >= issued_on),
  constraint norm_cert_scope_ck check ((product_id is null) = (product_version_id is null))
);
create index norm_certificates_version_idx on public.norm_certificates (product_version_id, standard_id);
create index norm_certificates_expiry_idx on public.norm_certificates (company_id, valid_until) where status = 'valid';

-- ---------------------------------------------------------------------------
-- 2. Garde-fous : cohérence du produit, de la version, de l'édition, du document (y compris en écriture directe)
-- ---------------------------------------------------------------------------
create function private.norm_evidence_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_scope text; v_ed_std uuid; v_ed_co uuid; v_p_co uuid; v_p_client uuid; v_ver_product uuid; v_ver_status text;
  v_doc_co uuid; v_doc_client uuid; v_doc_deleted timestamptz;
begin
  select scope into v_scope from public.norm_standards where id = new.standard_id and company_id = new.company_id;
  if v_scope is null then raise exception 'NORM_STANDARD_NOT_FOUND' using errcode = 'P0002'; end if;
  select standard_id, company_id into v_ed_std, v_ed_co from public.norm_editions where id = new.edition_id;
  if v_ed_std is distinct from new.standard_id or v_ed_co is distinct from new.company_id then
    raise exception 'NORM_EDITION_MISMATCH' using errcode = '22023';
  end if;
  if v_scope = 'organization' then
    if new.product_id is not null or new.product_version_id is not null then raise exception 'NORM_SCOPE_MISMATCH' using errcode = '22023'; end if;
  else
    if new.product_id is null or new.product_version_id is null then raise exception 'NORM_SCOPE_MISMATCH' using errcode = '22023'; end if;
    select company_id, client_id into v_p_co, v_p_client from public.product_master where id = new.product_id;
    if v_p_co is distinct from new.company_id then raise exception 'NORM_PRODUCT_NOT_FOUND' using errcode = 'P0002'; end if;
    select product_id, status into v_ver_product, v_ver_status from public.product_versions where id = new.product_version_id;
    if v_ver_product is distinct from new.product_id then raise exception 'NORM_VERSION_MISMATCH' using errcode = '22023'; end if;
    if v_ver_status = 'obsolete' then raise exception 'NORM_VERSION_OBSOLETE' using errcode = '55000'; end if;
  end if;
  select company_id, client_id, deleted_at into v_doc_co, v_doc_client, v_doc_deleted from public.ged_documents where id = new.ged_document_id;
  if v_doc_co is distinct from new.company_id or v_doc_deleted is not null then raise exception 'NORM_DOCUMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_scope = 'product' and v_doc_client is distinct from v_p_client then raise exception 'NORM_DOCUMENT_CLIENT_MISMATCH' using errcode = '42501'; end if;
  return new;
end $$;
revoke execute on function private.norm_evidence_guard() from public, anon, authenticated;
create trigger norm_tests_guard_bi before insert on public.norm_tests for each row execute function private.norm_evidence_guard();
create trigger norm_certificates_guard_bi before insert on public.norm_certificates for each row execute function private.norm_evidence_guard();

create function private.norm_requirement_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_scope text; v_p_co uuid; v_ed_std uuid; v_ed_co uuid;
begin
  select scope into v_scope from public.norm_standards where id = new.standard_id and company_id = new.company_id;
  if v_scope is null then raise exception 'NORM_STANDARD_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_scope <> 'product' then raise exception 'NORM_SCOPE_MISMATCH' using errcode = '22023'; end if;
  select company_id into v_p_co from public.product_master where id = new.product_id;
  if v_p_co is distinct from new.company_id then raise exception 'NORM_PRODUCT_NOT_FOUND' using errcode = 'P0002'; end if;
  if new.edition_id is not null then
    select standard_id, company_id into v_ed_std, v_ed_co from public.norm_editions where id = new.edition_id;
    if v_ed_std is distinct from new.standard_id or v_ed_co is distinct from new.company_id then
      raise exception 'NORM_EDITION_MISMATCH' using errcode = '22023';
    end if;
  end if;
  return new;
end $$;
revoke execute on function private.norm_requirement_guard() from public, anon, authenticated;
create trigger product_norm_requirements_guard_biu before insert or update on public.product_norm_requirements
  for each row execute function private.norm_requirement_guard();

-- ---------------------------------------------------------------------------
-- 3. Sécurité des lignes et privilèges
-- ---------------------------------------------------------------------------
alter table public.norm_standards enable row level security;
alter table public.norm_editions enable row level security;
alter table public.product_norm_requirements enable row level security;
alter table public.norm_tests enable row level security;
alter table public.norm_certificates enable row level security;
create policy norm_standards_select on public.norm_standards for select to authenticated
  using (company_id = private.current_company() and private.has_perm('certifications.read'));
create policy norm_editions_select on public.norm_editions for select to authenticated
  using (company_id = private.current_company() and private.has_perm('certifications.read'));
create policy product_norm_requirements_select on public.product_norm_requirements for select to authenticated
  using (company_id = private.current_company() and private.has_perm('certifications.read'));
create policy norm_tests_select on public.norm_tests for select to authenticated
  using (company_id = private.current_company() and private.has_perm('certifications.read'));
create policy norm_certificates_select on public.norm_certificates for select to authenticated
  using (company_id = private.current_company() and private.has_perm('certifications.read'));
revoke all on public.norm_standards, public.norm_editions, public.product_norm_requirements, public.norm_tests, public.norm_certificates
  from anon, authenticated;
grant select on public.norm_standards, public.norm_editions, public.product_norm_requirements, public.norm_tests, public.norm_certificates
  to authenticated;
grant all on public.norm_standards, public.norm_editions, public.product_norm_requirements, public.norm_tests, public.norm_certificates
  to service_role;

-- Registre initial : cinq normes déclarées dans le cahier, sans intitulé ni édition (à renseigner par la qualité)
insert into public.norm_standards (company_id, code, scope, note)
select c.id, v.code, v.scope, 'Norme déclarée dans le cahier (P054) ; intitulé et éditions à renseigner par la qualité'
from public.companies c
cross join (values ('ISO 9001', 'organization'), ('EN ISO 20471', 'product'), ('EN 343', 'product'),
                    ('EN ISO 13688', 'product'), ('EN 14058', 'product')) v(code, scope)
on conflict (company_id, code) do nothing;

-- ---------------------------------------------------------------------------
-- 4. Registre : normes et éditions
-- ---------------------------------------------------------------------------
create function public.norm_standard_add(p_code text, p_scope text, p_title text default null, p_note text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('certifications.write');
  if p_scope not in ('product', 'organization') then raise exception 'NORM_SCOPE_MISMATCH' using errcode = '22023'; end if;
  insert into public.norm_standards (id, company_id, code, scope, title, note)
  values (v_id, v_co, btrim(p_code), p_scope, nullif(btrim(coalesce(p_title, '')), ''), nullif(btrim(coalesce(p_note, '')), ''));
  perform private.write_audit(v_co, 'norm.standard_add', 'norm_standard', v_id::text, btrim(p_code), null,
    jsonb_build_object('scope', p_scope), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

create function public.norm_standard_set_title(p_standard uuid, p_title text, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_old public.norm_standards%rowtype;
begin
  perform private.require_perm('certifications.write');
  select * into v_old from public.norm_standards where id = p_standard and company_id = v_co for update;
  if not found then raise exception 'NORM_STANDARD_NOT_FOUND' using errcode = 'P0002'; end if;
  update public.norm_standards set title = nullif(btrim(coalesce(p_title, '')), ''), note = nullif(btrim(coalesce(p_note, '')), '')
    where id = p_standard;
  perform private.write_audit(v_co, 'norm.standard_update', 'norm_standard', p_standard::text, v_old.code,
    jsonb_build_object('title', v_old.title), jsonb_build_object('title', nullif(btrim(coalesce(p_title, '')), '')), '{}'::jsonb, 'rpc');
end $$;

create function public.norm_edition_add(p_standard uuid, p_edition text, p_amendment text default null, p_market text default null,
                                        p_published_on date default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid := gen_random_uuid(); v_code text;
begin
  perform private.require_perm('certifications.write');
  select code into v_code from public.norm_standards where id = p_standard and company_id = v_co;
  if v_code is null then raise exception 'NORM_STANDARD_NOT_FOUND' using errcode = 'P0002'; end if;
  insert into public.norm_editions (id, company_id, standard_id, edition, amendment, market, published_on)
  values (v_id, v_co, p_standard, btrim(p_edition), nullif(btrim(coalesce(p_amendment, '')), ''),
          nullif(btrim(coalesce(p_market, '')), ''), p_published_on);
  perform private.write_audit(v_co, 'norm.edition_add', 'norm_edition', v_id::text, v_code || ' ' || btrim(p_edition), null,
    jsonb_build_object('edition', btrim(p_edition), 'amendment', nullif(btrim(coalesce(p_amendment, '')), ''),
      'market', nullif(btrim(coalesce(p_market, '')), '')), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Applicabilité : confirmée par la qualité, par produit et par norme
-- ---------------------------------------------------------------------------
create function public.norm_requirement_confirm(p_product uuid, p_standard uuid, p_applies boolean, p_edition uuid default null,
                                                p_rationale text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid; v_old public.product_norm_requirements%rowtype; v_code text; v_has boolean;
begin
  perform private.require_perm('quality.approve');
  if p_applies is null then raise exception 'NORM_RATIONALE_REQUIRED' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_rationale, ''))) < 5 then raise exception 'NORM_RATIONALE_REQUIRED' using errcode = '22023'; end if;
  if not exists (select 1 from public.product_master where id = p_product and company_id = v_co) then
    raise exception 'NORM_PRODUCT_NOT_FOUND' using errcode = 'P0002';
  end if;
  select code into v_code from public.norm_standards where id = p_standard and company_id = v_co;
  if v_code is null then raise exception 'NORM_STANDARD_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into v_old from public.product_norm_requirements where product_id = p_product and standard_id = p_standard;
  v_has := found;
  insert into public.product_norm_requirements (company_id, product_id, standard_id, applies, edition_id, rationale, confirmed_by, confirmed_at)
  values (v_co, p_product, p_standard, p_applies, p_edition, btrim(p_rationale), auth.uid(), now())
  on conflict (product_id, standard_id) do update set applies = excluded.applies, edition_id = excluded.edition_id,
    rationale = excluded.rationale, confirmed_by = excluded.confirmed_by, confirmed_at = excluded.confirmed_at
  returning id into v_id;
  perform private.write_audit(v_co, 'norm.requirement_confirm', 'product', p_product::text, v_code,
    case when v_has then jsonb_build_object('applies', v_old.applies, 'edition_id', v_old.edition_id) end,
    jsonb_build_object('applies', p_applies, 'edition_id', p_edition), jsonb_build_object('rationale', btrim(p_rationale)), 'rpc');
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Essais et certificats (preuves documentaires)
-- ---------------------------------------------------------------------------
create function public.norm_test_record(p_product uuid, p_version uuid, p_standard uuid, p_edition uuid, p_laboratory text,
                                        p_report_no text, p_tested_on date, p_result text, p_document uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid := gen_random_uuid(); v_code text;
begin
  perform private.require_perm('certifications.write');
  if p_document is null then raise exception 'NORM_DOCUMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_result not in ('pass', 'fail') then raise exception 'NORM_BAD_STATUS' using errcode = '22023'; end if;
  select code into v_code from public.norm_standards where id = p_standard and company_id = v_co;
  if v_code is null then raise exception 'NORM_STANDARD_NOT_FOUND' using errcode = 'P0002'; end if;
  insert into public.norm_tests (id, company_id, product_id, product_version_id, standard_id, edition_id, laboratory, report_no,
    tested_on, result, ged_document_id)
  values (v_id, v_co, p_product, p_version, p_standard, p_edition, btrim(p_laboratory), btrim(p_report_no), p_tested_on, p_result, p_document);
  perform private.write_audit(v_co, 'norm.test_record', 'product_version', p_version::text, v_code || ' ' || btrim(p_report_no), null,
    jsonb_build_object('result', p_result, 'tested_on', p_tested_on), jsonb_build_object('test', v_id, 'laboratory', btrim(p_laboratory)), 'rpc');
  return v_id;
end $$;

create function public.norm_certificate_record(p_product uuid, p_version uuid, p_standard uuid, p_edition uuid, p_certificate_no text,
                                               p_issuer text, p_issued_on date, p_valid_until date, p_document uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_id uuid := gen_random_uuid(); v_code text;
begin
  perform private.require_perm('certifications.write');
  if p_document is null then raise exception 'NORM_DOCUMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  select code into v_code from public.norm_standards where id = p_standard and company_id = v_co;
  if v_code is null then raise exception 'NORM_STANDARD_NOT_FOUND' using errcode = 'P0002'; end if;
  insert into public.norm_certificates (id, company_id, product_id, product_version_id, standard_id, edition_id, certificate_no, issuer,
    issued_on, valid_until, ged_document_id)
  values (v_id, v_co, p_product, p_version, p_standard, p_edition, btrim(p_certificate_no), btrim(p_issuer), p_issued_on, p_valid_until, p_document);
  perform private.write_audit(v_co, 'norm.certificate_record', 'norm_certificate', v_id::text, v_code || ' ' || btrim(p_certificate_no), null,
    jsonb_build_object('status', 'valid', 'valid_until', p_valid_until), jsonb_build_object('product_version_id', p_version), 'rpc');
  return v_id;
end $$;

create function public.norm_certificate_set_status(p_certificate uuid, p_status text, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_old public.norm_certificates%rowtype;
begin
  perform private.require_perm('certifications.write');
  select * into v_old from public.norm_certificates where id = p_certificate and company_id = v_co for update;
  if not found then raise exception 'NORM_CERTIFICATE_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_status not in ('valid', 'suspended', 'withdrawn') then raise exception 'NORM_BAD_STATUS' using errcode = '22023'; end if;
  if v_old.status = 'withdrawn' or v_old.status = p_status then raise exception 'NORM_BAD_STATUS' using errcode = '55000'; end if;
  if p_status <> 'valid' and length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'NORM_REASON_REQUIRED' using errcode = '22023'; end if;
  update public.norm_certificates set status = p_status, status_reason = nullif(btrim(coalesce(p_reason, '')), ''),
    status_changed_by = auth.uid(), status_changed_at = now() where id = p_certificate;
  perform private.write_audit(v_co, 'norm.certificate_status', 'norm_certificate', p_certificate::text, null,
    jsonb_build_object('status', v_old.status), jsonb_build_object('status', p_status), jsonb_build_object('reason', nullif(btrim(coalesce(p_reason, '')), '')), 'rpc');
end $$;

-- ---------------------------------------------------------------------------
-- 7. Lecture : statut par norme pour une version, et alertes d'échéance
-- ---------------------------------------------------------------------------
-- Statut par norme produit : a_confirmer | non_applicable | edition_a_confirmer | manquant | edition_differente | suspendu_ou_retire
-- | expire | echeance_proche | preuve_valide. Un essai ne change jamais le statut.
create function public.norm_product_status(p_product uuid, p_version uuid default null, p_alert_days int default 60) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_p public.product_master%rowtype; v_v uuid; v_vno int;
  s record; r public.product_norm_requirements%rowtype; c public.norm_certificates%rowtype; t public.norm_tests%rowtype;
  v_items jsonb := '[]'::jsonb; v_item jsonb; v_state text; v_days int; v_ed text; v_has_r boolean; v_has_c boolean; v_has_t boolean;
begin
  perform private.require_perm('certifications.read');
  if p_alert_days is null or p_alert_days < 0 or p_alert_days > 365 then raise exception 'NORM_ALERT_DAYS_INVALID' using errcode = '22023'; end if;
  select * into v_p from public.product_master where id = p_product and company_id = v_co;
  if not found then raise exception 'NORM_PRODUCT_NOT_FOUND' using errcode = 'P0002'; end if;
  v_v := coalesce(p_version, v_p.active_version_id, v_p.current_version_id);
  if v_v is not null then
    select version_no into v_vno from public.product_versions where id = v_v and product_id = p_product;
    if not found then raise exception 'NORM_VERSION_MISMATCH' using errcode = '22023'; end if;
  end if;
  for s in select st.id, st.code from public.norm_standards st where st.company_id = v_co and st.scope = 'product' order by st.code loop
    v_has_r := false; v_has_c := false; v_has_t := false;
    select * into r from public.product_norm_requirements where product_id = p_product and standard_id = s.id;
    v_has_r := found;
    c := null; t := null; v_state := null; v_days := null; v_ed := null;
    if not v_has_r then
      v_state := 'a_confirmer';
    elsif not r.applies then
      v_state := 'non_applicable';
    elsif r.edition_id is null then
      v_state := 'edition_a_confirmer';
    else
      select edition into v_ed from public.norm_editions where id = r.edition_id;
      if v_v is not null then
        select * into c from public.norm_certificates where product_version_id = v_v and standard_id = s.id and edition_id = r.edition_id
          and status = 'valid' order by valid_until desc limit 1;
        v_has_c := found;
        select * into t from public.norm_tests where product_version_id = v_v and standard_id = s.id and edition_id = r.edition_id
          order by tested_on desc limit 1;
        v_has_t := found;
      end if;
      if v_has_c then
        v_days := c.valid_until - current_date;
        if v_days < 0 then v_state := 'expire';
        elsif v_days <= p_alert_days then v_state := 'echeance_proche';
        else v_state := 'preuve_valide';
        end if;
      elsif v_v is not null and exists (select 1 from public.norm_certificates where product_version_id = v_v and standard_id = s.id and status <> 'valid') then
        v_state := 'suspendu_ou_retire';
      elsif v_v is not null and exists (select 1 from public.norm_certificates where product_version_id = v_v and standard_id = s.id) then
        v_state := 'edition_differente';
      else
        v_state := 'manquant';
      end if;
    end if;
    v_item := jsonb_build_object('standard_id', s.id, 'standard_code', s.code, 'state', v_state,
      'applies', case when v_has_r then r.applies end, 'edition_id', case when v_has_r then r.edition_id end, 'edition', v_ed,
      'certificate_id', c.id, 'certificate_no', c.certificate_no, 'valid_until', c.valid_until, 'days_left', v_days,
      'ged_document_id', c.ged_document_id,
      'last_test', case when t.id is not null then jsonb_build_object('report_no', t.report_no, 'tested_on', t.tested_on, 'result', t.result) end);
    v_items := v_items || v_item;
  end loop;
  return jsonb_build_object('product_id', p_product, 'version_id', v_v, 'version_no', v_vno, 'alert_days', p_alert_days, 'standards', v_items,
    'note', 'Preuve documentaire valide = certificat daté rattaché à cette version et à cette édition. Ce n''est pas une certification du produit au-delà de cette version et de cette édition.');
end $$;

create function public.norm_expiry_alerts(p_days int default 60) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_out jsonb;
begin
  perform private.require_perm('certifications.read');
  if p_days is null or p_days < 0 or p_days > 365 then raise exception 'NORM_ALERT_DAYS_INVALID' using errcode = '22023'; end if;
  select coalesce(jsonb_agg(x order by x->>'valid_until'), '[]'::jsonb) into v_out from (
    select jsonb_build_object('certificate_id', c.id, 'certificate_no', c.certificate_no, 'standard_code', st.code,
      'product_id', c.product_id, 'product_version_id', c.product_version_id, 'valid_until', c.valid_until,
      'days_left', c.valid_until - current_date, 'expired', c.valid_until < current_date) as x
    from public.norm_certificates c join public.norm_standards st on st.id = c.standard_id
    where c.company_id = v_co and c.status = 'valid' and c.valid_until <= current_date + p_days
  ) q;
  return v_out;
end $$;

-- ---------------------------------------------------------------------------
-- 8. Privilèges des fonctions
-- ---------------------------------------------------------------------------
revoke execute on function public.norm_standard_add(text, text, text, text), public.norm_standard_set_title(uuid, text, text),
  public.norm_edition_add(uuid, text, text, text, date), public.norm_requirement_confirm(uuid, uuid, boolean, uuid, text),
  public.norm_test_record(uuid, uuid, uuid, uuid, text, text, date, text, uuid),
  public.norm_certificate_record(uuid, uuid, uuid, uuid, text, text, date, date, uuid),
  public.norm_certificate_set_status(uuid, text, text), public.norm_product_status(uuid, uuid, int), public.norm_expiry_alerts(int)
  from public, anon;
grant execute on function public.norm_standard_add(text, text, text, text), public.norm_standard_set_title(uuid, text, text),
  public.norm_edition_add(uuid, text, text, text, date), public.norm_requirement_confirm(uuid, uuid, boolean, uuid, text),
  public.norm_test_record(uuid, uuid, uuid, uuid, text, text, date, text, uuid),
  public.norm_certificate_record(uuid, uuid, uuid, uuid, text, text, date, date, uuid),
  public.norm_certificate_set_status(uuid, text, text), public.norm_product_status(uuid, uuid, int), public.norm_expiry_alerts(int)
  to authenticated, service_role;
