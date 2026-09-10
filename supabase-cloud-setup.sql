-- ============================================================
-- DK MUSIC — SUPABASE CLOUD STORAGE SETUP
-- Run this in your Supabase SQL Editor (Project → SQL Editor)
-- ============================================================

-- ── 1. Update songs table ─────────────────────────────────────
ALTER TABLE public.songs ADD COLUMN IF NOT EXISTS file_url TEXT;
ALTER TABLE public.songs ADD COLUMN IF NOT EXISTS downloadable BOOLEAN DEFAULT true;
ALTER TABLE public.songs ADD COLUMN IF NOT EXISTS is_cloud BOOLEAN DEFAULT false;
ALTER TABLE public.songs ADD COLUMN IF NOT EXISTS uploaded_by TEXT DEFAULT 'admin';

-- Sync audio_url → file_url for existing rows
UPDATE public.songs SET file_url = audio_url WHERE file_url IS NULL AND audio_url IS NOT NULL;

-- Enable RLS on songs
ALTER TABLE public.songs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "songs_public_read" ON public.songs;
CREATE POLICY "songs_public_read"
  ON public.songs FOR SELECT USING (true);

DROP POLICY IF EXISTS "songs_auth_write" ON public.songs;
CREATE POLICY "songs_auth_write"
  ON public.songs FOR ALL
  USING (auth.role() = 'authenticated' OR auth.role() = 'anon')
  WITH CHECK (auth.role() = 'authenticated' OR auth.role() = 'anon');

-- ── 2. Create playlists table ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.playlists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  cover TEXT,
  songs TEXT[] DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc', now()),
  created_by TEXT DEFAULT 'admin'
);

ALTER TABLE public.playlists ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "playlists_public_read" ON public.playlists;
CREATE POLICY "playlists_public_read"
  ON public.playlists FOR SELECT USING (true);

DROP POLICY IF EXISTS "playlists_auth_write" ON public.playlists;
CREATE POLICY "playlists_auth_write"
  ON public.playlists FOR ALL
  USING (auth.role() = 'authenticated' OR auth.role() = 'anon')
  WITH CHECK (auth.role() = 'authenticated' OR auth.role() = 'anon');

-- ── 3. Storage Buckets ────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'dk-music-audio', 'dk-music-audio', true,
  52428800,
  ARRAY['audio/mpeg','audio/mp3','audio/wav','audio/flac','audio/aac','audio/ogg','audio/x-m4a']
)
ON CONFLICT (id) DO UPDATE SET public = true, file_size_limit = 52428800;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'dk-music-covers', 'dk-music-covers', true,
  5242880,
  ARRAY['image/jpeg','image/jpg','image/png','image/webp','image/gif']
)
ON CONFLICT (id) DO UPDATE SET public = true, file_size_limit = 5242880;

-- ── 4. Storage Bucket Policies ────────────────────────────────
DROP POLICY IF EXISTS "audio_public_read" ON storage.objects;
CREATE POLICY "audio_public_read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'dk-music-audio');

DROP POLICY IF EXISTS "audio_upload" ON storage.objects;
CREATE POLICY "audio_upload"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'dk-music-audio'
    AND (auth.role() = 'authenticated' OR auth.role() = 'anon'));

DROP POLICY IF EXISTS "audio_delete" ON storage.objects;
CREATE POLICY "audio_delete"
  ON storage.objects FOR DELETE
  USING (bucket_id = 'dk-music-audio'
    AND (auth.role() = 'authenticated' OR auth.role() = 'anon'));

DROP POLICY IF EXISTS "covers_public_read" ON storage.objects;
CREATE POLICY "covers_public_read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'dk-music-covers');

DROP POLICY IF EXISTS "covers_upload" ON storage.objects;
CREATE POLICY "covers_upload"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'dk-music-covers'
    AND (auth.role() = 'authenticated' OR auth.role() = 'anon'));

DROP POLICY IF EXISTS "covers_delete" ON storage.objects;
CREATE POLICY "covers_delete"
  ON storage.objects FOR DELETE
  USING (bucket_id = 'dk-music-covers'
    AND (auth.role() = 'authenticated' OR auth.role() = 'anon'));

-- ── 5. Verify ─────────────────────────────────────────────────
SELECT 'songs' AS tbl, count(*) FROM public.songs
UNION ALL
SELECT 'playlists', count(*) FROM public.playlists;

SELECT id, name, public FROM storage.buckets
WHERE id IN ('dk-music-audio', 'dk-music-covers');
