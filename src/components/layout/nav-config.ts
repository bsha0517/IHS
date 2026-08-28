import type { LucideIcon } from "lucide-react"
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
} from "lucide-react"

export type NavItem = {
  label: string
  href: string
  icon: LucideIcon
  /** Undefined = visible to any authenticated user (e.g. Dashboard). */
  permission?: string
}

export type NavGroup = {
  label: string
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
    items: [
      { label: "Episodes", href: "/episodes", icon: UserRound, permission: "encounter.view" },
      { label: "Encounters", href: "/encounters", icon: Stethoscope, permission: "encounter.view" },
      { label: "Orders", href: "/orders", icon: FileText, permission: "encounter.view" },
      { label: "Laboratory", href: "/laboratory", icon: FlaskConical, permission: "lab_result.enter" },
      { label: "Pharmacy", href: "/pharmacy", icon: Pill, permission: "prescription.dispense" },
      { label: "Radiology", href: "/radiology", icon: Scan, permission: "imaging_order.perform" },
    ],
  },
  {
    label: "Revenue",
    items: [
      { label: "POS", href: "/pos", icon: ShoppingCart, permission: "invoice.create" },
      { label: "Invoices", href: "/invoices", icon: FileText, permission: "invoice.view" },
      { label: "Payments", href: "/payments", icon: Wallet, permission: "payment.view" },
      { label: "Payors", href: "/payors", icon: Building2, permission: "payor.manage" },
      { label: "Claims", href: "/claims", icon: FileText, permission: "claim.create" },
    ],
  },
  {
    label: "Resources",
    items: [
      { label: "Inventory", href: "/inventory", icon: Boxes, permission: "inventory.view" },
      { label: "Purchasing", href: "/purchasing", icon: ShoppingCart, permission: "purchase_request.create" },
      { label: "Suppliers", href: "/suppliers", icon: Truck, permission: "supplier.view" },
      { label: "Assets", href: "/assets", icon: Wrench, permission: "inventory.view" },
    ],
  },
  {
    label: "Workforce",
    items: [
      { label: "Employees", href: "/employees", icon: UserCog, permission: "payroll.view" },
      { label: "Attendance", href: "/attendance", icon: Clock, permission: "payroll.view" },
      { label: "Leave", href: "/leave", icon: CalendarOff, permission: "payroll.view" },
      { label: "Payroll", href: "/payroll", icon: Banknote, permission: "payroll.view" },
      { label: "Commissions", href: "/commissions", icon: Percent, permission: "payroll.view" },
    ],
  },
  {
    label: "Finance",
    items: [
      { label: "Accounting", href: "/accounting", icon: Calculator, permission: "accounting.view" },
      { label: "Expenses", href: "/expenses", icon: Receipt, permission: "accounting.view" },
      { label: "Receivables", href: "/receivables", icon: Landmark, permission: "accounting.view" },
      { label: "Payables", href: "/payables", icon: CreditCard, permission: "accounting.view" },
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
    items: [
      { label: "Reports", href: "/reports", icon: BarChart3, permission: "reports.export" },
      { label: "Analytics", href: "/analytics", icon: PieChart, permission: "reports.export" },
    ],
  },
  {
    label: "Administration",
    items: [
      { label: "Users", href: "/admin/users", icon: ShieldCheck, permission: "users.manage" },
      { label: "Roles", href: "/admin/roles", icon: KeySquare, permission: "users.manage" },
      { label: "Audit", href: "/admin/audit", icon: History, permission: "audit.review" },
      { label: "System Events", href: "/admin/system-events", icon: AlertTriangle, permission: "system_events.view" },
      { label: "Settings", href: "/admin/settings", icon: Settings, permission: "settings.view" },
    ],
  },
]
