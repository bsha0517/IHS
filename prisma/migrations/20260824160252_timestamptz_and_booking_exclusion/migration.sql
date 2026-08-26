-- AlterTable
ALTER TABLE "appointment" ALTER COLUMN "start_time" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "end_time" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "appointment_status_history" ALTER COLUMN "changed_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "audit_log" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "branch" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "clinical_access_log" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "department" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "login_history" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "notification" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "number_sequence" ALTER COLUMN "last_reset_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "organization" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "outbox_event" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "processed_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "password_reset_token" ALTER COLUMN "expires_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "used_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "patient" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "patient_allergy" ALTER COLUMN "noted_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "patient_condition" ALTER COLUMN "noted_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "patient_medication_history" ALTER COLUMN "noted_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "provider" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "provider_leave_block" ALTER COLUMN "start_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "end_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "queue_entry" ALTER COLUMN "arrived_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "checked_in_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "called_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "consultation_start_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "consultation_end_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "role" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "role_permission" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "room" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "service" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "session" ALTER COLUMN "expires_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "revoked_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "user" ALTER COLUMN "locked_until" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "last_login_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "user_branch_access" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "user_role" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);


-- Hard double-booking prevention (spec.md §16: "Prevent: Provider double
-- booking, Room double booking") enforced at the database level via a range
-- exclusion constraint, not just an application-layer check — the latter
-- alone races under concurrency (BLUEPRINT.md §16/Major Risk #3).
-- Cancelled/no-show/rescheduled appointments no longer occupy the slot.
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_provider_no_overlap"
  EXCLUDE USING gist (
    "provider_id" WITH =,
    tstzrange("start_time", "end_time") WITH &&
  )
  WHERE ("status" NOT IN ('cancelled', 'no_show', 'rescheduled'));

ALTER TABLE "appointment" ADD CONSTRAINT "appointment_room_no_overlap"
  EXCLUDE USING gist (
    "room_id" WITH =,
    tstzrange("start_time", "end_time") WITH &&
  )
  WHERE ("room_id" IS NOT NULL AND "status" NOT IN ('cancelled', 'no_show', 'rescheduled'));
