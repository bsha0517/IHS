-- P1 Batch 3 (§9-§11): links a Charge to the Product it sold, when it sold
-- one. Nullable — only ever set for sourceType "product" ad-hoc POS
-- charges (src/lib/domains/billing/charges.ts's insertCharge uses its
-- presence, not sourceType alone, to decide whether to consume real
-- inventory for this line). Every other existing charge continues to have
-- product_id NULL, matching its current, unaffected behavior.
--
-- (The `prisma migrate diff` output for this change also re-emitted the
-- OutboxStatus enum AlterEnum block from P0-02's migration — a known,
-- previously-documented artifact of the diff tool re-comparing against a
-- from-scratch baseline rather than this project's actual migration
-- history. Deliberately excluded here, same as every prior migration that
-- hit it; it is already applied.)

ALTER TABLE "charge" ADD COLUMN     "product_id" TEXT;

CREATE INDEX "charge_product_id_idx" ON "charge"("product_id");

ALTER TABLE "charge" ADD CONSTRAINT "charge_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
