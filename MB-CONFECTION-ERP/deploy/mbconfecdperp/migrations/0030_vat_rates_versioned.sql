-- =====================================================================
-- 0030_vat_rates_versioned — Taux de TVA versionnés par date d'effet (exigence FIN-02)
--  - Plus aucun taux codé dans la fonction : le taux applicable est lu dans vat_rates
--    à la date de l'opération (version en vigueur).
--  - Chaque taux porte un statut : « a_valider » tant que l'expert-comptable ne l'a pas confirmé.
--  - Un taux manquant bloque l'opération (VAT_RATE_MISSING) au lieu de retomber sur 0 %.
-- =====================================================================

-- Une même catégorie peut avoir plusieurs versions datées : la clé devient (code, date d'effet).
alter table public.vat_rates drop constraint vat_rates_pkey;
alter table public.vat_rates add column effective_from date not null default date '2000-01-01';
alter table public.vat_rates add column effective_to date;
alter table public.vat_rates add column status text not null default 'a_valider' check (status in ('a_valider', 'valide'));
alter table public.vat_rates add constraint vat_rates_pkey primary key (code, effective_from);
alter table public.vat_rates add constraint vat_rates_period_check check (effective_to is null or effective_to >= effective_from);

-- Les taux existants (0027) restent à valider : leur valeur n'a pas été confirmée par l'expert-comptable.
update public.vat_rates set status = 'a_valider';

-- Taux applicable à une date pour une catégorie et un pays.
create function private.vat_rate_at(p_kind text, p_country char(2), p_date date) returns numeric
language plpgsql stable security definer set search_path = '' as $$
declare v_rate numeric;
begin
  select v.rate into v_rate
    from public.vat_rates v
   where v.kind = p_kind and v.country = p_country
     and p_date >= v.effective_from and (v.effective_to is null or p_date <= v.effective_to)
   order by v.effective_from desc
   limit 1;
  if v_rate is null then
    raise exception 'VAT_RATE_MISSING' using errcode = 'P0002', detail = p_kind || ' ' || p_country || ' ' || p_date::text;
  end if;
  return v_rate;
end $$;
revoke execute on function private.vat_rate_at(text, char, date) from public, anon, authenticated;

-- Client exonéré : taux « exempt » ; client hors du pays de la société : taux « export » ; sinon taux « standard ».
create or replace function private.client_tax_rate(p_client uuid) returns numeric
language plpgsql stable security definer set search_path = '' as $$
declare v_client public.clients%rowtype; v_home char(2);
begin
  select * into v_client from public.clients where id = p_client;
  if not found then return null; end if;
  select co.country into v_home from public.companies co where co.id = v_client.company_id;
  if v_client.vat_exempt then return private.vat_rate_at('exempt', v_home, current_date); end if;
  if v_client.country <> v_home then return private.vat_rate_at('export', v_home, current_date); end if;
  return private.vat_rate_at('standard', v_home, current_date);
end $$;
revoke execute on function private.client_tax_rate(uuid) from public, anon, authenticated;
