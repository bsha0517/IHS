import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DispenseItemDialog } from "@/app/(dashboard)/pharmacy/[id]/dispense-item-dialog"

/**
 * P4.7A.1 §46 — component regression coverage for Pharmacy's own
 * prescribed-vs-dispensed mismatch safeguard (the one safety-critical
 * confirmation flow this batch's own §20 explicitly forbade weakening).
 * Renders the real dialog, not a reimplementation of `looksLikeSameMedication`
 * — the assertions are about what the *component* does when a mismatch is
 * selected: the warning renders, the checkbox starts unchecked, Dispense
 * stays disabled until it's checked, and re-selecting a medication resets
 * that confirmation (so a pharmacist can't carry a stale "confirmed" state
 * from one medication onto a different one picked afterward).
 */

const createDispensingRecordAction = vi.fn()
vi.mock("@/app/(dashboard)/pharmacy/actions", () => ({
  createDispensingRecordAction: (...args: unknown[]) => createDispensingRecordAction(...args),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}))

const medications = [
  { id: "med-paracetamol", name: "Paracetamol", label: "Paracetamol 500mg", balance: 20 },
  { id: "med-ibuprofen", name: "Ibuprofen", label: "Ibuprofen 400mg", balance: 15 },
  { id: "med-cetirizine", name: "Cetirizine", label: "Cetirizine 10mg", balance: 8 },
  { id: "med-out-of-stock", name: "Amoxicillin", label: "Amoxicillin 250mg", balance: 0 },
]

const prescribed = { medicationName: "Paracetamol", strength: "500mg", dose: "1 tablet", route: "oral", frequency: "Twice daily" }

describe("DispenseItemDialog — prescribed/dispensed mismatch safeguard", () => {
  beforeEach(() => {
    createDispensingRecordAction.mockReset()
  })

  it("shows no warning and allows dispensing when the selected medication matches what was prescribed", async () => {
    const user = userEvent.setup()
    render(<DispenseItemDialog prescriptionId="rx-1" prescriptionItemId="item-1" medications={medications} prescribed={prescribed} />)

    await user.click(screen.getByRole("button", { name: /dispense/i }))
    await user.click(screen.getByRole("combobox", { name: /medication to dispense/i }))
    await user.click(await screen.findByRole("option", { name: /Paracetamol 500mg/ }))

    expect(screen.queryByText(/substitution warning/i)).not.toBeInTheDocument()
    const submit = screen.getByRole("button", { name: /create dispensing record/i })
    expect(submit).not.toBeDisabled()
  })

  it("blocks submission on a mismatched medication until the substitution is explicitly confirmed, and never auto-substitutes", async () => {
    const user = userEvent.setup()
    render(<DispenseItemDialog prescriptionId="rx-1" prescriptionItemId="item-1" medications={medications} prescribed={prescribed} />)

    await user.click(screen.getByRole("button", { name: /dispense/i }))
    await user.click(screen.getByRole("combobox", { name: /medication to dispense/i }))
    await user.click(await screen.findByRole("option", { name: /Ibuprofen 400mg/ }))

    // The warning must be prominent (§20): an explicit heading, both drug
    // names named, and it must not have silently swapped the selection.
    expect(await screen.findByText(/substitution warning/i)).toBeInTheDocument()
    expect(screen.getByText(/"Ibuprofen"/)).toBeInTheDocument()
    expect(screen.getByText(/"Paracetamol"/)).toBeInTheDocument()

    const submit = screen.getByRole("button", { name: /create dispensing record/i })
    expect(submit).toBeDisabled()

    const confirmCheckbox = screen.getByRole("checkbox", { name: /confirm this substitution is intentional/i })
    expect(confirmCheckbox).not.toBeChecked()
    await user.click(confirmCheckbox)
    expect(submit).not.toBeDisabled()
  })

  it("resets a prior substitution confirmation when a different medication is re-selected", async () => {
    const user = userEvent.setup()
    render(<DispenseItemDialog prescriptionId="rx-1" prescriptionItemId="item-1" medications={medications} prescribed={prescribed} />)

    await user.click(screen.getByRole("button", { name: /dispense/i }))
    await user.click(screen.getByRole("combobox", { name: /medication to dispense/i }))
    await user.click(await screen.findByRole("option", { name: /Ibuprofen 400mg/ }))
    await user.click(screen.getByRole("checkbox", { name: /confirm this substitution is intentional/i }))
    expect(screen.getByRole("button", { name: /create dispensing record/i })).not.toBeDisabled()

    // Re-selecting a (still mismatched) medication must require a fresh
    // confirmation — a stale "confirmed" flag can never carry over.
    await user.click(screen.getByRole("combobox", { name: /medication to dispense/i }))
    await user.click(await screen.findByRole("option", { name: /Cetirizine 10mg/ }))
    expect(await screen.findByText(/"Cetirizine"/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /create dispensing record/i })).toBeDisabled()
  })

  it("never presents expired/out-of-stock medications as selectable", async () => {
    const user = userEvent.setup()
    render(<DispenseItemDialog prescriptionId="rx-1" prescriptionItemId="item-1" medications={medications} prescribed={prescribed} />)

    await user.click(screen.getByRole("button", { name: /dispense/i }))
    await user.click(screen.getByRole("combobox", { name: /medication to dispense/i }))
    const outOfStockOption = await screen.findByRole("option", { name: /Amoxicillin 250mg — out of stock/ })
    expect(outOfStockOption).toHaveAttribute("aria-disabled", "true")
  })
})
