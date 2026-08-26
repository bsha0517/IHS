MASTER BUILD PROMPT

Integrated Healthcare Information System (HIS) for Clinics & Polyclinics

1. YOUR ROLE

Act as a combined:

* Principal Healthcare Software Architect
* Senior Full-Stack Engineer
* PostgreSQL Database Architect
* Healthcare Information Systems Consultant
* EMR/EHR Product Architect
* Revenue Cycle Management Specialist
* ERP Architect
* Accounting Systems Architect
* UI/UX Designer
* Security Engineer
* QA Engineer
* DevOps Engineer

You are responsible for architecting and building from scratch a production-grade Integrated Healthcare Information System (HIS) primarily designed for:

* Outpatient clinics
* Medical centers
* Polyclinics
* Specialist clinics
* Diagnostic clinics
* Multi-branch healthcare organizations

This is NOT a simple CRM.

This is NOT merely an appointment booking application.

This is NOT merely a POS.

This is NOT a collection of disconnected CRUD pages.

The objective is to create a unified healthcare platform inspired by the architectural scope of modern systems such as Nixpend, while creating an original implementation, original UI, original database architecture, and original source code.

Do not copy proprietary source code, text, branding, visual assets, or protected design elements from any third-party product.

⸻

2. PRODUCT VISION

Build a unified platform where:

Clinical Operations + Practice Management + Revenue Cycle + Resource Management + Patient Engagement + Reporting

operate within the same ecosystem.

The system should eventually support six major domains:

A. Practice Management

* Patient Registration
* Patient CRM
* Provider Management
* Appointment Scheduling
* Reception
* Check-In
* Patient Queue
* Departments
* Rooms
* Services
* Packages
* Billing
* POS
* Payor Management
* Insurance
* Claims

B. Clinical / Health Information Management

* Electronic Medical Record
* Patient Episodes
* Encounters
* Vitals
* Allergies
* Problem Lists
* Diagnosis
* Clinical Notes
* Treatment Plans
* Procedures
* Prescriptions
* CPOE
* Clinical Orders
* Follow-Up
* Clinical Documents

C. Clinical Support Systems

Architect for:

* Laboratory Information System (LIS)
* Pharmacy Information System (PIS)
* Radiology Information System (RIS)
* Future PACS integration

D. Resource Management / ERP

* Inventory
* Procurement
* Suppliers
* Assets
* HR
* Attendance
* Leave
* Payroll
* Doctor Commissions
* Finance
* Accounting
* Accounts Receivable
* Accounts Payable

E. Patient Engagement

* Patient Portal
* Online Booking
* SMS
* WhatsApp
* Email
* Notifications
* Reminders
* Patient Documents
* Patient Statements
* Feedback
* Surveys

F. Administration & Intelligence

* Dashboards
* Reports
* Analytics
* Users
* Roles
* Permissions
* Audit Logs
* Workflow Configuration
* Organization Settings
* Branch Settings
* Integrations

⸻

3. MOST IMPORTANT ARCHITECTURAL PRINCIPLE

The system must operate around a single connected patient journey.

Do NOT design each module as an isolated application.

Example:

Patient
→ Appointment
→ Check-In
→ Episode
→ Encounter
→ Vitals
→ Doctor Consultation
→ Diagnosis
→ Orders
→ Procedures
→ Prescription
→ Billing
→ Payment
→ Accounting
→ Follow-Up

Clinical orders may branch into:

Encounter
→ Laboratory Order
→ LIS

Encounter
→ Medication Order
→ Pharmacy

Encounter
→ Imaging Order
→ RIS

Encounter
→ Procedure
→ Treatment Room

All relevant information should return to the patient’s longitudinal clinical record.

⸻

4. CORE HEALTHCARE DATA MODEL

The architecture must clearly distinguish:

Patient

The person receiving healthcare.

Episode

A healthcare problem, treatment journey, or period of care.

Example:

Patient: Ahmed Khan

Episode 1:
Lower Back Pain

Episode 2:
Skin Allergy

Episode 3:
Diabetes Follow-Up

Encounter

An individual interaction between the patient and healthcare provider.

An episode can contain multiple encounters.

Example:

Episode:
Lower Back Pain

Encounter 1:
Initial consultation

Encounter 2:
MRI review

Encounter 3:
Physiotherapy

Encounter 4:
Follow-up

Appointment

Scheduling object.

An appointment may result in an encounter.

Do NOT treat Appointment and Encounter as the same entity.

Order

A structured clinical instruction.

Examples:

* Laboratory test
* Medication
* Imaging
* Procedure
* Referral

Invoice

Financial document generated from billable activity.

These entities must be architecturally separate but connected.

⸻

5. MULTI-ORGANIZATION / MULTI-BRANCH FOUNDATION

Design from the beginning for:

Organization
→ Branch
→ Department
→ Room

A future SaaS version may host multiple organizations.

Each organization should be logically isolated.

Branches may have separate:

* Doctors
* Employees
* Appointment calendars
* Rooms
* Inventory
* Assets
* Cash registers
* Revenue
* Expenses

Management should be able to view consolidated reports.

⸻

6. AUTHENTICATION

Implement secure authentication.

Requirements:

* Email/username login
* Secure password hashing
* Session management
* Password reset architecture
* Login history
* Failed login tracking
* Account lock controls
* Optional future MFA/2FA

Never store plain-text passwords.

Never trust frontend authorization.

⸻

7. ROLE-BASED ACCESS CONTROL

Create granular RBAC.

Default roles:

