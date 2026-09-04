import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { NoteForm } from "@/app/(dashboard)/encounters/[id]/note-form"
import type { ClinicalNote } from "@/generated/prisma/client"

/**
 * P4.7A.1 §46 — component regression coverage for the encounter workspace's
 * most clinically important visual distinction: a finalized note must read
 * as locked and read-only, never as an ordinary editable form with disabled
 * fields and no explanation (§10). This renders the real component against
 * both a draft and a finalized note and asserts what a doctor actually sees
 * in each case — not a reimplementation of the lock logic.
 */

vi.mock("@/app/(dashboard)/encounters/actions", () => ({
  saveNoteAction: vi.fn(),
  createAmendmentAction: vi.fn(),
}))

const baseNote = {
  id: "note-1",
  encounterId: "enc-1",
  noteType: "consultation",
  chiefComplaint: "Headache",
  historyOfPresentIllness: "2 days",
  reviewOfSystems: null,
  examinationFindings: null,
  assessment: null,
  treatmentPlan: null,
  authoredBy: "user-1",
  finalizedBy: null,
  finalizedAt: null,
  isCurrent: true,
  previousVersionId: null,
  createdAt: new Date("2026-09-04T01:00:00Z"),
  updatedAt: new Date("2026-09-04T01:00:00Z"),
} as unknown as ClinicalNote

describe("NoteForm — draft vs. finalized presentation", () => {
  it("renders a draft note as an editable form with a Draft status badge, no lock messaging", () => {
    render(<NoteForm encounterId="enc-1" note={{ ...baseNote, status: "draft" } as ClinicalNote} history={[]} canEdit={true} />)

    expect(screen.getByText(/^draft$/i)).toBeInTheDocument()
    expect(screen.queryByText(/finalized and read-only/i)).not.toBeInTheDocument()
    // Editable: the real Textarea for Chief Complaint, not static text.
    expect(screen.getByLabelText(/chief complaint/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /save note/i })).toBeInTheDocument()
  })

  it("renders a finalized note as a locked, read-only panel with an explicit explanation and an Amend action — never a plain disabled form", () => {
    const finalized = { ...baseNote, status: "finalized", finalizedAt: new Date("2026-09-04T01:05:00Z") } as ClinicalNote
    const finalizedVersion = { ...finalized, authoredByUser: { firstName: "Jane", lastName: "Doctor" }, finalizedByUser: { firstName: "Jane", lastName: "Doctor" } }
    render(<NoteForm encounterId="enc-1" note={finalized} history={[finalizedVersion]} canEdit={true} />)

    expect(screen.getByText(/^finalized$/i)).toBeInTheDocument()
    // The explicit "why" line §10 requires — not merely disabled-looking fields.
    expect(screen.getByText(/this note is finalized and read-only/i)).toBeInTheDocument()
    expect(screen.getByText(/the original is preserved/i)).toBeInTheDocument()
    // Content is read-only text, not an editable Textarea.
    expect(screen.queryByLabelText(/chief complaint/i)).not.toBeInTheDocument()
    expect(screen.getByText("Headache")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /save note/i })).not.toBeInTheDocument()
    // Finalization is not just "locked" — it's actionable via a clearly
    // distinct "Amend" path, never disguised as an ordinary Save.
    expect(screen.getByRole("button", { name: /amend/i })).toBeInTheDocument()
  })

  it("shows no note recorded when a finalized-ineligible session cannot edit and none exists yet", () => {
    render(<NoteForm encounterId="enc-1" note={null} history={[]} canEdit={false} />)
    expect(screen.getByText(/no note recorded/i)).toBeInTheDocument()
  })
})
