import type { LucideIcon } from "lucide-react"
import {
  Users,
  ListOrdered,
  CalendarDays,
  Stethoscope,
  HeartPulse,
  FlaskConical,
  Scan,
  Pill,
  Wallet,
  Boxes,
  ShoppingCart,
  Calculator,
  UserCog,
  Wrench,
  BarChart3,
  ClipboardCheck,
  ShieldCheck,
  Bell,
  Building2,
  LifeBuoy,
} from "lucide-react"

/**
 * P4.10 Stage 2 §6/§7 — the one central module-identity config, reused by
 * every page header and detail header across the app instead of each route
 * hand-picking its own color. Deliberately small (icon + a *text* accent +
 * a *surface* tint + a *border* accent, nothing else) and deliberately an
 * accent, never a page background theme (§6's own distinction). Where the
 * approved conceptual mapping (§6) gives a module two candidate hues (e.g.
 * "Laboratory → cyan/indigo"), one was picked here so adjacent items in the
 * same nav group never share a hue (Inventory/Assets/Purchasing all sit in
 * "Resources" — amber/slate/orange, not amber/amber/amber) — see the
 * per-key comments below for the reasoning on any non-obvious pick.
 *
 * Sidebar-only accents (nav-config.ts's `NavGroup.accentClass`, shipped in
 * Stage 1) are a coarser, separate mechanism and were left as-is; this file
 * is the finer-grained system Stage 2 needed for page/detail headers and
 * reuses the *same* hues where the two overlap, so the sidebar and the page
 * it leads to never disagree about a module's color.
 */
export type ModuleKey =
  | "patients"
  | "reception"
  | "appointments"
  | "clinical"
  | "nursing"
  | "laboratory"
  | "radiology"
  | "pharmacy"
  | "billing"
  | "inventory"
  | "procurement"
  | "finance"
  | "hr"
  | "assets"
  | "reports"
  | "onboarding"
  | "admin"
  | "notifications"
  | "platform"
  | "support"

export type ModuleVisual = {
  icon: LucideIcon
  /** Text/icon color, e.g. on an icon-container glyph. */
  accent: string
  /** Tinted container background behind the icon. */
  surface: string
  /** Left-border accent for a `DetailHeader`/context-bar card. */
  border: string
}

export const MODULE_VISUAL: Record<ModuleKey, ModuleVisual> = {
  patients: { icon: Users, accent: "text-primary", surface: "bg-primary/10", border: "border-l-primary" },
  reception: { icon: ListOrdered, accent: "text-cyan-600", surface: "bg-cyan-50", border: "border-l-cyan-600" },
  appointments: { icon: CalendarDays, accent: "text-cyan-600", surface: "bg-cyan-50", border: "border-l-cyan-600" },
  clinical: { icon: Stethoscope, accent: "text-primary", surface: "bg-primary/10", border: "border-l-primary" },
  // Nursing shares Reception's cyan (both queue-adjacent, front-of-house
  // clinical work) rather than inventing a fourth cyan-family hue.
  nursing: { icon: HeartPulse, accent: "text-cyan-600", surface: "bg-cyan-50", border: "border-l-cyan-600" },
  laboratory: { icon: FlaskConical, accent: "text-indigo-600", surface: "bg-indigo-50", border: "border-l-indigo-600" },
  radiology: { icon: Scan, accent: "text-blue-600", surface: "bg-blue-50", border: "border-l-blue-600" },
  pharmacy: { icon: Pill, accent: "text-emerald-600", surface: "bg-emerald-50", border: "border-l-emerald-600" },
  // §6: "Billing/POS → teal/green" — the brand teal itself, since revenue
  // sits conceptually close to the product's own identity color.
  billing: { icon: Wallet, accent: "text-primary", surface: "bg-primary/10", border: "border-l-primary" },
  inventory: { icon: Boxes, accent: "text-amber-600", surface: "bg-amber-50", border: "border-l-amber-600" },
  // §6: "Purchasing → warm amber/orange" — orange specifically, so it reads
  // distinct from Inventory's amber one item above it in the same nav group.
  procurement: { icon: ShoppingCart, accent: "text-orange-600", surface: "bg-orange-50", border: "border-l-orange-600" },
  finance: { icon: Calculator, accent: "text-indigo-600", surface: "bg-indigo-50", border: "border-l-indigo-600" },
  hr: { icon: UserCog, accent: "text-violet-600", surface: "bg-violet-50", border: "border-l-violet-600" },
  // §6: "Assets → slate/amber" — slate specifically, so it reads distinct
  // from Inventory's amber two items above it in the same "Resources" group.
  assets: { icon: Wrench, accent: "text-slate-600", surface: "bg-slate-100", border: "border-l-slate-500" },
  reports: { icon: BarChart3, accent: "text-blue-600", surface: "bg-blue-50", border: "border-l-blue-600" },
  onboarding: { icon: ClipboardCheck, accent: "text-primary", surface: "bg-primary/10", border: "border-l-primary" },
  admin: { icon: ShieldCheck, accent: "text-slate-600", surface: "bg-slate-100", border: "border-l-slate-500" },
  notifications: { icon: Bell, accent: "text-primary", surface: "bg-primary/10", border: "border-l-primary" },
  // P5.1 §44/§77: the platform operator control plane — "neutral/slate +
  // Avant teal... administrative, controlled, commercial, trustworthy,"
  // never a clinical-module hue. Shares Admin's slate rather than inventing
  // a tenth hue — the two are never rendered side by side (platform screens
  // live entirely outside the clinic-facing `(dashboard)` shell).
  platform: { icon: Building2, accent: "text-slate-600", surface: "bg-slate-100", border: "border-l-slate-500" },
  // P5.2 §7: a clinic-facing but operational/administrative concern (talks
  // to Avant's own support team, not a patient), so it shares Admin's slate
  // rather than a clinical hue — the same reasoning `platform` above uses.
  support: { icon: LifeBuoy, accent: "text-slate-600", surface: "bg-slate-100", border: "border-l-slate-500" },
}