* Super Admin
* Organization Administrator
* Clinic Manager
* Receptionist
* Doctor
* Nurse
* Laboratory Technician
* Pharmacist
* Radiology Technician
* Cashier
* Accountant
* HR Manager
* Inventory Manager

Permissions should be capability based.

Examples:

patient.view
patient.create
patient.edit

appointment.view
appointment.create
appointment.reschedule
appointment.cancel

encounter.view
encounter.create
encounter.finalize

clinical_notes.view
clinical_notes.edit

prescription.create

lab_order.create
lab_result.enter
lab_result.verify

invoice.create
invoice.discount
invoice.refund

inventory.view
inventory.adjust

accounting.view
accounting.post

payroll.view
payroll.process

users.manage

reports.export

Permissions must be enforced server-side.

⸻

8. DASHBOARD

Create role-aware dashboards.

Management Dashboard

Show:

* Today’s appointments
* Patients checked in
* Patients waiting
* Consultations completed
* No-shows
* New patients
* Revenue
* Collections
* Outstanding receivables
* Expenses
* Top services
* Doctor revenue
* Branch performance
* Low stock
* Expiring stock
* Assets requiring maintenance
* Employees present
* Employees absent

Reception Dashboard

Show:

* Today’s appointments
* Arrivals
* Waiting patients
* Upcoming appointments
* No-shows
* Quick patient registration
* Quick booking

Doctor Dashboard

Show:

* Today’s schedule
* Waiting patients
* Current encounter
* Follow-ups
* Pending clinical tasks
* Recent patients

Finance Dashboard

Show:

* Revenue
* Collections
* Receivables
* Payables
* Expenses
* Cash position

Every dashboard must use real persisted database data.

⸻

9. PATIENT REGISTRATION

Create a complete Patient Master.

Fields:

* Internal UUID
* MRN
* First name
* Middle name
* Last name
* Profile photo
* DOB
* Calculated age
* Gender
* Nationality
* Mobile
* WhatsApp
* Email
* Address
* City
* Country
* National ID
* Passport
* Emergency contact
* Emergency relationship
* Preferred language
* Referral source
* Preferred doctor
* Registration branch
* Registration date
* Status

Support duplicate detection using:

* Phone
* Email
* National ID
* Name + DOB

Warn rather than silently creating duplicates.

⸻

10. PATIENT 360° PROFILE

Create a comprehensive Patient 360 page.

Header should display:

* Patient
* MRN
* Age
* Gender
* Contact
* Important alerts
* Allergies
* Outstanding balance
* Next appointment

Tabs:

Overview

Timeline

Episodes

Encounters

Appointments

Vitals

Diagnoses

Prescriptions

Orders

Lab Results

Imaging

Procedures

Packages

Invoices

Payments

Documents

Communications

Use authorization to determine which tabs/data a user may access.

⸻

11. PATIENT TIMELINE

Build a chronological patient timeline.

Events may include:

* Registration
* Appointment
* Check-In
* Encounter
* Diagnosis
* Prescription
* Lab Order
* Lab Result
* Imaging Order
* Procedure
* Package Usage
* Invoice
* Payment
* Refund
* Document
* Communication
* Follow-Up

Create this from structured domain events or queries rather than manually duplicating every piece of information.

⸻

12. MEDICAL PROFILE

Store:

* Allergies
* Chronic diseases
* Active conditions
* Previous conditions
* Current medications
* Surgical history
* Family history
* Medical history
* Alerts

Important clinical alerts must be highly visible to authorized clinical staff.

⸻

13. VITAL SIGNS

Track:

* Height
* Weight
* BMI
* Blood pressure
* Pulse
* Temperature
* Oxygen saturation
* Respiratory rate
* Blood glucose

Every measurement requires:

* Patient
* Date/time
* Recorded by
* Encounter
* Branch

Historical readings must remain available.

⸻

14. PROVIDER MANAGEMENT

Create Provider Master.

Providers may include:

* Doctor
* Dentist
* Physiotherapist
* Nurse
* Therapist
* Other licensed practitioner

Fields:

* Provider ID
* Employee
* Specialty
* Qualification
* License
* License authority
* License issue date
* License expiry
* Services
* Consultation fee
* Appointment duration
* Branches
* Departments
* Schedule
* Commission configuration

⸻

15. SERVICE MANAGEMENT

Service Master:

* Service code
* Name
* Category
* Department
* Description
* Duration
* Price
* Tax
* Billable status
* Active status
* Eligible providers
* Required room type
* Commission rule
* Inventory consumption template

Examples:

Consultation
Procedure
Therapy
Diagnostic Service
Lab Test
Imaging
Treatment

⸻

16. PROVIDER SCHEDULING

Allow configuration of:

* Working days
* Working hours
* Breaks
* Branch
* Department
* Room
* Appointment duration
* Holidays
* Leave
* Temporary schedule changes

Prevent:

* Provider double booking
* Room double booking

Approved leave should automatically block appointment availability.

⸻

17. APPOINTMENT MANAGEMENT

Appointment fields:

* Appointment number
* Patient
* Provider
* Service
* Branch
* Department
* Room
* Date
* Start time
* End time
* Duration
* Booking source
* Notes

Statuses:

Scheduled
Confirmed
Arrived
Checked In
Waiting
In Consultation
Completed
Cancelled
Rescheduled
No Show

Maintain status history.

⸻

18. APPOINTMENT CALENDAR

Views:

* Day
* Week
* Month
* Provider
* Department
* Room

Filters:

* Branch
* Provider
* Department
* Service
* Status

Allow controlled rescheduling.

