You have already built the Integrated Healthcare Information System described in the original project specification.

DO NOT rebuild the application.

Your job now is to act as a:

* Principal Software Architect
* Senior Healthcare Information Systems Consultant
* Senior Full-Stack Engineer
* PostgreSQL Database Architect
* Security Engineer
* UI/UX Auditor
* QA Engineer
* Performance Engineer

Perform a comprehensive audit of the EXISTING application.

The objective is to identify weaknesses, incomplete functionality, architectural problems, broken workflows, poor UX, security risks, data-integrity risks, missing integrations between modules, performance issues, and places where the application technically works but is not yet suitable for real clinic operations.

IMPORTANT:

Do not assume functionality exists merely because a page, component, route, Prisma model, button, or API endpoint exists.

Verify actual implementation.

Do not start rewriting the application.

Do not make large architectural changes until you have completed the audit.

⸻

1. FIRST — UNDERSTAND THE EXISTING PROJECT

Inspect:

* package.json
* project structure
* application routes
* components
* database schema
* migrations
* seed files
* authentication
* authorization
* API routes/server actions
* services
* domain logic
* validation
* tests
* environment configuration
* README
* PROJECT_STATUS.md
* ARCHITECTURE.md
* other project documentation

Build an accurate map of what currently exists.

⸻

2. MODULE COMPLETENESS AUDIT

Audit every existing module:

* Dashboard
* Patients
* Patient 360
* Providers
* Services
* Appointments
* Reception
* Queue
* Episodes
* Encounters
* Vitals
* Clinical Notes
* Diagnosis
* Prescriptions
* Clinical Orders
* Laboratory
* Pharmacy
* Radiology
* Packages
* POS
* Billing
* Payments
* Refunds
* Cashier
* Payors
* Insurance
* Claims
* Inventory
* Stock Ledger
* Procurement
* Suppliers
* Assets
* Maintenance
* HR
* Attendance
* Leave
* Payroll
* Provider Commissions
* Finance
* Accounting
* CRM
* Communications
* Patient Engagement
* Reports
* Users
* Roles
* Permissions
* Settings
* Audit Logs

For each module classify it:

COMPLETE

PARTIALLY COMPLETE

UI ONLY

BACKEND ONLY

BROKEN

MISSING

NOT APPLICABLE

Explain why.

⸻

3. FAKE FUNCTIONALITY AUDIT

Search specifically for:

* Placeholder buttons
* Empty handlers
* TODO comments
* FIXME comments
* Mock arrays
* Hardcoded statistics
* Hardcoded dashboard values
* Fake charts
* Demo data used as production data
* Functions returning dummy responses
* Forms that do not persist
* Filters that only affect frontend data
* Export buttons without real exports
* Print buttons without implementation
* Notification icons without notification logic
* Settings that save but do not affect application behavior
* APIs that are never called
* Pages displaying data without real relationships

Create a report called:

FAKE_OR_INCOMPLETE_FUNCTIONALITY.md

Do not automatically delete these items.

Document them first.

⸻

4. WORKFLOW AUDIT

Verify these workflows end-to-end.

Patient Journey

Patient Registration
→ Appointment
→ Arrival
→ Check-In
→ Queue
→ Vitals
→ Episode
→ Encounter
→ Diagnosis
→ Prescription
→ Orders
→ Procedure
→ Completion
→ Charges
→ Invoice
→ Payment
→ Accounting
→ Follow-Up

Verify that information flows automatically.

Identify duplicate data entry.

⸻

Laboratory

Doctor Order
→ Lab Queue
→ Specimen
→ Collection
→ Processing
→ Result
→ Verification
→ Final Result
→ EMR

⸻

Pharmacy

Prescription
→ Pharmacy Queue
→ Dispensing
→ Stock Reduction
→ Billing
→ Medication History

⸻

Procurement

Purchase Request
→ Approval
→ Purchase Order
→ Goods Receipt
→ Inventory
→ Supplier Invoice
→ Accounts Payable
→ Payment
→ Accounting

⸻

HR

Employee
→ Attendance
→ Leave
→ Payroll
→ Commission
→ Payslip
→ Payment
→ Accounting

⸻

Revenue

Clinical Activity
→ Charge
→ Invoice
→ Payment
→ AR
→ Accounting

Document every break in these chains.

⸻

5. DATABASE AUDIT

Inspect the entire PostgreSQL/Prisma design.

Look for:

* Missing foreign keys
* Incorrect relationships
* Missing indexes
* Duplicate data
* Overuse of JSON
* Incorrect nullable fields
* Poor enum design
* Missing uniqueness constraints
* Unsafe cascading deletes
* Incorrect soft deletion
* Currency stored incorrectly
* Missing timestamps
* Missing organization isolation
* Missing branch isolation
* Broken patient relationships
* Broken Episode/Encounter relationships
* Broken accounting relationships
* Broken inventory relationships

Pay special attention to:

Patient
Episode
Encounter
Appointment
ClinicalOrder
Invoice
Charge
Payment
InventoryMovement
JournalEntry

These are core entities.

⸻

6. DATA INTEGRITY AUDIT

Determine whether the application could accidentally allow:

* Duplicate MRNs
* Duplicate invoice numbers
* Duplicate appointment numbers
* Doctor double booking
* Room double booking
* Negative stock
* Selling expired stock
* Package over-consumption
* Payment exceeding invoice balance
* Refund exceeding payment
* Unbalanced journal entries
* Editing posted accounting transactions
* Deleting invoices
* Deleting clinical history
* Editing finalized clinical records without history
* Cross-branch data leakage
* Cross-organization data leakage

