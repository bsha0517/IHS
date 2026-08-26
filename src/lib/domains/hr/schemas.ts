import { z } from "zod"

const emptyToNull = (v: unknown) => (v === "" ? null : v)

export const employmentTypes = ["full_time", "part_time", "contract", "intern"] as const
export const employeeStatuses = ["active", "on_leave", "terminated"] as const

export const employeeSchema = z.object({
  branchId: z.uuid(),
  departmentId: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
  userId: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  designation: z.string().min(1).max(200),
  managerId: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
  joiningDate: z.coerce.date(),
  employmentType: z.enum(employmentTypes),
  basicSalary: z.coerce.number().min(0).max(9999999).default(0),
  bankDetails: z.preprocess(emptyToNull, z.string().max(500).nullable().optional()),
})
export type EmployeeInput = z.infer<typeof employeeSchema>

export const updateEmployeeStatusSchema = z.object({
  status: z.enum(employeeStatuses),
})

export const employeeDocumentTypes = ["id_document", "passport", "visa", "contract", "professional_license", "certification"] as const

export const employeeDocumentSchema = z.object({
  documentType: z.enum(employeeDocumentTypes),
  documentNumber: z.preprocess(emptyToNull, z.string().max(100).nullable().optional()),
  issueDate: z.preprocess(emptyToNull, z.coerce.date().nullable().optional()),
  expiryDate: z.preprocess(emptyToNull, z.coerce.date().nullable().optional()),
  notes: z.preprocess(emptyToNull, z.string().max(500).nullable().optional()),
})
export type EmployeeDocumentInput = z.infer<typeof employeeDocumentSchema>

export const shiftSchema = z.object({
  name: z.string().min(1).max(100),
  startTime: z.string().regex(/^\d{2}:\d{2}$/, "Use HH:MM"),
  endTime: z.string().regex(/^\d{2}:\d{2}$/, "Use HH:MM"),
})
export type ShiftInput = z.infer<typeof shiftSchema>

export const checkInSchema = z.object({
  employeeId: z.uuid(),
  branchId: z.uuid(),
  shiftId: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
})
export type CheckInInput = z.infer<typeof checkInSchema>

export const attendanceAdjustSchema = z.object({
  checkInAt: z.preprocess(emptyToNull, z.coerce.date().nullable().optional()),
  checkOutAt: z.preprocess(emptyToNull, z.coerce.date().nullable().optional()),
  breakMinutes: z.coerce.number().int().min(0).max(1440).default(0),
  status: z.enum(["present", "absent", "half_day", "on_leave", "holiday"]),
  notes: z.preprocess(emptyToNull, z.string().max(500).nullable().optional()),
})
export type AttendanceAdjustInput = z.infer<typeof attendanceAdjustSchema>

export const leaveTypes = ["annual", "sick", "unpaid", "emergency", "other"] as const

export const leaveRequestSchema = z.object({
  employeeId: z.uuid(),
  leaveType: z.enum(leaveTypes),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  reason: z.preprocess(emptyToNull, z.string().max(500).nullable().optional()),
})
export type LeaveRequestInput = z.infer<typeof leaveRequestSchema>

export const leaveBalanceSchema = z.object({
  employeeId: z.uuid(),
  leaveType: z.enum(leaveTypes),
  year: z.coerce.number().int().min(2000).max(2100),
  allocatedDays: z.coerce.number().int().min(0).max(365),
})
export type LeaveBalanceInput = z.infer<typeof leaveBalanceSchema>