⸻

19. RECEPTION & CHECK-IN

Create a dedicated Reception workspace.

Reception should be able to:

* Search patient
* Register patient
* View appointment
* Book appointment
* Confirm appointment
* Mark arrival
* Check-in
* Generate queue token
* Collect administrative information
* View outstanding balance where permitted

⸻

20. QUEUE MANAGEMENT

Workflow:

Appointment
→ Arrived
→ Checked In
→ Waiting
→ Called
→ In Consultation
→ Completed

Track:

* Queue/token number
* Arrival time
* Check-in time
* Called time
* Consultation start
* Consultation end
* Waiting duration

Create Doctor Queue view.

⸻

21. EPISODE MANAGEMENT

Create Episode entity.

Fields:

* Episode number
* Patient
* Episode type
* Title
* Description
* Start date
* End date
* Primary provider
* Branch
* Status

Statuses:

Open
Active
Completed
Cancelled

Allow encounters to belong to an episode.

Allow standalone encounters where clinically appropriate.

⸻

22. ENCOUNTER MANAGEMENT

Create Encounter entity.

Types:

* Consultation
* Follow-Up
* Procedure
* Therapy
* Emergency/Walk-In
* Diagnostic
* Teleconsultation-ready

Fields:

* Encounter number
* Patient
* Episode
* Appointment
* Provider
* Branch
* Department
* Start
* End
* Status

Statuses:

Draft
Active
Completed
Finalized

⸻

23. CLINICAL CONSULTATION WORKSPACE

Doctors should see:

* Patient summary
* Allergies
* Problems
* Medication
* Previous encounters
* Recent vitals
* Recent results
* Active episode

Clinical documentation:

* Chief complaint
* History of present illness
* Review
* Examination
* Clinical findings
* Assessment
* Diagnosis
* Treatment plan
* Procedure
* Orders
* Prescription
* Follow-up

Support configurable clinical templates.

⸻

24. DIAGNOSIS

Diagnosis fields:

* Patient
* Encounter
* Episode
* Diagnosis
* ICD code
* Diagnosis type
* Primary/secondary
* Status
* Diagnosed by
* Date

Architecture should support ICD terminology without hardcoding the entire terminology into application logic.

⸻

25. CLINICAL NOTES

Support:

* Consultation note
* Progress note
* Nursing note
* Procedure note
* Follow-up note

Clinical records should support:

Draft
→ Finalized

Finalized clinical documentation should not be silently overwritten.

Corrections should create amendments/version history.

⸻

26. CPOE — COMPUTERIZED PROVIDER ORDER ENTRY

Create a generic Clinical Order framework.

Order types:

* Laboratory
* Medication
* Imaging
* Procedure
* Referral
* Other

Common fields:

* Order number
* Patient
* Encounter
* Ordering provider
* Type
* Priority
* Instructions
* Status
* Date

Statuses:

Draft
Ordered
Acknowledged
In Progress
Completed
Cancelled

This should become the bridge between the EMR and clinical support systems.

⸻

27. PRESCRIPTION MANAGEMENT

Create structured prescriptions.

Prescription:

* Patient
* Encounter
* Provider
* Date

Prescription items:

* Medication
* Generic name
* Strength
* Dose
* Frequency
* Route
* Duration
* Quantity
* Instructions

Generate printable prescriptions.

Keep prescription history.

⸻

28. LABORATORY INFORMATION SYSTEM — LIS

Architect and implement an initial LIS.

Create:

* Lab Test Master
* Test Categories
* Panels
* Lab Orders
* Specimens
* Sample Collection
* Result Entry
* Result Verification
* Result Reporting

Workflow:

Doctor Order
→ Lab Queue
→ Sample Collection
→ Processing
→ Result Entry
→ Verification
→ Final Result
→ Patient EMR

Track:

* Specimen number
* Collection time
* Collected by
* Test
* Result
* Units
* Reference range
* Abnormal flag
* Verified by
* Verification time

Do not build a simplistic text-only result system.

Allow structured numeric/text results.

⸻

29. PHARMACY INFORMATION SYSTEM — PIS

Design pharmacy as a connected but separate clinical support domain.

Functions:

* Medication Master
* Prescription Queue
* Dispensing
* Pharmacy Stock
* Batch
* Expiry
* Returns
* Dispensing history

Workflow:

Doctor Prescription
→ Pharmacy Queue
→ Verification
→ Dispensing
→ Inventory Reduction
→ Billing
→ Patient Medication History

Architecture must allow pharmacy to be disabled for clinics that do not operate one.

⸻

30. RADIOLOGY INFORMATION SYSTEM — RIS

Create architecture for:

* Imaging Service Master
* Imaging Orders
* Scheduling
* Procedure status
* Radiology report
* Result verification
* Attachments

Workflow:

Doctor
→ Imaging Order
→ RIS Queue
→ Scheduling
→ Imaging Performed
→ Radiologist Report
→ Final Result
→ Patient EMR

Prepare integration architecture for future PACS.

Do not attempt to build a PACS from scratch.

⸻

31. PROCEDURE MANAGEMENT

Procedures should connect:

Encounter
→ Service
→ Provider
→ Room
→ Inventory
→ Billing

Track:

* Procedure
* Date
* Provider
* Assistants
* Room
* Notes
* Outcome
* Inventory consumed
* Billable amount

⸻

32. TREATMENT PACKAGES

Create Package Master.

Examples:

Physiotherapy — 10 Sessions

Skin Treatment — 6 Sessions

Fields:

* Package
* Services
* Sessions
* Price
* Discount
* Validity

