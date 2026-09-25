import type { LucideIcon } from "lucide-react"
import type { ModuleKey } from "@/lib/platform/entitlements-shared"
import {
  LayoutDashboard,
  Users,
  CalendarDays,
  ListOrdered,
  Stethoscope,
  UserRound,
  Layers,
  FlaskConical,
  Pill,
  Scan,
  ShoppingCart,
  FileText,
  Wallet,
  Building2,
  Boxes,
  Truck,
  Wrench,
  UserCog,
  Clock,
  CalendarOff,
  Banknote,
  Percent,
  Calculator,
  Receipt,
  Landmark,
  CreditCard,
  Megaphone,
  MessageSquare,
  BarChart3,
  PieChart,
  ShieldCheck,
  KeySquare,
  History,
  Settings,
  AlertTriangle,
  ScrollText,
  LayoutGrid,
  Activity,
  ClipboardCheck,
  LifeBuoy,
} from "lucide-react"

export type NavItem = {
  label: string
  href: string
  icon: LucideIcon
  /** Undefined = visible to any authenticated user (e.g. Dashboard). */
  permission?: string
  /**
   * P5.1 §15: hides this item when the organization's subscription has
   * disabled the module — checked in addition to, never instead of,
   * `permission` (§14: entitlement and RBAC are independent gates, both
   * must pass). Undefined = not a gateable module (always shown to anyone
   * holding the permission) — deliberately omitted on the core clinical
   * spine (Patients/Appointments/Reception/Queue/Providers/Services/
   * Episodes/Encounters/Orders) per entitlements.ts's own `CORE_MODULES`
   * reasoning (§16).
   */
  moduleKey?: ModuleKey
}

export type NavGroup = {
  label: string
  /**
   * P4.10 §16/§17 — a subtle, non-dominant per-module icon tint, applied
   * only to an item's icon (never its label) and only while the item is
   * *inactive* — the active item always resolves to the same primary teal
   * (via --sidebar-accent-foreground), so "you are here" stays one
   * unambiguous signal regardless of which module it's in. Deliberately
   * omitted on groups that should stay visually neutral (Home, Practice,
   * Engagement) rather than tinting every group — restrained, per §17's
   * own "not dominant" instruction.
   */
  accentClass?: string
  items: NavItem[]
}

