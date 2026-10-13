-- =====================================================================
-- 0049_quotes_pricing_versions — Devis : SKU, personnalisation, remise bloquée hors seuil, versions, conversion unique (P024)
--  Socle réutilisé et CONSERVÉ : devis et lignes (0012), recalcul des totaux (doc_recalc), verrou des lignes hors brouillon,
--  transformation en commande (quote_to_order, toujours refusée au second passage), remises signées par client (0040,
--  client_discount_rules), variantes SKU (0015), moteur d'approbation (0043 : objet « quote », seuil et accord lié au hash).
--  Ajouts :
--    1. Lignes : variante SKU (tailles et couleurs), personnalisation (texte), copiées à la commande et à la révision.
--    2. Remise bloquée : une ligne dont la remise dépasse la limite signée du client (ou sans limite signée, pour un prospect)
--       met le devis en « accord requis ». Il ne peut être ni envoyé, ni accepté, ni converti sans accord valide pour son contenu.
--    3. Accord : quote_request_approval soumet le contenu au moteur d'approbation (politique « quote », configurée par
--       approvals.manage). Une modification après accord change le hash : l'accord est périmé et doit être redemandé.
--    4. Versions : quote_revise crée une NOUVELLE version (même famille, numéro +1) ; l'ancienne devient « superseded ».
--       Un devis accepté n'est jamais modifié : toute évolution passe par une nouvelle version.
--    5. Historique immuable : quote_versions garde le contenu tel qu'envoyé ou accepté (hash et instantané).
--    6. Conversion : quote_convert(devis, clé) est idempotente (même clé = même commande ; autre clé = refus) ; index unique
--       « une commande par devis » en base.
--    7. PDF : quote_document fournit l'instantané (courant ou versionné) que l'application met en PDF.
--  Règles de montant (inchangées, vérifiées par test) : ligne = arrondi à 2 décimales de qté × prix × (1 − remise) ;
--  TVA = arrondi à 2 décimales du sous-total × taux ; total = sous-total + TVA.
--  Limites : l'arrondi suit la règle existante à 2 décimales (pas la décimale de la devise) ; les lignes sans variante gardent
--  leur description libre ; la politique d'approbation « quote » n'est créée par personne (décision à prendre par l'entreprise).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Colonnes additives
-- ---------------------------------------------------------------------
alter table public.quotes
  add column family_id       uuid,
  add column version_no      int not null default 1 check (version_no >= 1),
  add column superseded_by   uuid references public.quotes(id),
  add column requires_approval boolean not null default false,
  add column conversion_key  text check (conversion_key is null or length(btrim(conversion_key)) between 8 and 120);
-- Statut « remplacé » pour une version antérieure (la nouvelle version reprend le travail)
alter table public.quotes drop constraint quotes_status_check;
alter table public.quotes add constraint quotes_status_check check (status in ('draft','sent','accepted','rejected','converted','cancelled','superseded'));
update public.quotes set family_id = id where family_id is null;
alter table public.quotes alter column family_id set default gen_random_uuid();
alter table public.quotes alter column family_id set not null;
create unique index quotes_conversion_key_uq on public.quotes (company_id, conversion_key) where conversion_key is not null;

alter table public.quote_lines
  add column variant_id    uuid references public.product_variants(id),
  add column customization text check (customization is null or length(btrim(customization)) between 1 and 300);

alter table public.sales_order_lines
  add column variant_id    uuid references public.product_variants(id),
  add column customization text check (customization is null or length(btrim(customization)) between 1 and 300);

-- Une seule commande par devis (garantie en base)
create unique index sales_orders_quote_uq on public.sales_orders (quote_id) where quote_id is not null;

-- Droits de colonne : saisie des SKU et personnalisation par les mêmes personnes que les autres champs de ligne
grant insert (pos) on public.quote_lines to authenticated;                -- ordre des lignes (absent du socle 0012)
grant insert (variant_id, customization) on public.quote_lines to authenticated;
grant update (variant_id, customization) on public.quote_lines to authenticated;

-- ---------------------------------------------------------------------
-- 2. Instantané du devis (base de la version, de l'accord et du PDF)
-- ---------------------------------------------------------------------
create function private.quote_snapshot(p_quote uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'code', q.code, 'version', q.version_no, 'client_id', q.client_id, 'prospect_id', q.prospect_id,
    'currency', q.currency, 'tax_rate', q.tax_rate, 'quote_date', q.quote_date, 'valid_until', q.valid_until,
    'lead_days', q.lead_days, 'payment_terms', q.payment_terms, 'notes', q.notes,
    'subtotal', q.subtotal, 'tax_amount', q.tax_amount, 'total', q.total,
    'lines', coalesce((select jsonb_agg(jsonb_build_object(
        'pos', l.pos, 'sku', v.sku, 'description', l.description, 'qty', l.qty, 'unit_price', l.unit_price,
        'discount_pct', l.discount_pct, 'line_total', round(l.qty * l.unit_price * (1 - l.discount_pct / 100), 2),
        'customization', l.customization) order by l.pos)
        from public.quote_lines l left join public.product_variants v on v.id = l.variant_id where l.quote_id = q.id), '[]'::jsonb))
  from public.quotes q where q.id = p_quote
$$;
revoke execute on function private.quote_snapshot(uuid) from public, anon, authenticated;

-- Historique immuable des contenus envoyés / acceptés
create table public.quote_versions (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  quote_id     uuid not null references public.quotes(id),
  seq          int not null check (seq >= 1),
  label        text not null check (label in ('sent', 'accepted', 'approval_requested')),
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  snapshot     jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  recorded_by  uuid default auth.uid(),
  recorded_at  timestamptz not null default now(),
  unique (quote_id, seq)
);
create trigger quote_versions_no_change before update or delete on public.quote_versions
  for each row execute function private.append_only_guard();

create function private.quote_record_version(p_quote uuid, p_label text) returns void
language plpgsql security definer set search_path = '' as $$
declare v jsonb := private.quote_snapshot(p_quote); v_co uuid; v_seq int;
begin
  select company_id into v_co from public.quotes where id = p_quote;
  select coalesce(max(seq), 0) + 1 into v_seq from public.quote_versions where quote_id = p_quote;
  insert into public.quote_versions (company_id, quote_id, seq, label, content_hash, snapshot)
  values (v_co, p_quote, v_seq, p_label, private.approval_hash(v), v);
end $$;
revoke execute on function private.quote_record_version(uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Remise bloquée : indicateur calculé à chaque changement de ligne
-- ---------------------------------------------------------------------
create function private.quote_refresh_approval_flag(p_quote uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_prev text := coalesce(current_setting('commercial.rpc', true), 'off');
begin
  perform set_config('commercial.rpc', 'on', true);
  update public.quotes q set requires_approval = exists (
      select 1 from public.quote_lines l
       where l.quote_id = q.id
         and l.discount_pct > coalesce((select max(r.max_discount_pct) from public.client_discount_rules r
                                         where r.company_id = q.company_id and r.client_id = q.client_id and r.status = 'valide'
                                           and q.quote_date >= r.effective_from and (r.effective_to is null or q.quote_date <= r.effective_to)), 0))
   where q.id = p_quote;
  perform set_config('commercial.rpc', v_prev, true);
end $$;
revoke execute on function private.quote_refresh_approval_flag(uuid) from public, anon, authenticated;

create function private.quote_lines_flag() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.quote_refresh_approval_flag(coalesce(new.quote_id, old.quote_id));
  return null;
end $$;
revoke execute on function private.quote_lines_flag() from public, anon, authenticated;
create trigger quote_lines_approval_flag after insert or update or delete on public.quote_lines
  for each row execute function private.quote_lines_flag();

-- Variante : doit appartenir au même client que le devis (ou au même prospect : aucun client)
create function private.quote_line_variant_check() returns trigger
language plpgsql security definer set search_path = '' as $$
declare q public.quotes%rowtype; v_client uuid;
begin
  if new.variant_id is null then return new; end if;
  select * into q from public.quotes where id = new.quote_id;
  select pm.client_id into v_client from public.product_variants v join public.product_master pm on pm.id = v.product_id where v.id = new.variant_id;
  if v_client is null or q.client_id is distinct from v_client then raise exception 'QUOTE_BAD_VARIANT' using errcode = '22023'; end if;
  return new;
end $$;
revoke execute on function private.quote_line_variant_check() from public, anon, authenticated;
create trigger quote_lines_variant_check_bi before insert or update of variant_id on public.quote_lines
  for each row execute function private.quote_line_variant_check();

-- ---------------------------------------------------------------------
-- 4. Accord requis : contrôle et soumission au moteur d'approbation
-- ---------------------------------------------------------------------
create function private.quote_check_agreement(p_quote uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare q public.quotes%rowtype;
begin
  select * into q from public.quotes where id = p_quote;
  if not q.requires_approval then return; end if;
  begin
    perform public.approval_assert_current('quote', p_quote, private.quote_snapshot(p_quote));
  exception when others then
    raise exception 'QUOTE_APPROVAL_REQUIRED' using errcode = '55000', detail = sqlerrm;
  end;
end $$;
revoke execute on function private.quote_check_agreement(uuid) from public, anon, authenticated;

create function public.quote_request_approval(p_quote uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare q public.quotes%rowtype; v_id uuid;
begin
  perform private.require_perm('quotes.write');
  select * into q from public.quotes where id = p_quote and company_id = private.current_company();
  if not found then raise exception 'COMMERCIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if q.status not in ('draft', 'sent') then raise exception 'COMMERCIAL_BAD_STATUS' using errcode = '55000'; end if;
  if not q.requires_approval then raise exception 'QUOTE_NO_APPROVAL_NEEDED' using errcode = '55000'; end if;
  v_id := public.approval_request_create('quote', p_quote, private.quote_snapshot(p_quote), q.total);
  perform private.quote_record_version(p_quote, 'approval_requested');
  return v_id;
end $$;
grant execute on function public.quote_request_approval(uuid) to authenticated, service_role;

-- Envoi : contenu accepté par le moteur si la remise l'exige ; instantané conservé
create or replace function public.quote_send(p_quote uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare q public.quotes%rowtype;
begin
  perform private.require_perm('quotes.write');
  select * into q from public.quotes where id = p_quote and company_id = private.current_company() for update;
  if not found then raise exception 'COMMERCIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if q.status <> 'draft' then raise exception 'COMMERCIAL_BAD_STATUS' using errcode = '55000'; end if;
  if not exists (select 1 from public.quote_lines where quote_id = p_quote) then raise exception 'COMMERCIAL_EMPTY' using errcode = '55000'; end if;
  if q.valid_until < current_date then raise exception 'QUOTE_EXPIRED' using errcode = '55000'; end if;
  if q.client_id is not null then perform private.ged_assert_client_open(q.client_id); end if;
  perform private.quote_check_agreement(p_quote);
  perform private.quote_record_version(p_quote, 'sent');
  perform set_config('commercial.rpc', 'on', true);
  update public.quotes set status = 'sent', sent_at = now() where id = p_quote;
  if q.prospect_id is not null then
    update public.prospects set stage = 'proposal', stage_changed_at = now() where id = q.prospect_id and stage in ('new', 'contacted', 'qualified');
  end if;
  perform set_config('commercial.rpc', 'off', true);
  perform private.write_audit(q.company_id, 'quote.send', 'quote', q.id::text, q.code, null, null, jsonb_build_object('total', q.total), 'rpc');
end $$;

-- Réponse du client : accord requis aussi pour l'acceptation ; l'instantané accepté est conservé
create or replace function public.quote_decide(p_quote uuid, p_accept boolean, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare q public.quotes%rowtype;
begin
  perform private.require_perm('quotes.write');
  select * into q from public.quotes where id = p_quote and company_id = private.current_company() for update;
  if not found then raise exception 'COMMERCIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if q.status <> 'sent' then raise exception 'COMMERCIAL_BAD_STATUS' using errcode = '55000'; end if;
  if p_accept and q.valid_until < current_date then raise exception 'QUOTE_EXPIRED' using errcode = '55000'; end if;
  if not p_accept and length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'QUOTE_REASON_REQUIRED' using errcode = '22023'; end if;
  if p_accept then
    perform private.quote_check_agreement(p_quote);
    perform private.quote_record_version(p_quote, 'accepted');
  end if;
  perform set_config('commercial.rpc', 'on', true);
  update public.quotes set status = case when p_accept then 'accepted' else 'rejected' end, decided_at = now(), decision_reason = nullif(btrim(coalesce(p_reason, '')), '') where id = p_quote;
  if p_accept and q.prospect_id is not null then
    update public.prospects set stage = 'negotiation', stage_changed_at = now() where id = q.prospect_id and stage in ('new', 'contacted', 'qualified', 'proposal');
  end if;
  perform set_config('commercial.rpc', 'off', true);
  perform private.write_audit(q.company_id, case when p_accept then 'quote.accept' else 'quote.reject' end, 'quote', q.id::text, q.code, null, null,
    jsonb_build_object('reason', nullif(btrim(coalesce(p_reason, '')), '')), 'rpc');
end $$;

-- Duplication : reprend aussi la variante SKU et la personnalisation
create or replace function public.quote_duplicate(p_quote uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare q public.quotes%rowtype; v_id uuid := gen_random_uuid();
begin
  perform private.require_perm('quotes.write');
  select * into q from public.quotes where id = p_quote and company_id = private.current_company();
  if not found then raise exception 'COMMERCIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  perform set_config('commercial.rpc', 'on', true);
  insert into public.quotes (id, company_id, client_id, prospect_id, currency, tax_rate, payment_terms, lead_days, notes, family_id, version_no)
  values (v_id, q.company_id, q.client_id, q.prospect_id, q.currency, q.tax_rate, q.payment_terms, q.lead_days, q.notes, q.family_id, 1);
  insert into public.quote_lines (company_id, quote_id, pos, article_id, description, qty, unit_price, discount_pct, variant_id, customization)
  select company_id, v_id, pos, article_id, description, qty, unit_price, discount_pct, variant_id, customization from public.quote_lines where quote_id = p_quote order by pos;
  perform set_config('commercial.rpc', 'off', true);
  perform private.write_audit(q.company_id, 'quote.create', 'quote', v_id::text, (select code from public.quotes where id = v_id), null,
    jsonb_build_object('copy_of', q.code), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- 5. Versions : une révision après envoi ou acceptation crée un nouveau devis (même famille, numéro + 1)
-- ---------------------------------------------------------------------
create function public.quote_revise(p_quote uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare q public.quotes%rowtype; v_new uuid := gen_random_uuid(); v_code text;
begin
  perform private.require_perm('quotes.write');
  select * into q from public.quotes where id = p_quote and company_id = private.current_company() for update;
  if not found then raise exception 'COMMERCIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if q.status not in ('sent', 'accepted', 'rejected') then raise exception 'COMMERCIAL_BAD_STATUS' using errcode = '55000'; end if;
  perform set_config('commercial.rpc', 'on', true);
  insert into public.quotes (id, company_id, client_id, prospect_id, currency, tax_rate, payment_terms, lead_days, notes, family_id, version_no, valid_until)
  values (v_new, q.company_id, q.client_id, q.prospect_id, q.currency, q.tax_rate, q.payment_terms, q.lead_days, q.notes, q.family_id, q.version_no + 1,
          greatest(q.valid_until, current_date + 30));
  insert into public.quote_lines (company_id, quote_id, pos, article_id, description, qty, unit_price, discount_pct, variant_id, customization)
  select company_id, v_new, pos, article_id, description, qty, unit_price, discount_pct, variant_id, customization from public.quote_lines where quote_id = p_quote order by pos;
  update public.quotes set status = 'superseded', superseded_by = v_new where id = p_quote;
  perform set_config('commercial.rpc', 'off', true);
  select code into v_code from public.quotes where id = v_new;
  perform private.write_audit(q.company_id, 'quote.revise', 'quote', q.id::text, q.code, jsonb_build_object('status', q.status),
    jsonb_build_object('new_version', q.version_no + 1, 'new_quote', v_code), '{}'::jsonb, 'rpc');
  return v_new;
end $$;
grant execute on function public.quote_revise(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 6. Conversion en commande : idempotente par clé ; une seule commande par devis
-- ---------------------------------------------------------------------
create function public.quote_convert(p_quote uuid, p_key text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare q public.quotes%rowtype; v_order uuid := gen_random_uuid(); v_code text; v_key text := btrim(coalesce(p_key, ''));
begin
  perform private.require_perm('quotes.write');
  perform private.require_perm('orders.write');
  if length(v_key) < 8 then raise exception 'QUOTE_KEY_REQUIRED' using errcode = '22023'; end if;
  select * into q from public.quotes where id = p_quote and company_id = private.current_company() for update;
  if not found then raise exception 'COMMERCIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if q.conversion_key is not null then
    if q.conversion_key = v_key then return q.order_id; end if;             -- relance avec la même clé : même commande
    raise exception 'QUOTE_ALREADY_CONVERTED' using errcode = '55000';
  end if;
  if q.status <> 'accepted' then raise exception 'COMMERCIAL_BAD_STATUS' using errcode = '55000'; end if;
  if q.client_id is null then raise exception 'QUOTE_PROSPECT_NOT_CONVERTED' using errcode = '55000'; end if;
  perform private.ged_assert_client_open(q.client_id);
  perform private.quote_check_agreement(p_quote);
  perform set_config('commercial.rpc', 'on', true);
  insert into public.sales_orders (id, company_id, client_id, client_ref, quote_id, currency, tax_rate, payment_terms, notes)
  values (v_order, q.company_id, q.client_id, null, q.id, q.currency, q.tax_rate, q.payment_terms, 'Issue du devis ' || q.code || coalesce(E'\n' || q.notes, ''));
  insert into public.sales_order_lines (company_id, order_id, article_id, description, qty, unit_price, discount_pct, due_date, variant_id, customization)
  select company_id, v_order, article_id, description, qty, unit_price, discount_pct, current_date + q.lead_days, variant_id, customization
    from public.quote_lines where quote_id = p_quote order by pos;
  update public.quotes set status = 'converted', order_id = v_order, conversion_key = v_key where id = p_quote;
  perform set_config('commercial.rpc', 'off', true);
  select code into v_code from public.sales_orders where id = v_order;
  perform private.write_audit(q.company_id, 'quote.convert', 'quote', q.id::text, q.code, null, null,
    jsonb_build_object('order', v_code, 'key', left(v_key, 8)), 'rpc');
  return v_order;
end $$;
grant execute on function public.quote_convert(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 7. Instantané pour le PDF : courant, ou une version historique
-- ---------------------------------------------------------------------
create function public.quote_document(p_quote uuid, p_seq int default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_co uuid := private.current_company(); v_snap jsonb; v_seq int; v_label text; v_hash text;
begin
  perform private.require_perm('quotes.read');
  if not exists (select 1 from public.quotes where id = p_quote and company_id = v_co) then raise exception 'COMMERCIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_seq is null then
    v_snap := private.quote_snapshot(p_quote); v_seq := null; v_label := 'courant'; v_hash := private.approval_hash(v_snap);
  else
    select snapshot, seq, label, content_hash into v_snap, v_seq, v_label, v_hash from public.quote_versions
     where quote_id = p_quote and seq = p_seq and company_id = v_co;
    if not found then raise exception 'COMMERCIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  end if;
  return jsonb_build_object('snapshot', v_snap, 'seq', v_seq, 'label', v_label, 'hash', v_hash);
end $$;
grant execute on function public.quote_document(uuid, int) to authenticated, service_role;

-- Transformation historique : même chemin que quote_convert (SKU et personnalisation copiés) ; un devis déjà converti reste refusé
create or replace function public.quote_to_order(p_quote uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare q public.quotes%rowtype;
begin
  select * into q from public.quotes where id = p_quote and company_id = private.current_company();
  if not found then raise exception 'COMMERCIAL_NOT_FOUND' using errcode = 'P0002'; end if;
  if q.status = 'converted' then raise exception 'COMMERCIAL_BAD_STATUS' using errcode = '55000'; end if;
  return public.quote_convert(p_quote, 'quote-convert:' || p_quote::text);
end $$;

-- Lecture de l'historique des versions (journal immuable) : même droit que la lecture des devis
alter table public.quote_versions enable row level security;
create policy quote_versions_select on public.quote_versions for select to authenticated
  using (company_id = private.current_company() and private.has_perm('quotes.read'));
grant select on public.quote_versions to authenticated;
