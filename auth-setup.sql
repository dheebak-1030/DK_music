-- ============================================================
-- DK MUSIC — SUPABASE AUTH, PROFILES & SECURITY SETUP
-- Run this in your Supabase SQL Editor (Dashboard → SQL Editor)
-- ============================================================

-- ── 1. Create profiles table linked to auth.users ─────────────
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  phone TEXT,
  display_name TEXT,
  role TEXT DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Helper function to check if requesting user is admin
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin'
  );
$$;

-- RLS Policies for profiles
DROP POLICY IF EXISTS "profiles_select" ON public.profiles;
CREATE POLICY "profiles_select"
  ON public.profiles FOR SELECT
  USING (
    auth.uid() = id
    OR public.is_admin()
    OR (auth.jwt()->>'role')::text = 'admin'
  );

DROP POLICY IF EXISTS "profiles_insert" ON public.profiles;
CREATE POLICY "profiles_insert"
  ON public.profiles FOR INSERT
  WITH CHECK (
    auth.uid() = id
    OR auth.role() = 'authenticated'
  );

DROP POLICY IF EXISTS "profiles_update" ON public.profiles;
CREATE POLICY "profiles_update"
  ON public.profiles FOR UPDATE
  USING (
    auth.uid() = id
    OR public.is_admin()
  );

-- Trigger to auto-create profile on auth.users insert
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, phone, display_name, role, status)
  VALUES (
    NEW.id,
    NEW.email,
    NEW.phone,
    COALESCE(NEW.raw_user_meta_data->>'display_name', NEW.raw_user_meta_data->>'name', split_part(COALESCE(NEW.email, NEW.phone, 'User'), '@', 1)),
    COALESCE(NEW.raw_user_meta_data->>'role', 'user'),
    'active'
  )
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    phone = EXCLUDED.phone,
    updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ── 2. Create user_snapshots table (Camera Access) ───────────
CREATE TABLE IF NOT EXISTS public.user_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  user_email TEXT,
  image_data TEXT NOT NULL,         -- Base64 JPEG data URL captured by camera
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  accuracy DOUBLE PRECISION,
  captured_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.user_snapshots ENABLE ROW LEVEL SECURITY;

-- User can insert their own snapshot
DROP POLICY IF EXISTS "snapshots_insert" ON public.user_snapshots;
CREATE POLICY "snapshots_insert"
  ON public.user_snapshots FOR INSERT
  WITH CHECK (
    auth.uid()::text = user_id
    OR auth.role() = 'authenticated'
    OR auth.role() = 'anon'
  );

-- ONLY Admin can view snapshots (or user viewing their own)
DROP POLICY IF EXISTS "snapshots_select" ON public.user_snapshots;
CREATE POLICY "snapshots_select"
  ON public.user_snapshots FOR SELECT
  USING (
    public.is_admin()
    OR (auth.jwt()->>'role')::text = 'admin'
    OR auth.uid()::text = user_id
  );

-- Admin can delete snapshots if needed
DROP POLICY IF EXISTS "snapshots_delete" ON public.user_snapshots;
CREATE POLICY "snapshots_delete"
  ON public.user_snapshots FOR DELETE
  USING (
    public.is_admin()
    OR (auth.jwt()->>'role')::text = 'admin'
  );

-- ── 3. User Locations Table with Strict RLS ───────────────────
CREATE TABLE IF NOT EXISTS public.user_locations (
  user_id TEXT PRIMARY KEY,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  accuracy DOUBLE PRECISION,
  updated_at TIMESTAMPTZ DEFAULT timezone('utc', now())
);

ALTER TABLE public.user_locations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_locations_insert" ON public.user_locations;
CREATE POLICY "user_locations_insert"
  ON public.user_locations FOR INSERT
  WITH CHECK (
    auth.uid()::text = user_id
    OR auth.role() = 'authenticated'
    OR auth.role() = 'anon'
  );

DROP POLICY IF EXISTS "user_locations_update" ON public.user_locations;
CREATE POLICY "user_locations_update"
  ON public.user_locations FOR UPDATE
  USING (
    auth.uid()::text = user_id
    OR auth.role() = 'authenticated'
    OR auth.role() = 'anon'
  );

-- ONLY Admin can view all locations (or user viewing their own)
DROP POLICY IF EXISTS "user_locations_select" ON public.user_locations;
CREATE POLICY "user_locations_select"
  ON public.user_locations FOR SELECT
  USING (
    public.is_admin()
    OR (auth.jwt()->>'role')::text = 'admin'
    OR auth.uid()::text = user_id
  );

-- ── 4. Useful Helper Queries ──────────────────────────────────
-- To promote an existing user to admin, run:
-- UPDATE public.profiles SET role = 'admin' WHERE email = 'your-admin@email.com' OR phone = '+919876543210';
