import { z } from "zod"

export const branchSchema = z.object({
  name: z.string().min(1, "Name is required").max(200),
  code: z.string().min(1, "Code is required").max(20),
  timezone: z.string().min(1, "Timezone is required"),
  address: z.string().max(500).optional().nullable(),
  phone: z.string().max(50).optional().nullable(),
})
export type BranchInput = z.infer<typeof branchSchema>

export const departmentSchema = z.object({
  branchId: z.uuid(),
  name: z.string().min(1).max(200),
  code: z.string().min(1).max(20),
})
export type DepartmentInput = z.infer<typeof departmentSchema>

export const roomSchema = z.object({
  departmentId: z.uuid(),
  name: z.string().min(1).max(200),
  code: z.string().min(1).max(20),
  roomType: z.string().min(1).max(50),
})
export type RoomInput = z.infer<typeof roomSchema>

export const organizationSchema = z.object({
  legalName: z.string().min(1).max(300),
  displayName: z.string().min(1).max(200),
  defaultCurrency: z.string().length(3),
  defaultTimezone: z.string().min(1),
})
export type OrganizationInput = z.infer<typeof organizationSchema>

export const createUserSchema = z.object({
  email: z.email(),
  username: z.string().max(100).optional().nullable(),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  password: z.string().min(10, "Password must be at least 10 characters"),
  roleIds: z.array(z.uuid()).default([]),
  branchIds: z.array(z.uuid()).default([]),
})
export type CreateUserInput = z.infer<typeof createUserSchema>

export const updateUserSchema = z.object({
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().min(1).max(100).optional(),
  status: z.enum(["active", "inactive", "locked"]).optional(),
  roleIds: z.array(z.uuid()).optional(),
  branchIds: z.array(z.uuid()).optional(),
})
export type UpdateUserInput = z.infer<typeof updateUserSchema>

export const roleSchema = z.object({
  name: z.string().min(1).max(100),
  permissionIds: z.array(z.uuid()).default([]),
})
export type RoleInput = z.infer<typeof roleSchema>
