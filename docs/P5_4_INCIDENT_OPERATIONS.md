# P5.4 — First-Clinic Incident & Support Operations

A concise, practical incident and support procedure for the first real pilot clinic — built on the
existing P5.2 support-ticket system and P1/P4 observability, not a new ITSM platform.

## 1. For Clinic Users — How to Get Support

### Requesting support

1. Go to **Support** (`/support`) and click **New ticket**.
2. Give it a clear title and describe the issue in general operational terms.
3. **Do not include patient names, MRNs, diagnoses, prescriptions, clinical notes, or any other
   unnecessary PHI in a support ticket.** The ticket form already displays this warning directly
   above the description field (`new-ticket-dialog.tsx`) — if you're ever unsure whether a detail is
   needed, leave it out and a support operator will ask for it through a secure channel if it's
   genuinely required.
4. A support operator responds on the same ticket. You'll see their reply as a **customer-visible**
   note — an operator may also leave **internal** notes to each other while investigating, which you
   will never see (this is enforced by the system, not just a UI convention: an internal note is
   never even fetched on your read path).

### Checking ticket status

Your ticket's status (`open`, `in progress`, `waiting on customer`, `resolved`, `closed`) is visible
on the ticket itself at `/support/[id]`, along with every customer-visible note, at any time — no
separate status page or email is needed today (no notification/email channel is wired to ticket
events yet — see Known Limitations, §5).

### What counts as urgent

Treat an issue as urgent (raise it as **Critical** or flag it clearly as blocking in the ticket
title/description) if it matches Table 1's Critical or High severity below — anything preventing
normal clinic operation, a billing/payment failure, or anything that looks like it might expose one
patient's data to the wrong person. Everything else is Normal.

## 2. Severity Classification

| Severity | Examples |
|---|---|
| **Critical** | Tenant isolation failure (one clinic can see another's data), patient data exposure, widespread clinical outage (reception/appointments/clinical down clinic-wide), financial corruption (unbalanced journal, duplicate posting), database corruption |
| **High** | A major workflow entirely unavailable (e.g. no one can book appointments, or the whole billing/POS flow is down), payment failure, inventory corruption (negative stock, drifted ledger), authentication failure affecting the clinic |
| **Normal** | An isolated feature issue, a reporting problem, a configuration problem (e.g. a missing account mapping — see `docs/P5_4_LAUNCH_READINESS.md`) |

## 3. Incident Workflow

```
Detect → Record → Classify → Contain → Investigate → Fix → Verify → Communicate → Close
```

1. **Detect** — via a clinic-submitted ticket (`/support`), a platform operator's own monitoring
   (external error monitoring — one of the 4 go-live conditions every clinic already has, plus
   `/admin/operations` and `/admin/system-events` for outbox/dead-letter health), or `npm run
   db:security:check` catching a real RLS regression.
2. **Record** — every incident gets a ticket at `/platform/tickets`, even one an operator noticed
   themselves rather than one the clinic filed — this is the one place incident history lives, and
   every action taken should leave a trace there (internal notes, since operator-to-operator
   investigation detail is not the clinic's concern).
3. **Classify** — apply the severity table above. Reclassify if new evidence changes the picture; the
   ticket keeps its own priority field (`SupportTicketPriority`: low/normal/high/critical) for this.
4. **Contain** — for a Critical tenant-isolation or data-exposure issue, the immediate containment
   action available today is suspending the affected organization (`Suspend organization` on its
   platform detail page) — this blocks normal clinic login/operation immediately, not merely on next
   login (P4.3's own proven behavior, confirmed again by P5.3's UAT). Use this only for a genuine
   Critical issue; it is disruptive to the clinic by design.
5. **Investigate** — reproduce the issue directly against the real database/application (the same
   discipline P5.3's own UAT methodology used: verify database/application state, not just what the
   UI reports), using `/admin/system-events` for outbox/posting failures and the application's own
   structured logs (`src/lib/platform/logger.ts`) for everything else.
6. **Fix** — classify the underlying defect using the same P0–P3 scale this phase itself uses
   (`docs/P5_4_COMPLETION_REPORT.md` §1's own definitions); a P0/P1 gets fixed immediately, a
   contained P2 gets fixed if directly relevant, a P3 gets logged to `BACKLOG.md`.
7. **Verify** — re-run the specific workflow the incident affected against the real application (not
   just re-reading the fix), and re-run the relevant regression gate (integration suite section,
   E2E scenario, or `db:security:check` as appropriate).
8. **Communicate** — reply on the ticket with a customer-visible note describing what happened (in
   plain operational terms, no internal investigation detail) and that it's resolved; reactivate a
   suspended organization once resolved.
9. **Close** — mark the ticket `resolved`/`closed` once the clinic confirms (or after a reasonable
   window with no further report).

## 4. Roles

| Question | Answer |
|---|---|
| Who monitors? | The platform operator(s) with access to `/platform/tickets` and `/admin/operations` — no dedicated on-call rotation tooling exists yet; a real deployment should nominate a specific operator/rotation before go-live (see Known Limitations). |
| Who investigates? | Whichever platform operator picks up the ticket; `/platform/tickets` has no formal assignment field today (see Known Limitations) — informal ownership via the first internal note is the current convention. |
| Who communicates with the clinic? | The investigating operator, via customer-visible notes on the ticket. |
| Where are incidents recorded? | `/platform/tickets` (`SupportTicket`/`SupportTicketNote`) — the one system of record. |
| How is evidence preserved? | `AuditLog` for every state-changing action already taken through the product (suspension, go-live approval, mapping changes, etc.), plus the ticket's own internal notes for investigation narrative. No separate incident-evidence store exists — this is what's available today. |

## 5. Known Limitations

- No SLA engine and no automated notification when a ticket is created/updated — a clinic (or an
  operator) must check `/support` or `/platform/tickets` directly. Explicitly out of scope for P5.4
  per its own instructions ("do not build complex SLA/notification functionality unless a concrete
  P5.4 blocker requires it") — no blocker was found that requires it.
- No formal on-call rotation or per-ticket operator assignment exists in the schema. For the first
  real pilot, nominate a specific operator (or small rotation) informally and record that decision in
  `docs/P5_4_COMMERCIAL_HANDOVER.md`'s own handover checklist rather than in the product itself.
- The outbox sweep's recovery latency is currently once daily on Vercel's Hobby tier
  (`DEPLOYMENT.md`'s "Outbox Sweep Scheduling") — a stuck financial/notification event can wait up to
  ~24h for automatic recovery; the manual "Sweep now" button on `/admin/system-events` is the
  immediate workaround an investigating operator should use during an active incident, not wait on
  the schedule.