Patient Package:

* Patient
* Purchase
* Start
* Expiry
* Purchased sessions
* Used sessions
* Remaining sessions
* Payment status

Every session consumption requires history.

⸻

33. BILLING ENGINE

Do not build billing logic directly inside the POS UI.

Create a centralized billing engine.

Billable sources:

* Consultation
* Procedure
* Lab
* Imaging
* Pharmacy
* Product
* Package
* Other service

Create Charge entity if appropriate.

Flow:

Clinical/Operational Event
→ Charge
→ Invoice
→ Payment

This separation will make insurance and advanced revenue-cycle workflows possible later.

⸻

34. POS

Create fast cashier interface.

Allow:

* Patient search
* Pending charges
* Service
* Product
* Package

Invoice:

* Invoice number
* Patient
* Branch
* Provider
* Items
* Quantity
* Unit price
* Discount
* Tax
* Total
* Paid
* Outstanding

⸻

35. PAYMENTS

Support:

* Cash
* Card
* Bank
* Online
* Insurance
* Credit
* Other

Support split payments.

Example:

Invoice AED 1,000

Cash AED 200

Card AED 500

Insurance AED 300

Maintain separate payment/allocation records.

⸻

36. REFUNDS

Never delete original transactions.

Refund workflow:

Request
→ Authorization
→ Refund/Credit Note
→ Payment Reversal where appropriate
→ Accounting Adjustment

Track reason and authorization.

⸻

37. CASHIER MANAGEMENT

Create cashier sessions.

Open Register
→ Transactions
→ Cash Movements
→ Close Register

Track:

Opening Cash

Expected Cash

Actual Cash

Variance

⸻

38. PAYOR MANAGEMENT

Design a proper Payor domain.

Payor types:

* Self Pay
* Insurance Company
* Corporate
* Government
* Other

Create:

* Payor
* Insurance Plan
* Policy
* Patient Coverage
* Coverage Dates
* Benefits
* Copay
* Deductible architecture

Self-pay patients should work without insurance configuration.

⸻

39. INSURANCE & CLAIMS ARCHITECTURE

Create architecture for:

Eligibility
→ Authorization
→ Treatment
→ Claim
→ Submission
→ Adjudication
→ Remittance
→ Rejection
→ Resubmission

Claim:

* Claim number
* Patient
* Payor
* Policy
* Encounter
* Invoice
* Claim items
* Diagnosis
* Procedures
* Submitted amount
* Approved amount
* Rejected amount
* Patient responsibility
* Status

Do not hardcode one country’s insurance format.

Create adapters for future country-specific integrations.

⸻

40. REVENUE CYCLE MANAGEMENT

Create a unified revenue cycle architecture:

Patient Registration
→ Eligibility
→ Appointment
→ Encounter
→ Charge Capture
→ Coding
→ Invoice
→ Claim
→ Payment
→ Reconciliation
→ Receivable Follow-Up

Self-pay should use a shorter path.

⸻

41. INVENTORY MANAGEMENT

Product Master:

* SKU
* Barcode
* Product
* Category
* Brand
* Unit
* Purchase cost
* Selling price
* Tax
* Reorder level
* Minimum stock
* Maximum stock

Support branch/location inventory.

⸻

42. BATCH & EXPIRY

Healthcare stock must support:

* Batch
* Manufacturing date
* Expiry
* Supplier
* Purchase cost
* Quantity

Use FEFO where appropriate.

Alerts:

* Low stock
* Out of stock
* Near expiry
* Expired

⸻

43. STOCK LEDGER

Never directly manipulate inventory without a ledger.

Transactions:

* Purchase
* Sale
* Dispensing
* Treatment consumption
* Adjustment
* Transfer
* Damage
* Expiry
* Return

Every transaction should record:

* Product
* Batch
* Location
* Quantity in/out
* Reference
* User
* Timestamp

⸻

44. AUTOMATIC CLINICAL CONSUMPTION

Allow service templates.

Example:

Wound Dressing

Consumes:

* Gauze × 2
* Gloves × 1
* Antiseptic 5 ml

Completing the procedure should generate stock consumption.

⸻

45. SUPPLIERS

Supplier Master:

* Supplier ID
* Company
* Contact
* Phone
* Email
* Address
* Tax number
* Payment terms
* Bank details
* Status

⸻

46. PROCUREMENT

Workflow:

Purchase Request
→ Approval
→ Purchase Order
→ Goods Receipt
→ Supplier Invoice
→ Payment

Support partial receiving.

Goods receipt should create inventory movements.

Supplier invoice should create accounts payable.

⸻

47. ASSET MANAGEMENT

Track:

* Asset ID
* QR/barcode
* Asset
* Category
* Manufacturer
* Model
* Serial
* Branch
* Department
* Room
* Assigned employee
* Supplier
* Purchase
* Cost
* Warranty
* Status

Statuses:

Available
In Use
Maintenance
Damaged
Lost
Retired
Disposed

⸻

48. MAINTENANCE & CALIBRATION

Track:

* Preventive maintenance
* Corrective maintenance
* Service provider
* Cost
* Work performed
* Next service

Medical equipment:

* Calibration date
* Certificate
* Result
* Provider
* Next calibration

Generate alerts.

⸻

49. HR MANAGEMENT

Employee Master:

* Employee number
* Personal details
* Department
* Designation
* Branch
* Manager
* Joining date
* Employment type
* Salary structure
* Bank details
* Status

Documents:

* ID
* Passport
* Visa
* Contract
* Professional license
* Certification

