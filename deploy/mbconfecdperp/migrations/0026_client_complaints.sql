-- =====================================================================
-- 0026_client_complaints — Réclamations clients (fiche Client 360°)
--  Table client_complaints : réclamation d'un client, éventuellement liée à une commande.
--  Cycle : ouverte → en cours → résolue (solution écrite, 10 caractères minimum) → close.
--  Droits : clients.read (voir), clients.write (ouvrir et traiter) — mêmes droits que la fiche client.
-- =====================================================================

create table public.client_complaints (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default private.current_company() references public.companies(id) on delete cascade,
  number        text not null,
  client_id     uuid not null references public.clients(id) on delete restrict,
  order_id      uuid references public.sales_orders(id) on delete set null,
  subject       text not null check (length(btrim(subject)) between 3 and 160),
  description   text check (description is null or length(description) <= 2000),
  severity      text not null default 'minor' check (severity in ('minor', 'major', 'critical')),
  status        text not null default 'open' check (status in ('open', 'in_progress', 'resolved', 'closed')),
  resolution    text check (resolution is null or length(resolution) <= 2000),
  created_at    timestamptz not null default now(),
  created_by    uuid default auth.uid(),
  resolved_at   timestamptz,
  closed_at     timestamptz,
  unique (company_id, number),
  check (status <> 'resolved' or (resolution is not null and resolved_at is not null)),
  check (status <> 'closed' or closed_at is not null)
);
create index client_complaints_client_idx on public.client_complaints (client_id, created_at desc);

create function private.complaint_number() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.number is null then
    new.number := 'REC-' || to_char(now(), 'YYYY') || '-' || lpad(private.next_seq(new.company_id, 'client_complaint')::text, 6, '0');
  end if;
  return new;
end $$;
revoke execute on function private.complaint_number() from public, anon, authenticated;
create trigger client_complaints_number_i before insert on public.client_complaints for each row execute function private.complaint_number();

-- La réclamation doit concerner un client, et une commande, de la même société.
create function private.client_complaints_check() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.clients c where c.id = new.client_id and c.company_id = new.company_id) then
    raise exception 'COMPLAINT_CLIENT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if new.order_id is not null and not exists (select 1 from public.sales_orders o where o.id = new.order_id and o.company_id = new.company_id and o.client_id = new.client_id) then
    raise exception 'COMPLAINT_ORDER_NOT_FOUND' using errcode = 'P0002';
  end if;
  return new;
end $$;
revoke execute on function private.client_complaints_check() from public, anon, authenticated;
create trigger client_complaints_check_i before insert or update on public.client_complaints for each row execute function private.client_complaints_check();

alter table public.client_complaints enable row level security;
create policy client_complaints_select on public.client_complaints for select to authenticated
  using (company_id = private.current_company() and private.has_perm('clients.read'));
revoke all on public.client_complaints from anon, authenticated;
grant select on public.client_complaints to authenticated;

create function public.complaint_open(p_client uuid, p_order uuid, p_subject text, p_description text, p_severity text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := gen_random_uuid(); v_number text; v_co uuid := private.current_company();
begin
  perform private.require_perm('clients.write');
  insert into public.client_complaints (id, client_id, order_id, subject, description, severity)
  values (v_id, p_client, p_order, btrim(p_subject), nullif(btrim(coalesce(p_description, '')), ''), p_severity)
  returning number into v_number;
  perform private.write_audit(v_co, 'client.complaint_open', 'client', p_client::text, v_number, null,
    jsonb_build_object('subject', p_subject, 'severity', p_severity), '{}'::jsonb, 'rpc');
  return v_id;
end $$;

-- Avancement : en cours (depuis ouverte), résolue (solution obligatoire), close (depuis résolue).
create function public.complaint_update(p_complaint uuid, p_status text, p_resolution text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.client_complaints%rowtype; v_res text := nullif(btrim(coalesce(p_resolution, '')), '');
begin
  perform private.require_perm('clients.write');
  select * into c from public.client_complaints where id = p_complaint and company_id = private.current_company() for update;
  if not found then raise exception 'COMPLAINT_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_status = 'in_progress' and c.status = 'open' then
    update public.client_complaints set status = 'in_progress' where id = c.id;
  elsif p_status = 'resolved' and c.status in ('open', 'in_progress') then
    if v_res is null or length(v_res) < 10 then raise exception 'COMPLAINT_RESOLUTION_REQUIRED' using errcode = '22023'; end if;
    update public.client_complaints set status = 'resolved', resolution = v_res, resolved_at = now() where id = c.id;
  elsif p_status = 'closed' and c.status = 'resolved' then
    update public.client_complaints set status = 'closed', closed_at = now() where id = c.id;
  else
    raise exception 'COMPLAINT_BAD_STATUS' using errcode = '55000';
  end if;
  perform private.write_audit(c.company_id, 'client.complaint_update', 'client', c.client_id::text, c.number, null,
    jsonb_build_object('status', p_status), '{}'::jsonb, 'rpc');
end $$;

revoke execute on function public.complaint_open(uuid, uuid, text, text, text) from public, anon;
revoke execute on function public.complaint_update(uuid, text, text) from public, anon;
grant execute on function public.complaint_open(uuid, uuid, text, text, text) to authenticated;
grant execute on function public.complaint_update(uuid, text, text) to authenticated;
