-- Allow each authenticated user to read only their own avatar object.
create policy "Users can read own avatar files"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);