Track expiry.

⸻

50. ATTENDANCE

Track:

* Shift
* Check-in
* Check-out
* Break
* Working hours
* Late
* Early departure
* Overtime
* Attendance status

Maintain adjustment audit trail.

⸻

51. LEAVE

Workflow:

Employee
→ Request
→ Manager Approval
→ HR

Types:

* Annual
* Sick
* Unpaid
* Emergency
* Other

Track balances.

Doctor leave must affect scheduling.

⸻

52. PAYROLL

Payroll:

Basic Salary

* Allowances
* Overtime
* Commission
* Bonus

* Deductions
* Advances
* Unpaid Leave
    = Net Salary

Workflow:

Draft
→ Review
→ Approved
→ Paid

Generate payslips.

⸻

53. PROVIDER COMMISSIONS

Support:

* Fixed
* Percentage
* Service-specific
* Product-specific
* Tiered

Commission basis:

* Gross invoice
* Net invoice
* Collected revenue

Generate provider statements.

⸻

54. FINANCE & ACCOUNTING

Build double-entry accounting.

Create:

* Chart of Accounts
* Journal
* General Ledger
* Cash
* Bank
* Petty Cash
* AR
* AP
* Expenses
* Tax
* Trial Balance
* P&L
* Balance Sheet
* Cash Flow

All journals:

Total Debit = Total Credit

⸻

55. CENTRAL ACCOUNTING ENGINE

Operational modules should NOT independently invent journal logic.

Create a central accounting posting service.

Examples:

Cash Patient Payment:

Debit Cash
Credit Accounts Receivable

Credit Sale:

Debit Accounts Receivable
Credit Revenue
Credit Tax Payable

Inventory Purchase:

Debit Inventory
Credit Accounts Payable

Payroll:

Debit Salary Expense
Credit Payroll Payable

Use configurable account mappings.

⸻

56. PATIENT ENGAGEMENT

Create communication architecture for:

* SMS
* WhatsApp
* Email

Use provider adapters.

Templates:

* Appointment confirmation
* Reminder
* Cancellation
* Follow-up
* Payment reminder
* Package expiry
* Lab result ready
* Birthday

Maintain communication history.

Do not fake successful external API delivery.

⸻

57. PATIENT PORTAL ARCHITECTURE

Prepare a patient-facing portal.

Patients should eventually be able to:

* Login
* View profile
* Book appointment
* Reschedule/cancel within policy
* View appointments
* View prescriptions
* View approved results
* View invoices
* View payments
* View packages
* Download documents
* Update selected demographic information

Clinical information must only become patient-visible according to configurable release rules.

⸻

58. ONLINE BOOKING

Create architecture for public booking:

Select Branch
→ Specialty
→ Provider
→ Service
→ Date
→ Available Slot
→ Patient Details
→ Confirmation

Prevent slot race conditions.

⸻

59. LEAD CRM

Create marketing lead management.

Pipeline:

New
→ Contacted
→ Interested
→ Appointment
→ Visited
→ Converted

or

Lost

Track:

* Source
* Campaign
* Service interest
* Assigned employee
* Follow-up
* Notes

When converted, link lead to patient.

⸻

60. DOCUMENT MANAGEMENT

Securely store:

Patient:

* ID
* Consent
* Lab
* Imaging
* Medical report
* Referral
* Insurance

Employee:

* Passport
* Visa
* Contract
* License
* Certificate

Asset:

* Warranty
* Maintenance
* Calibration

Supplier:

* Invoice
* Contract

Track metadata and permissions.

⸻

61. CONSENT MANAGEMENT

Create architecture for:

* General treatment consent
* Procedure consent
* Data/privacy consent
* Marketing consent
* Communication consent

Store:

* Consent type
* Version
* Patient
* Date
* Status
* Captured by
* Signature/document where applicable

Never overwrite previous consent history.

⸻

62. AUDIT TRAIL

Create immutable audit logs.

Track:

* User
* Timestamp
* Action
* Entity
* Entity ID
* Old values
* New values
* IP where appropriate
* User agent where appropriate

Audit:

* Patient changes
* Clinical records
* Orders
* Results
* Prescriptions
* Invoices
* Refunds
* Inventory adjustments
* Accounting
* Payroll
* Permission changes

⸻

63. CLINICAL RECORD ACCESS LOG

In addition to modification audit logs, architect tracking for sensitive patient-record access.

Track:

* User
* Patient
* Record/resource
* Timestamp
* Action

Example:

Doctor A viewed Patient X’s clinical history.

Access logs should themselves be restricted.

⸻

64. NOTIFICATION ENGINE

Create internal notifications.

Examples:

* Patient waiting
* Critical/abnormal result
* Lab result pending verification
* Appointment upcoming
* Follow-up due
* Stock low
* Product expiring
* Asset maintenance due
* Calibration due
* License expiring
* Receivable overdue
* Payable due

Support:

Unread
Read
Archived

⸻

65. REPORTS & ANALYTICS

Build reports for:

Practice

* Appointments
* No-shows
* Waiting times
* Provider utilization
* Room utilization
* Patient visits

Clinical

* Encounters
* Diagnosis trends
* Procedures
* Orders
* Follow-ups

Financial

* Revenue
* Collections
* AR
* AP
* Expenses
* P&L
* Balance Sheet
* Cash Flow

Revenue Cycle

* Charges
* Claims
* Rejections
* Collections
* Patient responsibility

Inventory

* Stock
* Valuation
* Consumption
* Expiry
* Fast/slow moving

HR

* Attendance
* Leave
* Payroll
* Commission

