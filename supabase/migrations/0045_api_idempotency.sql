-- =====================================================================
-- 0045_api_idempotency — Clés d'idempotence de l'API (P020)
--  Une action répétée avec la même clé (et la même requête) renvoie la réponse enregistrée, sans second effet.
--  Table lue et écrite par le serveur de l'API uniquement : aucun droit pour les utilisateurs (ni lecture, ni écriture).
--  Seules les réponses réussies sont enregistrées : un échec peut être repris avec la même clé.
-- =====================================================================
create table public.api_idempotency (
  actor_id         uuid not null,
  idem_key         text not null check (length(idem_key) between 8 and 120),
  request_hash     text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  response_status  int not null check (response_status between 200 and 299),
  response_body    text not null,
  created_at       timestamptz not null default now(),
  primary key (actor_id, idem_key)
);
alter table public.api_idempotency enable row level security;
revoke all on public.api_idempotency from anon, authenticated;
grant all on public.api_idempotency to service_role;
