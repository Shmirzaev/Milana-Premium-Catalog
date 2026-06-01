alter table public.milana_products enable row level security;

alter table public.milana_products
  add column if not exists is_visible boolean not null default true;

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

create table if not exists public.milana_product_overrides (
  id bigserial primary key,
  source_pdf text not null,
  page integer not null,
  card_index integer not null,
  model_code text,
  product_code text,
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

alter table public.milana_product_overrides enable row level security;

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