Assets

* Register
* Maintenance
* Calibration
* Costs

Allow date, branch, provider and other appropriate filters.

⸻

66. GLOBAL SEARCH

Search:

* Patient
* MRN
* Phone
* ID
* Appointment
* Encounter
* Invoice
* Claim
* Product
* Employee
* Provider
* Supplier
* Asset

Search results must obey permissions.

⸻

67. ADMINISTRATION

Create configuration screens for:

* Organization
* Branches
* Departments
* Rooms
* Providers
* Services
* Users
* Roles
* Permissions
* Payment methods
* Tax
* Number sequences
* Clinical settings
* Appointment settings
* Inventory settings
* Accounting settings
* Notification templates

Avoid hardcoding business configuration.

⸻

68. NUMBER SEQUENCES

Use concurrency-safe sequences.

Examples:

MRN-000001
APT-000001
EPS-000001
ENC-000001
ORD-000001
RX-000001
LAB-000001
INV-000001
PAY-000001
CLM-000001
PO-000001
EMP-000001
AST-000001

Never use count + 1.

⸻

69. TECHNOLOGY STACK

Unless there is a strong technical reason otherwise, use:

Frontend:

* Next.js
* React
* TypeScript
* Tailwind CSS
* shadcn/ui
* Lucide Icons

Backend:

* TypeScript
* Next.js server architecture/API architecture where suitable

Database:

* PostgreSQL

ORM:

* Prisma

Use mature libraries for:

* Validation
* Calendar
* Charts
* PDF
* CSV/Excel
* File uploads
* Dates

Before choosing versions, verify current compatibility.

⸻

70. DATABASE REQUIREMENTS

Use normalized relational design.

Use:

* UUID/internal IDs
* Foreign keys
* Unique constraints
* Indexes
* Decimal for money
* Correct date/time types
* Transactions
* Soft deletion only where appropriate

Do NOT soft-delete everything blindly.

Certain financial/clinical records require immutable historical behavior instead.

⸻

71. DOMAIN-DRIVEN PROJECT STRUCTURE

Do NOT organize the entire backend as one giant services folder.

Prefer domains such as:

/patients
/providers
/appointments
/episodes
/encounters
/clinical
/orders
/laboratory
/pharmacy
/radiology
/billing
/payors
/claims
/inventory
/procurement
/assets
/hr
/payroll
/accounting
/communications
/reports
/admin

Each domain should have clear boundaries.

⸻

72. TRANSACTIONAL INTEGRITY

Use database transactions for multi-module operations.

Example:

Completing pharmacy dispensing may involve:

Dispensing Record

* Inventory Movement
* Charge
* Patient Medication History

These operations must either succeed together or fail safely.

Likewise:

POS Payment

* Payment Allocation
* Accounting Journal

must remain consistent.

⸻

73. EVENT-DRIVEN DOMAIN INTEGRATION

Where appropriate, create internal domain events.

Examples:

AppointmentCheckedIn

EncounterCompleted

LabResultFinalized

ProcedureCompleted

InvoiceIssued

PaymentReceived

InventoryLow

EmployeeLeaveApproved

Use events to reduce tight coupling between modules.

Do not introduce unnecessary distributed infrastructure.

A modular monolith with reliable internal domain events is preferred initially.

⸻

74. ARCHITECTURAL STYLE

Start as a:

Modular Monolith

NOT microservices.

Reasons:

* Easier development
* Easier transactions
* Easier deployment
* Easier debugging
* Lower infrastructure complexity

Maintain strong domain boundaries so modules can later be extracted if required.

⸻

75. SECURITY

Implement:

* Secure authentication
* RBAC
* Server-side authorization
* Input validation
* Secure cookies
* Rate limiting where appropriate
* File validation
* XSS protection
* CSRF protection where applicable
* SQL injection protection
* Secure environment variables
* Audit logs
* Access logs
* Session management
* Password policies

Never expose secrets.

⸻

76. HEALTHCARE DATA PRIVACY

Apply privacy-by-design principles.

Separate access to:

* Demographic
* Clinical
* Financial
* HR
* Administrative

Reception should not automatically see sensitive clinical notes.

Doctors should not automatically see employee payroll.

HR should not automatically see clinical records.

Use least privilege.

⸻

77. COMPLIANCE ARCHITECTURE

Prepare architecture that can later support requirements related to:

* HIPAA
* GDPR
* UAE healthcare regulations
* DHA
* DOH
* MOHAP
* Saudi healthcare regulations
* CBAHI
* ZATCA
* Other jurisdictions

Do NOT claim the application is legally compliant merely because technical controls exist.

Compliance requires legal, operational, hosting and security review.

⸻

78. UI DESIGN DIRECTION

Create an original premium healthcare SaaS interface.

Characteristics:

* Professional
* Minimal
* Modern
* High information density without clutter
* Fast
* Accessible
* Responsive
* Consistent

Do NOT visually clone Nixpend.

Use it only as conceptual inspiration for the breadth and integration expected of an HIS.

⸻

79. PRIMARY NAVIGATION

Organize sidebar into logical groups.

Home

Dashboard

Practice

Patients
Appointments
Queue
Providers
Services
Packages

Clinical

Episodes
Encounters
Orders
Laboratory
Pharmacy
Radiology

Revenue

POS
Invoices
Payments
Payors
Claims

Resources

Inventory
Purchasing
Suppliers
Assets

Workforce

Employees
Attendance
Leave
Payroll
Commissions

Finance

Accounting
Expenses
Receivables
Payables

Engagement

