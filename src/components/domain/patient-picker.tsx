"use client"

import { useEffect, useRef, useState, useTransition } from "react"
import { Search, Check } from "lucide-react"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { searchPatientsAction } from "@/app/(dashboard)/patients/actions"

type PatientResult = { id: string; mrn: string; firstName: string; lastName: string; mobile: string }

export function PatientPicker({
  name,
  defaultPatient,
  onSelect,
}: {
  name: string
  defaultPatient?: PatientResult | null
  onSelect?: (patient: PatientResult) => void
}) {
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<PatientResult[]>([])
  const [selected, setSelected] = useState<PatientResult | null>(defaultPatient ?? null)
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // No setResults([]) here for the empty-query case: the dropdown below is
    // already gated on `query.trim()`, so stale results simply never render —
    // clearing them here would just be a synchronous setState-in-effect for
    // no visible benefit.
    if (!query.trim()) return
    const timeout = setTimeout(() => {
      startTransition(async () => {
        const found = await searchPatientsAction(query)
        setResults(found)
        setOpen(true)
      })
    }, 250)
    return () => clearTimeout(timeout)
  }, [query])

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [])

  return (
    <div ref={containerRef} className="relative">
      <input type="hidden" name={name} value={selected?.id ?? ""} />
      <div className="relative">
        <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
        <Input
          placeholder="Search patient by name, MRN, or phone"
          value={
            selected
              ? // P3.2: `defaultPatient` (e.g. NewAppointmentDialog's "Book
                // appointment" quick action from Patient 360) may only know
                // a display name, not the real MRN — trailing " ()" reads
                // as broken, so each part is only shown when it's real.
                [`${selected.firstName} ${selected.lastName}`.trim(), selected.mrn && `(${selected.mrn})`].filter(Boolean).join(" ")
              : query
          }
          onChange={(e) => {
            setSelected(null)
            setQuery(e.target.value)
          }}
          onFocus={() => results.length > 0 && setOpen(true)}
          className="pl-8"
        />
      </div>
      {open && (query.trim() || pending) && (
        <div className="absolute z-50 mt-1 w-full rounded-md border border-border bg-popover shadow-md">
          {pending && <p className="p-2 text-sm text-muted-foreground">Searching...</p>}
          {!pending && results.length === 0 && <p className="p-2 text-sm text-muted-foreground">No matches.</p>}
          {!pending &&
            results.map((patient) => (
              <button
                key={patient.id}
                type="button"
                className={cn(
                  "flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-muted",
                  selected?.id === patient.id && "bg-muted"
                )}
                onClick={() => {
                  setSelected(patient)
                  setOpen(false)
                  onSelect?.(patient)
                }}
              >
                <span>
                  {patient.firstName} {patient.lastName}{" "}
                  <span className="text-muted-foreground">
                    ({patient.mrn} · {patient.mobile})
                  </span>
                </span>
                {selected?.id === patient.id && <Check className="size-4" />}
              </button>
            ))}
        </div>
      )}
    </div>
  )
}
