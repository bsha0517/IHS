import type { Prisma, PrismaClient } from "@/generated/prisma/client"

/**
 * Deliberately NO `import "server-only"` here (unlike most of
 * `src/lib/domains/**`) — `prisma/seed.ts` imports this directly under raw
 * tsx/Node, not through Next's bundler, the same reason `lib/db.ts` and
 * `lib/auth/password.ts`/`tokens.ts` are also without it.
 *
 * The standard role catalog every organization gets — extracted from
 * `prisma/seed.ts` (P5.1) so a newly PROVISIONED clinic (see
 * commercial/provisioning.ts) gets the exact same roles/permission grants
 * as the original bootstrap organization, from one definition instead of
 * two copies that could silently drift apart. `prisma/seed.ts` now imports
 * this rather than defining its own copy.
 */
export const SYSTEM_ROLES: { name: string; permissions: string[] | "ALL" }[] = [
  { name: "Super Admin", permissions: "ALL" }, // resolved against the live permission catalog below
  { name: "Organization Administrator", permissions: "ALL" },
  {
    name: "Clinic Manager",
    permissions: [
      "settings.view", "branch.view", "department.view", "room.view",
      "patient.view", "provider.view", "service.view",
      "appointment.view", "appointment.reschedule", "appointment.cancel",
      "clinical_notes.view",
      "charge.void", "invoice.view", "invoice.discount", "invoice.void",
      "payment.view", "refund.authorize", "cashier.view", "package.manage", "tax.manage",
      "inventory.view", "supplier.view", "purchase_request.approve",
      "accounting.view", "expense.create", "reports.export",
      "payroll.view", "leave.approve", "asset.manage",
      "support_ticket.manage",
    ],
  },
  {
    name: "Receptionist",
    permissions: [
      "patient.view", "patient.create", "patient.edit",
      "provider.view", "service.view",
      "appointment.view", "appointment.create", "appointment.reschedule", "appointment.cancel", "appointment.checkin",
      "charge.create", "invoice.view", "invoice.create",
      "payment.view", "payment.create", "refund.request", "cashier.open", "package.sell",
      "coverage.manage", "communication.send",
    ],
  },
  {
    name: "Doctor",
    permissions: [
      "patient.view", "patient.edit", "provider.view", "appointment.view", "appointment.checkin",
      "encounter.view", "encounter.create", "encounter.finalize",
      "clinical_notes.view", "clinical_notes.edit", "vitals.record",
      "prescription.create", "lab_order.create", "order.create", "package.consume",
    ],
  },
  {
    name: "Nurse",
    permissions: [
      "patient.view", "appointment.view", "appointment.checkin",
      "encounter.view", "encounter.create", "clinical_notes.view", "vitals.record", "package.consume",
    ],
  },
  {
    name: "Laboratory Technician",
    permissions: ["patient.view", "lab_result.enter", "lab_result.verify", "lab_test.manage"],
  },
  {
    name: "Pharmacist",
    permissions: ["patient.view", "inventory.view", "inventory.adjust", "product.manage", "prescription.verify", "prescription.dispense"],
  },
  {
    name: "Radiology Technician",
    permissions: ["patient.view", "room.view", "imaging_order.perform", "imaging_result.verify", "imaging_service.manage"],
  },
  {
    name: "Cashier",
    permissions: [
      "patient.view", "service.view",
      "charge.create", "invoice.view", "invoice.create",
      "payment.view", "payment.create", "refund.request", "cashier.open", "package.sell",
      "coverage.manage", "communication.send",
    ],
  },
  {
    name: "Accountant",
    permissions: [
      "accounting.view", "accounting.post", "accounting.period.manage", "chart_of_account.manage", "account_mapping.manage",
      "expense.create", "supplier_invoice.manage", "reports.export",
      "payor.manage", "coverage.manage", "claim.create", "claim.adjudicate",
      "invoice.view", "payment.view",
    ],
  },
  {
    name: "HR Manager",
    permissions: [
      "payroll.view", "payroll.process", "reports.export", "department.view",
      "provider.view", "service.view",
      "employee.manage", "attendance.record", "leave.request", "leave.approve",
      "commission.manage", "commission.view",
    ],
  },
  {
    name: "Inventory Manager",
    permissions: [
      "inventory.view", "inventory.adjust", "product.manage",
      "supplier.view", "supplier.manage",
      "purchase_request.create", "purchase_request.approve",
      "purchase_order.create", "goods_receipt.create",
      "supplier_invoice.manage", "stock.transfer", "asset.manage",
    ],
  },
]

/**
 * Upserts every `SYSTEM_ROLES` entry (and its permission grants) for one
 * organization — used by both `prisma/seed.ts` (the original bootstrap org)
 * and `commercial/provisioning.ts` (every clinic provisioned after P5.1),
 * so the two paths can never drift into granting different permissions for
 * a role of the same name. Accepts a plain `PrismaClient` or a
 * `Prisma.TransactionClient` — the caller decides whether this runs inside
 * a wider transaction (provisioning does; the seed script doesn't need to).
 */
export async function bootstrapSystemRoles(
  client: PrismaClient | Prisma.TransactionClient,
  organizationId: string
): Promise<void> {
  const allPermissions = await client.permission.findMany()
  const permissionByCode = new Map(allPermissions.map((p) => [p.code, p.id]))
  const allCodes = allPermissions.map((p) => p.code)

  for (const roleDef of SYSTEM_ROLES) {
    const role = await client.role.upsert({
      where: { organizationId_name: { organizationId, name: roleDef.name } },
      update: { isSystemRole: true },
      create: { organizationId, name: roleDef.name, isSystemRole: true },
    })

    const grantedCodes = roleDef.permissions === "ALL" ? allCodes : roleDef.permissions

    await client.rolePermission.deleteMany({ where: { roleId: role.id } })
    const permissionIds = grantedCodes
      .map((code) => permissionByCode.get(code))
      .filter((id): id is string => Boolean(id))
    if (permissionIds.length > 0) {
      await client.rolePermission.createMany({
        data: permissionIds.map((permissionId) => ({ roleId: role.id, permissionId })),
        skipDuplicates: true,
      })
    }
  }
}
