-- =====================================================================
-- 0029_export_vat_rule — Taux de TVA appliqué à l'émission selon le client
--  - client exonéré (vat_exempt) : 0 %
--  - client hors du pays de la société (export) : 0 %, sans TVA
--  - client du pays de la société : 19 %
--  Le taux est repris par les devis, commandes et factures (valeur par défaut).
-- =====================================================================
create or replace function private.client_tax_rate(p_client uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select case when cl.vat_exempt or cl.country <> co.country then 0 else 19 end
    from public.clients cl
    join public.companies co on co.id = cl.company_id
   where cl.id = p_client
$$;

-- Application obligatoire : à la création, un devis, une commande ou une facture d'un client
-- d'export (ou exonéré) reçoit 0 %, quel que soit le taux saisi.
create function private.enforce_export_vat() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.client_id is not null and private.client_tax_rate(new.client_id) = 0 then
    new.tax_rate := 0;
  end if;
  return new;
end $$;
revoke execute on function private.enforce_export_vat() from public, anon, authenticated;

create trigger quotes_export_vat_i before insert on public.quotes for each row execute function private.enforce_export_vat();
create trigger sales_orders_export_vat_i before insert on public.sales_orders for each row execute function private.enforce_export_vat();
create trigger invoices_export_vat_i before insert on public.invoices for each row execute function private.enforce_export_vat();
