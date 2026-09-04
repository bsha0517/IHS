# Clinic UAT Sign-Off

A lightweight record that a specific clinic's staff exercised the system before go-live and
accepted it, with known limitations named explicitly. One copy per clinic, kept on file (not
committed to this repository — copy this template out per engagement).

---

## Clinic

- **Clinic / organization name:**
- **Organization ID (Avant HIS):**
- **Branch(es) covered by this UAT:**

## Environment

- **Deployment URL:**
- **Environment type:** ☐ Production ☐ Staging
- **Database:** (Supabase project name/ref)

## Release

- **Git commit / release version deployed:**
- **`release:check` result (attach or reference):**
- **Migrations applied (count / latest migration name):**

## UAT Date(s)

-

## Participants

| Name | Role tested | Organization |
|---|---|---|
| | | |
| | | |

## Workflows Tested

Check what was actually exercised by a real named participant, not just Super Admin.

- [ ] Login / logout, correct landing page per role
- [ ] Patient registration
- [ ] Appointment booking / check-in
- [ ] Doctor consultation (vitals → note → diagnosis → orders)
- [ ] Nursing / vitals entry
- [ ] Laboratory order → result → verification
- [ ] Radiology order → report (if used at this clinic)
- [ ] Pharmacy dispensing (if used at this clinic)
- [ ] Billing / POS / payment
- [ ] Refund (if exercised)
- [ ] Inventory receiving / stock movement (if used)
- [ ] Reports viewed / exported
- [ ] Print output reviewed (invoice, receipt, prescription, lab/radiology report, payslip — as
      applicable)

## Known Limitations Acknowledged

Copy the relevant items from `docs/COMMERCIAL_READINESS.md`'s "Current Limitations" section and
`P4_9_COMMERCIAL_READINESS_ACCEPTANCE_REPORT.md`'s Production-Unproven Items and Go-Live
Conditions here, so the clinic explicitly sees what they're accepting.

-

## Open Conditions

Anything from the Go-Live Checklist not yet complete at the time of this sign-off, with an owner
and target date.

| Condition | Owner | Target date |
|---|---|---|
| | | |

## Acceptance

- [ ] The participants above exercised the workflows checked, using their own real role accounts.
- [ ] Known limitations above were reviewed and are acceptable for go-live.
- [ ] Open conditions above have named owners and dates.

## Sign-Off

| Name | Role | Signature | Date |
|---|---|---|---|
| | Clinic Administrator | | |
| | Release Owner | | |