Leads
Communications

Intelligence

Reports
Analytics

Administration

Users
Roles
Audit
Settings

Use permissions to hide inaccessible modules.

⸻

80. UI TABLES

Major tables should support where appropriate:

* Search
* Pagination
* Sorting
* Filters
* Status
* Date range
* Branch
* Export
* Column configuration

Use server-side pagination for large datasets.

⸻

81. FORMS

Implement:

* Validation
* Required indicators
* Helpful errors
* Searchable selects
* Loading states
* Confirmation
* Success feedback
* Duplicate-submit protection

⸻

82. PRINTING

Create professional printable:

* Patient summary
* Prescription
* Lab report
* Radiology report
* Invoice
* Receipt
* Claim
* Purchase order
* Goods receipt
* Payslip
* Commission statement
* Financial statement

Use configurable clinic branding.

⸻

83. IMPORT / EXPORT

Support controlled imports for:

* Patients
* Employees
* Products
* Suppliers
* Services
* Opening stock

Workflow:

Upload
→ Validate
→ Preview
→ Error Report
→ Confirm

⸻

84. TESTING

Create unit and integration tests.

Critical areas:

* Authentication
* Authorization
* Patient duplication
* Appointment conflicts
* Encounter finalization
* Clinical amendments
* Orders
* Lab result verification
* Invoice calculations
* Split payment
* Refunds
* Insurance allocations
* Stock movement
* Package usage
* Payroll
* Commission
* Journal balancing

⸻

85. CORE END-TO-END TEST

Test:

Reception registers Patient
→ Books Appointment
→ Patient Arrives
→ Check-In
→ Queue
→ Nurse Records Vitals
→ Doctor Opens Encounter
→ Diagnosis
→ Prescription
→ Lab Order
→ Procedure Order
→ Consultation Completed
→ Charges Generated
→ Lab Processes Order
→ Result Finalized
→ Result Appears in EMR
→ Procedure Completed
→ Inventory Consumed
→ POS Receives Charges
→ Invoice Generated
→ Split Payment Received
→ Accounting Posted
→ Doctor Commission Generated
→ Patient Timeline Updated
→ Follow-Up Scheduled

All data must be persisted.

⸻

86. PROCUREMENT END-TO-END TEST

Purchase Request
→ Approval
→ PO
→ Goods Receipt
→ Stock Ledger
→ Supplier Invoice
→ AP
→ Payment
→ Accounting

⸻

87. HR END-TO-END TEST

Employee
→ Schedule
→ Attendance
→ Leave
→ Payroll
→ Payslip
→ Payment
→ Accounting

⸻

88. DEVELOPMENT STRATEGY

DO NOT build every advanced module simultaneously.

Build a strong core first.

⸻

PHASE 0 — ARCHITECTURE

Before writing application code create:

1. Product architecture
2. Domain map
3. Entity relationship model
4. Patient journey
5. Clinical workflow
6. Revenue workflow
7. Accounting workflow
8. Inventory workflow
9. RBAC matrix
10. Route map
11. API architecture
12. Database strategy
13. Security architecture
14. Folder structure
15. Implementation roadmap

STOP and critically review architecture before implementation.

⸻

PHASE 1 — PLATFORM FOUNDATION

Build:

* Project
* Database
* Authentication
* Organization
* Branch
* Department
* Rooms
* Users
* Roles
* Permissions
* Audit framework
* Number sequences
* Layout
* Navigation
* Settings

⸻

PHASE 2 — PATIENT & PRACTICE

Build:

* Patient
* Patient 360
* Provider
* Services
* Scheduling
* Appointments
* Reception
* Queue

⸻

PHASE 3 — CORE EMR

Build:

* Episodes
* Encounters
* Vitals
* Allergies
* Problems
* Diagnosis
* Clinical notes
* Prescription
* Orders
* Follow-up

⸻

PHASE 4 — REVENUE

Build:

* Charges
* POS
* Invoice
* Payment
* Split payment
* Refund
* Cashier

At this point we should have a commercially usable clinic core.

⸻

PHASE 5 — INVENTORY & PROCUREMENT

Build:

* Product
* Batch
* Stock
* Ledger
* Suppliers
* Purchasing
* Receiving
* Transfers
* Consumption

⸻

PHASE 6 — FINANCE

Build:

* Chart of Accounts
* Journals
* Ledger
* AR
* AP
* Expenses
* Tax
* Financial statements

Integrate operational modules.

⸻

PHASE 7 — HR & ASSETS

Build:

* Employees
* Attendance
* Leave
* Payroll
* Commission
* Assets
* Maintenance
* Calibration

⸻

PHASE 8 — LIS

Implement Laboratory.

⸻

PHASE 9 — PHARMACY

Implement Pharmacy.

⸻

PHASE 10 — RIS

Implement Radiology workflow and PACS-ready integration interface.

⸻

PHASE 11 — PAYORS & INSURANCE

Implement:

* Payors
* Plans
* Coverage
* Eligibility architecture
* Authorization
* Claims
* Remittance

⸻

PHASE 12 — PATIENT ENGAGEMENT

Implement:

* Communication engine
* SMS adapter
* WhatsApp adapter
* Email adapter
* Patient portal
* Online booking

⸻

PHASE 13 — ANALYTICS

Implement:

* Dashboards
* Reports
* KPIs
* Exports

⸻

PHASE 14 — HARDENING

Perform:

* Security audit
* Authorization audit
* Database review
* Performance optimization
* Indexing
* Accessibility
* Responsive testing
* Integration tests
* Error handling
* Backup documentation
* Deployment documentation

