-- ============================================================
-- DK MUSIC — Location Columns Migration
-- Run in Supabase SQL Editor to add missing location columns
-- ============================================================

-- Add location columns to profiles table (required by saveLocation)
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS location_updated_at TIMESTAMPTZ;

-- Add username and email columns to user_locations table
-- so admin can see phone/name instead of raw UUID
ALTER TABLE public.user_locations ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE public.user_locations ADD COLUMN IF NOT EXISTS email TEXT;

-- Update select policy: allow admin to see ALL user locations
DROP POLICY IF EXISTS "user_locations_select" ON public.user_locations;
CREATE POLICY "user_locations_select"
  ON public.user_locations FOR SELECT
  USING (
    public.is_admin()
    OR (auth.jwt()->>'role')::text = 'admin'
    OR auth.uid()::text = user_id
    OR auth.role() = 'authenticated'
    OR auth.role() = 'anon'
  );

-- Allow upsert (update) for user_locations
DROP POLICY IF EXISTS "user_locations_upsert" ON public.user_locations;
CREATE POLICY "user_locations_upsert"
  ON public.user_locations FOR UPDATE
  USING (
    auth.uid()::text = user_id
    OR auth.role() = 'authenticated'
    OR auth.role() = 'anon'
  );

-- Verify
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'user_locations' ORDER BY ordinal_position;
