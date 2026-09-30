-- ============================================================
-- DK MUSIC — Location & Profiles Migration Script
-- Run this in your Supabase SQL Editor (Dashboard → SQL Editor)
-- ============================================================

-- 1. Add user_id and location columns to profiles table
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS location_updated_at TIMESTAMPTZ;

-- Backfill user_id from display_name or id if empty
UPDATE public.profiles 
SET user_id = COALESCE(user_id, display_name, id::text) 
WHERE user_id IS NULL;

-- 2. Add username and email columns to user_locations table
ALTER TABLE public.user_locations ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE public.user_locations ADD COLUMN IF NOT EXISTS email TEXT;

-- 3. RLS: Allow profiles to be read by Admin and authenticated/anon users
DROP POLICY IF EXISTS "profiles_select" ON public.profiles;
CREATE POLICY "profiles_select"
  ON public.profiles FOR SELECT
  USING (true);

-- 4. RLS: Allow user_locations to be read by Admin and authenticated/anon users
DROP POLICY IF EXISTS "user_locations_select" ON public.user_locations;
CREATE POLICY "user_locations_select"
  ON public.user_locations FOR SELECT
  USING (true);

-- 5. RLS: Allow insert and update for user_locations
DROP POLICY IF EXISTS "user_locations_insert" ON public.user_locations;
CREATE POLICY "user_locations_insert"
  ON public.user_locations FOR INSERT
  WITH CHECK (true);

DROP POLICY IF EXISTS "user_locations_upsert" ON public.user_locations;
CREATE POLICY "user_locations_upsert"
  ON public.user_locations FOR UPDATE
  USING (true);

-- 6. Verification query
SELECT column_name, data_type 
FROM information_schema.columns
WHERE table_name IN ('profiles', 'user_locations') 
ORDER BY table_name, ordinal_position;
