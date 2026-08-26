import { describe, it, expect } from "vitest"
import { translateBookingError, BookingConflictError } from "@/lib/domains/appointments/service"

describe("translateBookingError", () => {
  it("translates a provider double-booking exclusion violation into a readable message", () => {
    const dbError = new Error('duplicate key value violates exclusion constraint "appointment_provider_no_overlap"')
    expect(() => translateBookingError(dbError)).toThrow(BookingConflictError)
    expect(() => translateBookingError(dbError)).toThrow("This provider already has an appointment that overlaps this time.")
  })

  it("translates a room double-booking exclusion violation into a readable message", () => {
    const dbError = new Error('duplicate key value violates exclusion constraint "appointment_room_no_overlap"')
    expect(() => translateBookingError(dbError)).toThrow("This room is already booked for an overlapping time.")
  })

  it("never leaks the raw DB error message to the caller for a known constraint violation", () => {
    const dbError = new Error('duplicate key value violates exclusion constraint "appointment_provider_no_overlap"')
    try {
      translateBookingError(dbError)
    } catch (err) {
      expect((err as Error).message).not.toContain("duplicate key value violates exclusion constraint")
    }
  })

  it("re-throws an unrelated error unchanged rather than misclassifying it", () => {
    const other = new Error("connection reset")
    expect(() => translateBookingError(other)).toThrow("connection reset")
  })

  it("handles a non-Error thrown value without crashing", () => {
    expect(() => translateBookingError("appointment_room_no_overlap")).toThrow(BookingConflictError)
  })
})
