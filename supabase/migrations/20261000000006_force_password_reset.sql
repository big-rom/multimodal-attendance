-- =============================================================================
-- Migration: Force Password Reset
-- =============================================================================

ALTER TABLE public.profiles ADD COLUMN force_password_reset BOOLEAN NOT NULL DEFAULT false;
