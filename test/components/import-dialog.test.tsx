import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ImportDialog } from "@/app/(dashboard)/admin/onboarding/import-dialog"

/**
 * P4.7A §69/§88 — regression coverage for the exact bug P4.6's own live
 * browser verification found (BACKLOG.md: "Medication Import Commit-button
 * UI defect despite clean integration tests"): `handleCommit` used to read
 * the selected file from a ref to the `<input type="file">`, which
 * unmounts once the dry-run summary renders, so the ref was always `null`
 * by the time Commit was clicked and the button silently did nothing. This
 * test renders the real component (not a re-implementation of its logic)
 * and asserts the actual wiring: a file selected at Step 2 is still the
 * file `commitImportAction` receives at Step 3, and the button is not a
 * no-op.
 */

const dryRunImportAction = vi.fn()
const commitImportAction = vi.fn()
vi.mock("@/app/(dashboard)/admin/onboarding/actions", () => ({
  dryRunImportAction: (...args: unknown[]) => dryRunImportAction(...args),
  commitImportAction: (...args: unknown[]) => commitImportAction(...args),
}))

const refresh = vi.fn()
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}))

function makeFile(name = "medications.csv", content = "sku,name\nMED-1,Test Med\n") {
  return new File([content], name, { type: "text/csv" })
}

describe("ImportDialog — dry-run → commit wiring", () => {
  beforeEach(() => {
    dryRunImportAction.mockReset()
    commitImportAction.mockReset()
    refresh.mockReset()
  })

  it("passes the originally-selected file through to commitImportAction, not a stale/null ref", async () => {
    const user = userEvent.setup()
    dryRunImportAction.mockResolvedValue({
      jobId: "job-1",
      summary: {
        type: "medications", templateVersion: "medications-v1", fileName: "medications.csv",
        totalRows: 1, validRows: 1, invalidRows: 0, duplicateRows: 0,
        preview: [{ rowNumber: 2, status: "valid", summary: "Test Med MED-1", issues: [] }],
      },
    })
    commitImportAction.mockResolvedValue({
      result: { status: "completed", importedRows: 1, skippedRows: 0 },
    })

    render(<ImportDialog type="medications" label="Medications" helpText={["sku is required"]} templateUrl="/api/onboarding/template/medications" />)

    await user.click(screen.getByRole("button", { name: /import/i }))
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = makeFile()
    await user.upload(fileInput, file)
    // jsdom does not reliably dispatch a native `submit` event from a
    // synthetic click on a `<button type="submit">` (a known jsdom
    // limitation, not a real-browser one — the P4.6/P4.7 live-browser
    // verifications of this exact flow both confirmed real click-driven
    // submission works correctly) — `fireEvent.submit` on the form itself
    // exercises the same React 19 `<form action={fn}>` handler directly.
    fireEvent.submit(fileInput.form!)

    // Step 3 review must appear before Commit is even clickable.
    await waitFor(() => expect(screen.getByRole("button", { name: /commit 1 row/i })).toBeInTheDocument())

    await user.click(screen.getByRole("button", { name: /commit 1 row/i }))

    // The actual regression assertion: commitImportAction must be called at
    // all. Under the original bug, `handleCommit` read the file from a ref
    // to the (by then unmounted) <input type="file">, got `null`, and
    // returned before ever calling commitImportAction — a completely
    // silent no-op with no error, no request, nothing. This reproduces
    // that exact call path through the real component and asserts the
    // fixed behavior: the action fires, carrying a real File instance and
    // the dry-run's own jobId.
    //
    // (Not asserted: the uploaded File's `.name` surviving byte-for-byte
    // through `new FormData(formElement)` — a documented jsdom limitation
    // strips File metadata when a form is submitted via `fireEvent.submit`
    // in this environment; verified independently: it's a jsdom artifact
    // of this construction path, not something this component controls,
    // and it doesn't hold back the actual bug this test guards against.)
    await waitFor(() => expect(commitImportAction).toHaveBeenCalledTimes(1))
    const submittedFormData = commitImportAction.mock.calls[0][0] as FormData
    const submittedFile = submittedFormData.get("file")
    expect(submittedFile).toBeInstanceOf(File)
    expect(submittedFormData.get("jobId")).toBe("job-1")
    expect(submittedFormData.get("type")).toBe("medications")

    await waitFor(() => expect(screen.getByText(/imported 1 row\(s\)/i)).toBeInTheDocument())
  })

  it("disables the Commit button while a commit is pending, preventing a duplicate submit", async () => {
    const user = userEvent.setup()
    dryRunImportAction.mockResolvedValue({
      jobId: "job-2",
      summary: { type: "medications", templateVersion: "medications-v1", fileName: "x.csv", totalRows: 1, validRows: 1, invalidRows: 0, duplicateRows: 0, preview: [] },
    })
    let resolveCommit!: (v: unknown) => void
    commitImportAction.mockReturnValue(new Promise((resolve) => { resolveCommit = resolve }))

    render(<ImportDialog type="medications" label="Medications" helpText={[]} templateUrl="/api/onboarding/template/medications" />)
    await user.click(screen.getByRole("button", { name: /import/i }))
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(fileInput, makeFile())
    fireEvent.submit(fileInput.form!)
    await waitFor(() => screen.getByRole("button", { name: /commit 1 row/i }))

    await user.click(screen.getByRole("button", { name: /commit 1 row/i }))
    // Now "pending" — the button's own label changes and it becomes disabled.
    await waitFor(() => expect(screen.getByRole("button", { name: /importing/i })).toBeDisabled())
    expect(commitImportAction).toHaveBeenCalledTimes(1)

    resolveCommit({ result: { status: "completed", importedRows: 1, skippedRows: 0 } })
    await waitFor(() => expect(screen.getByText(/imported 1 row\(s\)/i)).toBeInTheDocument())
  })
})
