# P5.4 — Real-Clinic UAT Package

A reusable UAT procedure for the first real pilot clinic, built on the exact workflow set P5.3
already validated end-to-end against a synthetic clinic (19/19 areas, 63/63 E2E tests). This
document adapts that same coverage for use with a **real** clinic and **real** clinic data — it does
not expand the tested surface area, and it contains no PHI.

## 1. Test Data vs. Real Clinic Data

**Test data** — synthetic records used during implementation dry runs and this phase's own
regression testing (`test/e2e/p5-3/`, `test/e2e/p5-4/`): fabricated patient names, fabricated
contact details, no real clinical content. This data lives only in local/CI development databases,
never in source control as fixtures, and is never used against a production environment.

**Real clinic data** — data the clinic itself supplies once implementation begins for real: its
actual services, products, suppliers, medications, lab/imaging catalogue, chart of accounts, staff,
and (during UAT) real or realistic patient records the clinic consents to test with under their own
operational process. **Real patient data must never be placed into this repository, a development
fixture, or any file under source control.** UAT against real clinic data happens only in the
clinic's own provisioned environment.

## 2. Before UAT — Readiness Checklist

Confirm each of the following before starting real-clinic UAT (cross-reference
`docs/P5_4_LAUNCH_READINESS.md` for the authoritative, server-computed version of several of these):

- [ ] Organization provisioned
- [ ] Branches configured
- [ ] Users configured (per the clinic's real staff, with real roles)
- [ ] Providers configured
- [ ] Master data imported (services, products, suppliers, medications, lab/imaging catalogue,
      payors, packages as applicable)
- [ ] Communication templates configured (auto-provisioned per P5.4 §3 — confirm channel/copy suits
      this clinic, customize if needed)
- [ ] Financial configuration verified — no gaps reported at `/platform/organizations/[id]`'s Go-Live
      Approval card
- [ ] Opening inventory verified (if `inventory` is enabled)
- [ ] Support process explained to the clinic's own administrator (`docs/P5_4_INCIDENT_OPERATIONS.md`)

## 3. UAT Scenarios

The same 19 workflow areas P5.3 validated — run each against the real clinic's own configuration,
recording pass/fail via the Pilot UAT workspace (`/platform/organizations/[id]/uat`), scoped by
`SCENARIO_AREAS`: reception, doctor, inventory, billing, finance, laboratory, radiology, pharmacy,
multi_user, multi_branch, security.

| Area | What to verify |
|---|---|
| Reception | Patient registration, duplicate detection, search, booking, reschedule, cancel |
| Appointment | Full confirm → arrive → check-in queue progression |
| Patient | Patient 360 view across every module the clinic has enabled |
| Doctor | Encounter, vitals, diagnosis, orders, prescription, finalize |
| Nursing | Vitals recording, encounter participation |
| Lab | Assign tests, collect/receive specimen, result, verify, amend |
| Radiology | Assign service, schedule, perform, report, verify, amend |
| Pharmacy | Dispense (FEFO), insufficient-stock rejection, substitution warning, partial return |
| Procedures | Billable procedure workflow, if the clinic offers any beyond consultation |
| Packages | Sell, consume a session, balance decrements correctly |
| Billing | Invoice generation from mixed charges, balanced journal posting |
| Payments | Full/partial payment collection, cashier register open/close and variance |
| Refunds | Partial refund with financial reversal and commission clawback |
| Inventory | Purchase request → approval → order → receipt → real batch/ledger/journal |
| Procurement | Supplier invoice, supplier payment |
| Finance | Reporting reconciliation against real invoice/payment/stock rows |
| HR/Payroll | Employee/user linking, leave request/approval, full payroll lifecycle with balanced postings |
| Reports | Financial, inventory, commission reconciliation |
| Notifications | Real notification fires for the correct event, addressed to the correct recipient |
| Support | Ticket creation, internal/customer note visibility |
| Multi-branch | Branch-scoped access, org-wide role visibility across branches |
| Permissions | Role-appropriate access, correctly refused where not authorized |
| Entitlements | A disabled module is refused server-side, not just hidden from navigation |

## 4. Recording Results

Use the Pilot UAT workspace exactly as documented in `docs/P5_2_PILOT_OPERATIONS.md`: start a cycle,
add a scenario result per area (pass/fail/not-yet-run, with notes — **no patient-identifying
information in the notes field**), then complete and sign off the cycle once every required area has
passed. Sign-off is one of the 4 server-enforced go-live conditions — a cycle cannot be silently
skipped.

## 5. After UAT

Once UAT is signed off and every other go-live condition is verified,
`docs/P5_4_LAUNCH_READINESS.md` is the authoritative view of what (if anything) still blocks
approval. Approval itself (`approveGoLive()`) re-validates every condition server-side regardless of
what this checklist or the UI shows — the UI is a courtesy, never the actual gate.
