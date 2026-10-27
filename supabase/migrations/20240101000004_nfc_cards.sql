-- =============================================================================
-- Migration: 004_nfc_cards.sql
-- Project:   Multimodal University Attendance Verification System
-- Depends:   001_profiles_and_auth.sql  (public.profiles)
-- Purpose:   Registers the physical NFC cards issued to students.
--            Each row represents one card currently assigned to one student.
--            This table is the binding between the physical world (a card's
--            hardware UID read by the PN532 module) and the digital world
--            (a student's profile in the system).
-- =============================================================================


-- =============================================================================
-- SECTION 1: nfc_cards TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.nfc_cards (

    -- -------------------------------------------------------------------------
    -- Why uid is the PRIMARY KEY instead of a generated UUID id column
    -- -------------------------------------------------------------------------
    -- Every other table in this schema uses gen_random_uuid() as a surrogate
    -- primary key. nfc_cards deliberately breaks this pattern, and for good
    -- reason:
    --
    --  1. The uid IS the real-world identity of the card.
    --     The PN532 hardware module reads the card's immutable, factory-burned
    --     UID (typically 4 or 7 bytes, represented as a hex string like
    --     "A3:F0:2C:11"). That string is what the Edge Function will receive
    --     at attendance-marking time and look up in this table. If we used a
    --     surrogate id column, every lookup would require joining through an
    --     extra key that carries no information — pure overhead.
    --
    --  2. Natural key = built-in uniqueness with no extra constraint.
    --     Making uid the PK automatically creates a unique B-tree index on it.
    --     We get both the identity guarantee AND the fast lookup index in one
    --     declaration, with no separate UNIQUE constraint needed.
    --     A surrogate-key design would need: a generated id PK + a UNIQUE
    --     constraint on uid + an index on uid = three objects doing the same job.
    --
    --  3. It prevents duplicate card registrations at the storage level.
    --     If a lecturer accidentally scans the same card twice (e.g. during
    --     a re-registration flow), the INSERT fails with a clear primary-key
    --     violation (error 23505) rather than silently creating a second row
    --     that a surrogate-key table would permit.
    --
    --  4. The UID is immutable — it never needs to change.
    --     The classical argument against natural keys is mutability (e.g. an
    --     email address can change). NFC UIDs are burned into hardware at the
    --     factory and physically cannot be altered, so the mutability concern
    --     does not apply here.
    --
    -- Format note: store UIDs in a consistent canonical form.
    -- The recommended format is uppercase hex bytes separated by colons,
    -- e.g. "A3:F0:2C:11". Normalisation should happen in the Edge Function
    -- before the INSERT so that "a3f02c11" and "A3:F0:2C:11" are never treated
    -- as different cards.
    uid             TEXT        PRIMARY KEY,

    -- The student this card belongs to. One student, one active card at a time
    -- (enforced by the UNIQUE constraint below).
    -- ON DELETE CASCADE: if a student's profile is deleted, their card
    -- registration is also removed automatically rather than becoming an
    -- orphan row that could be fraudulently re-registered.
    student_id      UUID        NOT NULL UNIQUE
                                REFERENCES public.profiles (id) ON DELETE CASCADE,

    -- The lecturer who performed the physical enrolment ceremony
    -- (scanned the card and linked it to the student).
    -- ON DELETE SET NULL: if the lecturer's profile is removed, the card
    -- registration is retained — the card is still valid for the student.
    -- Keeping this reference is useful for auditing ("who registered this
    -- card?") without blocking student card usage.
    registered_by   UUID        REFERENCES public.profiles (id) ON DELETE SET NULL,

    registered_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.nfc_cards IS
    'One row per NFC card currently issued to a student. The uid is the '
    'physical card UID read by the PN532 module. Natural primary key — see '
    'inline comment for the full rationale.';

COMMENT ON COLUMN public.nfc_cards.uid IS
    'Hardware UID burned into the NFC card (e.g. "A3:F0:2C:11"). '
    'Store in uppercase colon-separated hex. PK and lookup key for attendance.';

COMMENT ON COLUMN public.nfc_cards.student_id IS
    'UNIQUE — one student can hold at most one active card at a time. '
    'To re-register, DELETE the old row and INSERT a new one.';

COMMENT ON COLUMN public.nfc_cards.registered_by IS
    'The lecturer who performed the card enrolment. Nullable: set to NULL '
    'if the lecturer account is deleted, preserving the card registration.';


-- =============================================================================
-- SECTION 2: INDEX
-- =============================================================================
-- The uid column is already indexed as PRIMARY KEY (used by the Edge Function
-- for O(log n) card lookups during attendance marking).
--
-- student_id is UNIQUE, which also gives it an index automatically.
--
-- registered_by is a FK that could be queried in an audit view ("all cards
-- registered by lecturer X"). Not performance-critical but good practice.
CREATE INDEX IF NOT EXISTS idx_nfc_cards_registered_by
    ON public.nfc_cards (registered_by);


-- =============================================================================
-- SECTION 3: ROW LEVEL SECURITY
-- =============================================================================
-- Students have zero direct access to this table. They must not be able to
-- discover card UIDs (which could be used to clone a card) or determine
-- whether another student has a card registered.
--
-- No UPDATE policy is defined for anyone:
-- To re-register a card (e.g. a lost card is replaced), the lecturer must
-- DELETE the old row and INSERT a new one. This is intentional:
--   • It produces a cleaner audit trail — the old card UID disappears from
--     the live table, making it immediately invalid for attendance marking.
--   • If we add a nfc_cards_history table later (via a trigger), the
--     DELETE+INSERT pattern captures the full lifecycle of each card assignment
--     whereas an UPDATE would silently overwrite the old UID with no record.
--   • It removes any ambiguity about "partial updates" — there is no state
--     where a row exists with a uid but no student_id, or vice versa.

ALTER TABLE public.nfc_cards ENABLE ROW LEVEL SECURITY;


-- -----------------------------------------------------------------------------
-- Policy: Lecturers can view all card registrations
-- -----------------------------------------------------------------------------
-- Needed for the dashboard to show which students already have a card
-- registered (so a lecturer doesn't try to register a second card to a
-- student who already has one, and to verify a card before issuing it).
CREATE POLICY "Lecturers can view all nfc_cards"
    ON public.nfc_cards
    FOR SELECT
    TO authenticated
    USING (
        (
            SELECT role FROM public.profiles WHERE id = auth.uid()
        ) = 'lecturer'
    );


-- -----------------------------------------------------------------------------
-- Policy: Lecturers can register (INSERT) a new card
-- -----------------------------------------------------------------------------
-- The registered_by column must be set to the caller's own id — a lecturer
-- cannot register a card and attribute it to a different lecturer.
-- We also enforce that the caller is actually a lecturer (role check),
-- since the RLS USING/WITH CHECK expression runs in the caller's context.
CREATE POLICY "Lecturers can register nfc_cards"
    ON public.nfc_cards
    FOR INSERT
    TO authenticated
    WITH CHECK (
        registered_by = auth.uid()
        AND (
            SELECT role FROM public.profiles WHERE id = auth.uid()
        ) = 'lecturer'
    );


-- -----------------------------------------------------------------------------
-- Policy: Lecturers can delete (deregister) a card
-- -----------------------------------------------------------------------------
-- Any lecturer can delete any card row (e.g. a different lecturer inherits
-- the course and needs to re-register a student's card). If you want to
-- restrict deletion to the original registrar only, change the USING clause to:
--   registered_by = auth.uid()
CREATE POLICY "Lecturers can deregister nfc_cards"
    ON public.nfc_cards
    FOR DELETE
    TO authenticated
    USING (
        (
            SELECT role FROM public.profiles WHERE id = auth.uid()
        ) = 'lecturer'
    );

-- NOTE: No UPDATE policy. See rationale in the RLS section header above.
-- NOTE: No student SELECT/INSERT/DELETE policy — students have no access.
-- NOTE: The Edge Function (service_role) bypasses RLS and can read the table
--       directly during attendance marking without needing a policy.


-- =============================================================================
-- END OF MIGRATION 004
-- =============================================================================
