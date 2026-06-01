-- Run this once in the Supabase SQL editor before the first refresh.
-- The backend uses a secret/service-role key and refreshes this table daily.

create table if not exists public.milana_products (
  id bigserial primary key,
  source_system text not null default 'milana_catalog_processor',
  run_id text not null,
  catalog_date date,
  source_pdf text,
  source_pdf_path text,
  page integer,
  card_index integer,
  bbox text,
  model_code text,
  product_code text,
  material_type text,
  price numeric(12, 2),
  currency text,
  extraction_status text,
  native_text text,
  ocr_text text,
  combined_text text,
  image_sha256 text,
  image_fingerprint text,
  image_storage_bucket text,
  image_storage_path text,
  image_url text,
  is_visible boolean not null default true,
  embedding_model text,
  embedding_path text,
  embedding_preview text,
  created_at timestamptz not null default now()
);

alter table public.milana_products
  add column if not exists is_visible boolean not null default true;

alter table public.milana_products
  add column if not exists material_type text;

create table if not exists public.milana_admins (
  email text primary key,
  created_at timestamptz not null default now()
);

-- Replace this with your Supabase Auth email, then run the SQL.
insert into public.milana_admins (email)
values
  ('milana.admin.72993@gmail.com'),
  ('shmirziyoyev007@gmail.com')
on conflict (email) do nothing;

create table if not exists public.milana_product_overrides (
  id bigserial primary key,
  source_pdf text not null,
  page integer not null,
  card_index integer not null,
  model_code text,
  product_code text,
  material_type text,
  price numeric(12, 2),
  currency text,
  image_url text,
  image_storage_bucket text,
  image_storage_path text,
  is_visible boolean,
  updated_at timestamptz not null default now(),
  unique (source_pdf, page, card_index)
);

alter table public.milana_product_overrides
  add column if not exists is_visible boolean;

alter table public.milana_product_overrides
  add column if not exists material_type text;

create or replace function public.is_milana_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.milana_admins
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

grant execute on function public.is_milana_admin() to anon, authenticated;

create index if not exists milana_products_source_system_idx
  on public.milana_products (source_system);

create index if not exists milana_products_product_code_idx
  on public.milana_products (product_code);

create index if not exists milana_products_catalog_date_idx
  on public.milana_products (catalog_date);

create index if not exists milana_products_visibility_idx
  on public.milana_products (source_pdf, is_visible);

create index if not exists milana_products_material_idx
  on public.milana_products (source_pdf, material_type);

alter table public.milana_products enable row level security;
alter table public.milana_admins enable row level security;
alter table public.milana_product_overrides enable row level security;

drop policy if exists "Public read milana products" on public.milana_products;
create policy "Public read milana products"
on public.milana_products for select
using (is_visible = true);

drop policy if exists "Admin read milana products" on public.milana_products;
create policy "Admin read milana products"
on public.milana_products for select
to authenticated
using (public.is_milana_admin());

drop policy if exists "Admin update milana products" on public.milana_products;
create policy "Admin update milana products"
on public.milana_products for update
to authenticated
using (public.is_milana_admin())
with check (public.is_milana_admin());

drop policy if exists "Admin insert milana products" on public.milana_products;
create policy "Admin insert milana products"
on public.milana_products for insert
to authenticated
with check (public.is_milana_admin());

drop policy if exists "Admin read overrides" on public.milana_product_overrides;
create policy "Admin read overrides"
on public.milana_product_overrides for select
to authenticated
using (public.is_milana_admin());

drop policy if exists "Admin insert overrides" on public.milana_product_overrides;
create policy "Admin insert overrides"
on public.milana_product_overrides for insert
to authenticated
with check (public.is_milana_admin());

drop policy if exists "Admin update overrides" on public.milana_product_overrides;
create policy "Admin update overrides"
on public.milana_product_overrides for update
to authenticated
using (public.is_milana_admin())
with check (public.is_milana_admin());

drop policy if exists "Admin delete overrides" on public.milana_product_overrides;
create policy "Admin delete overrides"
on public.milana_product_overrides for delete
to authenticated
using (public.is_milana_admin());

insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do update set public = true;

drop policy if exists "Public read product images" on storage.objects;
create policy "Public read product images"
on storage.objects for select
using (bucket_id = 'product-images');

drop policy if exists "Admin upload product images" on storage.objects;
create policy "Admin upload product images"
on storage.objects for insert
to authenticated
with check (bucket_id = 'product-images' and public.is_milana_admin());

drop policy if exists "Admin update product images" on storage.objects;
create policy "Admin update product images"
on storage.objects for update
to authenticated
using (bucket_id = 'product-images' and public.is_milana_admin())
with check (bucket_id = 'product-images' and public.is_milana_admin());