⸻

89. DEVELOPMENT SESSION MANAGEMENT

Create:

PROJECT_STATUS.md

Maintain:

Current Phase

Completed

In Progress

Pending

Known Issues

Database Changes

Architecture Decisions

Tests

Next Actions

Update after every meaningful development session.

Also create:

ARCHITECTURE.md

DATABASE.md

SECURITY.md

API.md

DEPLOYMENT.md

⸻

90. ARCHITECTURE DECISION RECORDS

For important decisions create ADRs.

Examples:

Why modular monolith?

Why Episode separate from Encounter?

Why Charge separate from Invoice?

Why immutable stock ledger?

Why centralized accounting engine?

Why clinical note amendments instead of edits?

Document important decisions rather than allowing architecture to become accidental.

⸻

91. DEFINITION OF DONE

A module is NOT done because a screen exists.

It is done when:

* Database works
* API/server action works
* UI works
* Validation works
* Permissions work
* Business rules work
* Audit works
* Integrations work
* Errors are handled
* Tests pass
* Data persists
* Responsive design works
* No critical placeholders remain

⸻

92. NEVER DO THE FOLLOWING

Never:

* Put the whole application in one file.
* Build disconnected modules.
* Fake API integrations.
* Fake dashboard statistics.
* Use floating point for money.
* Trust frontend totals.
* Allow unauthorized clinical access.
* Overwrite finalized clinical records.
* Delete financial transactions to reverse them.
* Change stock without ledger transactions.
* Create unbalanced journals.
* Store plain-text passwords.
* Commit secrets.
* Hardcode business rules that belong in configuration.
* Claim regulatory compliance without verification.
* Copy Nixpend proprietary assets, source code, or protected interface designs.

⸻

93. CRITICAL ARCHITECTURAL REQUIREMENT

Whenever you implement a feature, ask:

What other domains should this event affect?

Example:

ProcedureCompleted

May trigger:

* Encounter update
* Charge generation
* Inventory consumption
* Provider commission
* Patient timeline
* Analytics

Example:

PaymentReceived

May trigger:

* Invoice balance
* AR allocation
* Accounting journal
* Cashier session
* Patient statement
* Analytics

Do not require users to manually re-enter the same information into multiple modules.

⸻

94. BUILD PRIORITY

Our first commercial milestone is:

Patient Registration
+
Provider Management
+
Appointments
+
Reception / Queue
+
EMR
+
Prescription
+
POS
+
Payments
+
Inventory
+
Basic Finance
+
HR
+
Assets
+
Reports

Prioritize making these extremely reliable before adding advanced hospital-level functionality.

⸻

95. FINAL PRODUCT TARGET

The final product should feel like one unified system rather than separate applications.

A staff member should be able to follow:

Patient → Episode → Encounter → Clinical Activity → Order → Charge → Invoice → Payment

Management should be able to follow:

Patient Activity → Provider Productivity → Revenue → Cost → Profitability

Inventory should follow:

Purchase → Stock → Consumption/Sale → Reorder

Finance should follow:

Operational Transaction → Accounting Journal → Ledger → Financial Statements

HR should follow:

Employee → Attendance → Leave → Payroll → Accounting

This interconnected architecture is the central requirement.

⸻

96. YOUR FIRST RESPONSE

Do NOT start coding immediately.

First give me a comprehensive:

PART A — SYSTEM BLUEPRINT

1. Executive architecture summary
2. Domain architecture
3. Module hierarchy
4. Patient journey
5. Episode/Encounter model
6. Clinical order architecture
7. Billing architecture
8. Revenue cycle architecture
9. Inventory architecture
10. Accounting architecture
11. HR architecture
12. Patient engagement architecture

PART B — DATABASE BLUEPRINT

13. Complete high-level ERD
14. Core entities
15. Entity relationships
16. Important database constraints
17. Indexing strategy
18. Transaction boundaries
19. Audit architecture

PART C — APPLICATION BLUEPRINT

20. Sidebar/navigation
21. Page hierarchy
22. User roles
23. Complete permission matrix
24. Dashboard design
25. Major workflow screens
26. API/server architecture
27. Domain event architecture

PART D — TECHNICAL BLUEPRINT

28. Final technology stack
29. Project folder structure
30. Authentication architecture
31. Security architecture
32. File storage architecture
33. Reporting architecture
34. Deployment architecture
35. Backup strategy
36. Testing strategy

PART E — IMPLEMENTATION

37. Development roadmap
38. Dependencies between phases
39. MVP definition
40. Version 1 definition
41. Future modules
42. Major risks
43. Architecture decisions that must be finalized before coding

After completing this blueprint, critically review it for:

* Missing healthcare workflows
* Data integrity problems
* Security risks
* Financial/accounting weaknesses
* Scalability issues
* Excessive complexity

Then present your recommended corrections.

Only after the architecture is coherent should you begin:

PHASE 1 — PLATFORM FOUNDATION

Build the actual application files.

Do not merely tell me what code I should write.

You are responsible for implementing it.

After completing Phase 1:

* Run type checking
* Run linting
* Run tests
* Verify migrations
* Verify permissions
* Verify authentication
* Fix errors
* Update PROJECT_STATUS.md

Then proceed systematically to Phase 2.

The ultimate objective is to build a commercial-grade integrated Healthcare Information System for outpatient clinics and polyclinics, with a strong Practice Management + EMR + ERP core and architecture capable of expanding into Laboratory, Pharmacy, Radiology, Insurance, Patient Portal and other healthcare services.