Mark these as HIGH PRIORITY if found.

⸻

7. SECURITY AUDIT

Review:

Authentication

Authorization

RBAC

API authorization

Server actions

Session handling

Passwords

Environment variables

File uploads

Sensitive documents

Clinical information

Financial information

Payroll information

Audit logs

Check whether someone could bypass the UI and call an endpoint directly.

Frontend hiding is NOT authorization.

Test access boundaries such as:

Receptionist → Clinical Notes

Doctor → Payroll

HR → Patient Clinical Records

Cashier → Employee Salary

Inventory Manager → Accounting

Branch A User → Branch B Data

Unauthorized access must be impossible unless explicitly permitted.

⸻

8. AUDIT TRAIL REVIEW

Verify important actions generate audit records.

Particularly:

* Patient changes
* Clinical note changes
* Encounter finalization
* Prescription
* Lab results
* Refunds
* Discounts
* Inventory adjustments
* Payroll
* Accounting
* Permissions
* User management

Check whether audit logs themselves can be modified.

They should be effectively immutable through normal application operations.

⸻

9. ACCOUNTING AUDIT

Verify actual double-entry accounting behavior.

Check:

Invoice
Payment
Refund
Expense
Purchase
Supplier Invoice
Supplier Payment
Payroll
Inventory
Asset Purchase

Ensure:

Debit = Credit

Check that operational modules are not creating inconsistent accounting logic independently.

Identify transactions that should generate journals but currently do not.

⸻

10. INVENTORY AUDIT

Verify:

Batch tracking

Expiry tracking

FEFO

Stock ledger

Purchase receiving

POS reduction

Pharmacy dispensing

Procedure consumption

Returns

Damage

Expiry

Transfers

Adjustments

No stock quantity should change without corresponding movement history.

⸻

11. UI/UX AUDIT

Pretend you are actual clinic staff.

Review workflows as:

Receptionist

Doctor

Nurse

Cashier

Clinic Manager

Inventory Manager

HR Manager

Accountant

Identify:

* Too many clicks
* Confusing navigation
* Repeated data entry
* Oversized forms
* Poor tables
* Missing search
* Poor mobile behavior
* Missing loading states
* Missing empty states
* Weak validation feedback
* Dangerous buttons
* Missing confirmations
* Inconsistent terminology
* Inconsistent design

Do not redesign yet.

Document problems first.

⸻

12. PERFORMANCE AUDIT

Look for:

* N+1 database queries
* Huge queries
* Entire tables loaded into browser
* Missing pagination
* Missing indexes
* Excessive React rerenders
* Duplicate API requests
* Slow dashboards
* Inefficient joins
* Huge JavaScript bundles
* Unoptimized images
* Expensive calculations performed repeatedly

Estimate likely problems when:

Patients = 100,000+

Appointments = 1,000,000+

Invoices = 1,000,000+

Inventory movements = millions

Audit logs = millions

⸻

13. REPORTING AUDIT

Verify reports use real information.

Check:

Appointment reports

Patient reports

Provider reports

Revenue reports

Inventory reports

HR reports

Accounting reports

Claims reports

Asset reports

Verify:

Filters

Date ranges

Branch filtering

Provider filtering

Pagination

CSV/Excel

PDF

Totals

Do not accept visually attractive reports containing incorrect calculations.

⸻

14. CODE QUALITY AUDIT

Check:

* TypeScript strictness
* any
* Duplicated code
* Huge components
* Huge server files
* Business logic inside React components
* Database queries inside inappropriate layers
* Circular dependencies
* Dead code
* Unused imports
* Naming inconsistencies
* Error handling
* Logging
* Testability

⸻

15. TESTING AUDIT

Determine:

What is tested?

What is not?

Identify missing tests for:

Authentication

Authorization

Appointments

Encounters

Clinical finalization

Orders

Invoice calculations

Payments

Refunds

Inventory

Payroll

Commission

Accounting

Claims

Create recommended testing priorities.

⸻

16. DO NOT FIX EVERYTHING YET

After completing the audit, create:

SYSTEM_AUDIT.md

Include:

Executive Summary

Critical Issues

High Priority

Medium Priority

Low Priority

Architecture Problems

Database Problems

Security Problems

Workflow Problems

UI/UX Problems

Performance Problems

Testing Gaps

Missing Features

Technical Debt

⸻

Then create:

IMPROVEMENT_ROADMAP.md

Divide improvements into:

P0 — Critical

P1 — Must Fix

P2 — Important

P3 — Enhancement

P4 — Future

⸻

17. PRIORITIZATION

Prioritize:

1. Data loss risks
2. Security vulnerabilities
3. Clinical record integrity
4. Financial integrity
5. Inventory integrity
6. Broken workflows
7. Authorization
8. Performance
9. UX
10. New features

Do NOT prioritize cosmetic changes over system integrity.

⸻

18. FINAL OUTPUT

At the end tell me:

1. What percentage of the system appears genuinely functional?
2. What percentage is UI-only or incomplete?
3. What are the 10 biggest risks?
4. What are the 10 highest-value improvements?
5. What should we fix before adding ANY new functionality?
6. What should be improved before deploying to a real clinic?
7. What can wait until later?
8. Which architectural decisions should be reconsidered?

Then STOP.

Do NOT perform the large-scale fixes yet.

Wait for me to approve the improvement roadmap.

The purpose of this audit is to understand the REAL state of the application rather than assuming that successful compilation means the healthcare system is production ready.