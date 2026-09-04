import "server-only"
import { can } from "@/lib/platform/permissions-core"
import type { SessionContext } from "@/lib/auth/session"

/**
 * P3.12 §33-36: where a signed-in session lands after login, resolved
 * centrally (§35 — not scattered per-page, not display-name string
 * matching) from real permission codes rather than role names, so it
 * survives an org renaming a role or adding a custom one with the same
 * job shape. `/dashboard` already degrades gracefully for every role (it
 * permission-gates each of its sections rather than crashing — see
 * dashboards.ts's `visibleDashboardSections`/`getDoctorDashboard`), so this
 * is a UX improvement on top of an already-safe fallback, not a
 * replacement for it: every branch below still ends up somewhere that
 * itself enforces its own `assertCan` independently. Getting this function
 * wrong can misroute a role to a less useful landing page — it can never
 * grant access to anything.
 *
 * Each check below is chosen for being the most reliably distinguishing
 * permission code for that seeded role (see prisma/seed.ts's SYSTEM_ROLES)
 * — not merely "a permission that role happens to hold" — and ordered so a
 * role holding a broader combination (e.g. Super Admin/Organization
 * Administrator holding literally every code) is caught by the first,
 * most senior check before any job-specific one could misfire.
 */
export function resolveDefaultLandingRoute(session: SessionContext): string {
  // Super Admin / Organization Administrator: the only seeded roles that
  // hold `users.manage` (see seed.ts) — a reliable "this is an
  // administrator" signal without matching on either role's literal name.
  // Their /dashboard already shows the Management section (they also hold
  // reports.export), so no redirect needed.
  if (can(session, "users.manage")) return "/dashboard"

  if (can(session, "lab_result.enter")) return "/laboratory" // Laboratory Technician
  if (can(session, "imaging_order.perform")) return "/radiology" // Radiology Technician
  if (can(session, "prescription.dispense")) return "/pharmacy" // Pharmacist
  if (can(session, "purchase_order.create")) return "/inventory" // Inventory Manager
  if (can(session, "payroll.process")) return "/hr" // HR Manager
  if (can(session, "accounting.post")) return "/accounting" // Accountant

  // Doctor: `encounter.finalize` is unique to Doctor among clinical roles
  // (Nurse can open an encounter but not finalize it) — checked before the
  // Nurse check below since Doctor also holds `vitals.record`.
  if (can(session, "encounter.finalize")) return "/dashboard" // Doctor's Day section is already tailored here
  if (can(session, "vitals.record")) return "/queue" // Nurse

  // Cashier and Receptionist share almost the same revenue-side permission
  // set; `patient.create` is the one Receptionist holds and Cashier does
  // not, so it's checked first to keep Cashier from falling through to the
  // Receptionist branch below.
  if (can(session, "cashier.open") && !can(session, "patient.create")) return "/pos" // Cashier
  if (can(session, "appointment.checkin")) return "/reception" // Receptionist

  // Clinic Manager (and anyone else without a more specific match): the
  // Management dashboard section already covers this role.
  return "/dashboard"
}
