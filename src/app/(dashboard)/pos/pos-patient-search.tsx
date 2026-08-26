"use client"

import { useRouter } from "next/navigation"
import { PatientPicker } from "@/components/domain/patient-picker"

export function PosPatientSearch() {
  const router = useRouter()
  return (
    <div className="mx-auto max-w-md">
      <PatientPicker name="patientSearch" onSelect={(patient) => router.push(`/pos?patientId=${patient.id}`)} />
    </div>
  )
}
