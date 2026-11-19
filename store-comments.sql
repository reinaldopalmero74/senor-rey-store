-- Señor Rey Marketplace — comentarios/reseñas por producto
create table if not exists public.store_comments (
  id uuid primary key default gen_random_uuid(),
  item_id text not null,
  name text not null,
  rating int not null default 5 check (rating between 1 and 5),
  body text not null,
  created_at timestamptz not null default now()
);
alter table public.store_comments enable row level security;
create index if not exists store_comments_item_idx on public.store_comments (item_id, created_at desc);
