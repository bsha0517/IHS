-- Postgres unique constraints treat NULL as distinct-from-NULL, so
-- @@unique([organizationId, branchId, sequenceType]) does NOT stop two
-- concurrent org-level (branch_id IS NULL) sequences of the same type from
-- both being created — spec.md §68 requires this never race. This index
-- collapses NULL branch_id to a fixed sentinel for uniqueness purposes,
-- giving a true single-row guarantee at the database level.
CREATE UNIQUE INDEX "number_sequence_org_branch_type_uq"
ON "number_sequence" (
  "organization_id",
  COALESCE("branch_id", '__org_level__'),
  "sequence_type"
);