// Mirrors spec.md §79 / ARCHITECTURE.md §8. Items whose domain hasn't been built
// yet (Phases 2+) are still listed here so the navigation shape matches the final
// product from day one — routes not yet implemented resolve to a "coming soon"
// placeholder rather than a broken link, until their phase lands.
export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Home",
    items: [{ label: "Dashboard", href: "/dashboard", icon: LayoutDashboard }],
  },
  {
    label: "Practice",
    items: [
      { label: "Patients", href: "/patients", icon: Users, permission: "patient.view" },
      { label: "Appointments", href: "/appointments", icon: CalendarDays, permission: "appointment.view" },
      { label: "Reception", href: "/reception", icon: ListOrdered, permission: "appointment.checkin" },
      { label: "Queue", href: "/queue", icon: ListOrdered, permission: "appointment.view" },
      { label: "Providers", href: "/providers", icon: Stethoscope, permission: "provider.view" },
      { label: "Services", href: "/services", icon: Layers, permission: "service.view" },
      { label: "Packages", href: "/packages", icon: Boxes, permission: "service.view" },
    ],
  },
  {
    label: "Clinical",
    accentClass: "text-primary/60",
    items: [
      { label: "Episodes", href: "/episodes", icon: UserRound, permission: "encounter.view" },
      { label: "Encounters", href: "/encounters", icon: Stethoscope, permission: "encounter.view" },
      { label: "Orders", href: "/orders", icon: FileText, permission: "encounter.view" },
      { label: "Laboratory", href: "/laboratory", icon: FlaskConical, permission: "lab_result.enter", moduleKey: "laboratory" },
      { label: "Pharmacy", href: "/pharmacy", icon: Pill, permission: "prescription.dispense", moduleKey: "pharmacy" },
      { label: "Radiology", href: "/radiology", icon: Scan, permission: "imaging_order.perform", moduleKey: "radiology" },
    ],
  },
  {
    label: "Revenue",
    accentClass: "text-info/60",
    items: [
      { label: "POS", href: "/pos", icon: ShoppingCart, permission: "invoice.create", moduleKey: "pos_billing" },
      { label: "Invoices", href: "/invoices", icon: FileText, permission: "invoice.view", moduleKey: "pos_billing" },
      { label: "Payments", href: "/payments", icon: Wallet, permission: "payment.view", moduleKey: "pos_billing" },
      { label: "Payors", href: "/payors", icon: Building2, permission: "payor.manage", moduleKey: "pos_billing" },
      { label: "Claims", href: "/claims", icon: FileText, permission: "claim.create", moduleKey: "pos_billing" },
    ],
  },
  {
    label: "Resources",
    accentClass: "text-emerald-600/60",
    items: [
      { label: "Inventory", href: "/inventory", icon: Boxes, permission: "inventory.view", moduleKey: "inventory" },
      { label: "Purchasing", href: "/purchasing", icon: ShoppingCart, permission: "purchase_request.create", moduleKey: "procurement" },
      { label: "Suppliers", href: "/suppliers", icon: Truck, permission: "supplier.view" },
      { label: "Assets", href: "/assets", icon: Wrench, permission: "inventory.view", moduleKey: "assets" },
    ],
  },
  {
    label: "Workforce",
    accentClass: "text-violet-600/60",
    items: [
      { label: "HR Workspace", href: "/hr", icon: LayoutGrid, permission: "payroll.view", moduleKey: "hr" },
      { label: "Employees", href: "/employees", icon: UserCog, permission: "payroll.view", moduleKey: "hr" },
      { label: "Attendance", href: "/attendance", icon: Clock, permission: "payroll.view", moduleKey: "hr" },
      { label: "Leave", href: "/leave", icon: CalendarOff, permission: "payroll.view", moduleKey: "hr" },
      { label: "Payroll", href: "/payroll", icon: Banknote, permission: "payroll.view", moduleKey: "payroll" },
      { label: "Commissions", href: "/commissions", icon: Percent, permission: "payroll.view", moduleKey: "hr" },
    ],
  },
  {
    label: "Finance",
    accentClass: "text-info/60",
    items: [
      { label: "Accounting", href: "/accounting", icon: Calculator, permission: "accounting.view", moduleKey: "finance" },
      { label: "Expenses", href: "/expenses", icon: Receipt, permission: "accounting.view", moduleKey: "finance" },
      { label: "Receivables", href: "/receivables", icon: Landmark, permission: "accounting.view", moduleKey: "finance" },
      { label: "Payables", href: "/payables", icon: CreditCard, permission: "accounting.view", moduleKey: "finance" },
    ],
  },
  {
    label: "Engagement",
    items: [
      { label: "Leads", href: "/leads", icon: Megaphone, permission: "patient.view" },
      { label: "Communications", href: "/communications", icon: MessageSquare, permission: "communication.send" },
    ],
  },
  {
    label: "Intelligence",
    accentClass: "text-indigo-600/60",
    items: [
      { label: "Reports", href: "/reports", icon: BarChart3, permission: "reports.export", moduleKey: "reports" },
      { label: "Analytics", href: "/analytics", icon: PieChart, permission: "reports.export" },
    ],
  },
  {
    label: "Administration",
    accentClass: "text-slate-500/70",
    items: [
      { label: "Users", href: "/admin/users", icon: ShieldCheck, permission: "users.manage" },
      { label: "Roles", href: "/admin/roles", icon: KeySquare, permission: "users.manage" },
      { label: "Audit", href: "/admin/audit", icon: History, permission: "audit.review" },
      { label: "Clinical Access Log", href: "/admin/clinical-access-log", icon: ScrollText, permission: "audit.review" },
      { label: "System Events", href: "/admin/system-events", icon: AlertTriangle, permission: "system_events.view" },
      { label: "Operations", href: "/admin/operations", icon: Activity, permission: "system_events.view" },
      { label: "Settings", href: "/admin/settings", icon: Settings, permission: "settings.view" },
      { label: "Onboarding", href: "/admin/onboarding", icon: ClipboardCheck, permission: "data_import.manage", moduleKey: "imports_onboarding" },
      // P5.2 §7: no `moduleKey` — support is never a commercially-gated
      // module (every clinic can always reach Avant's own support team
      // regardless of plan), so only the permission gate applies.
      { label: "Support", href: "/support", icon: LifeBuoy, permission: "support_ticket.manage" },
    ],
  },
]
