"use server"

import { revalidatePath } from "next/cache"
import { getCurrentSession } from "@/lib/auth/session"
import { runDryRun, runCommit, cancelImportJob, ImportValidationError } from "@/lib/platform/import/engine"
import { getImporter, isImportType } from "@/lib/domains/onboarding/imports/registry"
import type { DryRunSummary } from "@/lib/platform/import/types"
import type { CommitResult } from "@/lib/platform/import/engine"

async function requireSession() {
  const session = await getCurrentSession()
  if (!session) throw new Error("Not authenticated.")
  return session
}

export type DryRunActionState = { error?: string; jobId?: string; summary?: DryRunSummary }
export type CommitActionState = { error?: string; result?: CommitResult }

async function readFileText(formData: FormData, field = "file"): Promise<string> {
  const file = formData.get(field)
  if (!(file instanceof File)) throw new Error("No file was uploaded.")
  return file.text()
}

export async function dryRunImportAction(formData: FormData): Promise<DryRunActionState> {
  const session = await requireSession()
  const type = String(formData.get("type") ?? "")
  if (!isImportType(type)) return { error: "Unknown import type." }
  const file = formData.get("file")
  if (!(file instanceof File)) return { error: "Choose a CSV file first." }
  if (!file.name.toLowerCase().endsWith(".csv")) return { error: "Only .csv files are accepted." }

  try {
    const fileText = await readFileText(formData)
    const importer = await getImporter(session, type)
    const { jobId, summary } = await runDryRun(session, importer, { fileText, fileName: file.name })
    return { jobId, summary }
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to validate the file." }
  }
}

export async function commitImportAction(formData: FormData): Promise<CommitActionState> {
  const session = await requireSession()
  const type = String(formData.get("type") ?? "")
  const jobId = String(formData.get("jobId") ?? "")
  if (!isImportType(type) || !jobId) return { error: "Missing import job." }
  const file = formData.get("file")
  if (!(file instanceof File)) return { error: "Re-select the same CSV file to commit." }

  try {
    const fileText = await readFileText(formData)
    const importer = await getImporter(session, type)
    const result = await runCommit(session, importer, { jobId, fileText })
    revalidatePath("/admin/onboarding")
    return { result }
  } catch (e) {
    if (e instanceof ImportValidationError) return { error: e.message }
    return { error: e instanceof Error ? e.message : "Failed to commit the import." }
  }
}

export async function cancelImportAction(jobId: string): Promise<void> {
  const session = await requireSession()
  await cancelImportJob(session, jobId)
  revalidatePath("/admin/onboarding")
}
