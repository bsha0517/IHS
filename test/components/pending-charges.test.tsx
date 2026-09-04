import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { PendingCharges } from "@/app/(dashboard)/pos/pending-charges"

/**
 * P4.7A.1 §46 — component regression coverage for one of POS's own
 * important state transitions (§24/§25/§26): the invoice-creation button
 * must accurately reflect the current selection — disabled and reading
 * "(0)" with nothing selected, enabled and reading the real count once a
 * charge is checked — and the running "Selected total" must move with it.
 * Renders the real component, not a reimplementation of its selection math.
 */

vi.mock("@/app/(dashboard)/pos/actions", () => ({
  generateInvoiceAction: vi.fn(),
  voidChargeAction: vi.fn(),
  createAdHocChargeAction: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}))

const charges = [
  { id: "charge-1", description: "Consultation", sourceType: "consultation", quantity: 1, unitPrice: 100, amount: 100 },
  { id: "charge-2", description: "Paracetamol", sourceType: "pharmacy", quantity: 2, unitPrice: 5, amount: 10 },
]

describe("PendingCharges — selection drives invoice-creation state", () => {
  it("starts with Create Invoice disabled at (0) and a zero selected total", () => {
    render(
      <PendingCharges
        patientId="patient-1"
        branchId="branch-1"
        charges={charges}
        services={[]}
        products={[]}
        providers={[]}
        coverages={[]}
        canVoid={true}
        canDiscount={false}
      />
    )

    const createButton = screen.getByRole("button", { name: /create invoice \(0\)/i })
    expect(createButton).toBeDisabled()
    expect(screen.getByText(/selected total/i).closest("div")).toHaveTextContent("0.00")
  })

  it("enables Create Invoice with the real count and total once a charge is selected, and reverts when deselected", async () => {
    const user = userEvent.setup()
    render(
      <PendingCharges
        patientId="patient-1"
        branchId="branch-1"
        charges={charges}
        services={[]}
        products={[]}
        providers={[]}
        coverages={[]}
        canVoid={true}
        canDiscount={false}
      />
    )

    const consultationCheckbox = screen.getByRole("checkbox", { name: /consultation/i })
    await user.click(consultationCheckbox)

    const createButton = screen.getByRole("button", { name: /create invoice \(1\)/i })
    expect(createButton).not.toBeDisabled()
    expect(screen.getByText(/selected total/i).closest("div")).toHaveTextContent("100.00")

    await user.click(consultationCheckbox)
    expect(screen.getByRole("button", { name: /create invoice \(0\)/i })).toBeDisabled()
  })

  it("never shows a discount field to a session without invoice.discount, so it can't invite a doomed submission", () => {
    render(
      <PendingCharges
        patientId="patient-1"
        branchId="branch-1"
        charges={charges}
        services={[]}
        products={[]}
        providers={[]}
        coverages={[]}
        canVoid={true}
        canDiscount={false}
      />
    )
    expect(screen.queryByLabelText(/discount/i)).not.toBeInTheDocument()
  })
})
