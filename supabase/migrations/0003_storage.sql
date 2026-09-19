-- =============================================================================
-- 0003_storage.sql — product image bucket
-- =============================================================================
-- Run after 0002. Re-runnable.
--
--   * Bucket `product-images` is PUBLIC-READ: product photos are shown on the
--     public storefront, and public buckets serve objects by URL
--     (/storage/v1/object/public/product-images/<path>) without any policy.
--   * There is deliberately NO select policy for `anon`, so nobody can LIST or
--     enumerate the bucket through the API — only fetch a known path.
--   * Only admins (public.is_admin()) can upload, replace or delete.
--   * Server-side limits: 2 MB per file; JPEG/PNG/WebP only. (The client checks
--     too, but this is the enforcement.)
--   * Object paths are `products/<product id>/<uuid>.<ext>` — matches the
--     products.image_path CHECK in 0001.
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'product-images',
  'product-images',
  true,
  2097152,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists product_images_admin_select on storage.objects;
create policy product_images_admin_select on storage.objects
  for select to authenticated
  using (bucket_id = 'product-images' and (select public.is_admin()));

drop policy if exists product_images_admin_insert on storage.objects;
create policy product_images_admin_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'product-images' and (select public.is_admin()));

drop policy if exists product_images_admin_update on storage.objects;
create policy product_images_admin_update on storage.objects
  for update to authenticated
  using      (bucket_id = 'product-images' and (select public.is_admin()))
  with check (bucket_id = 'product-images' and (select public.is_admin()));

drop policy if exists product_images_admin_delete on storage.objects;
create policy product_images_admin_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'product-images' and (select public.is_admin()));
