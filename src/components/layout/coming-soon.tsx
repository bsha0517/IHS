import { Construction } from "lucide-react"

export function ComingSoon({ label, phase }: { label: string; phase?: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border py-16 text-center">
      <Construction className="size-8 text-muted-foreground" />
      <div>
        <p className="font-medium">{label}</p>
        <p className="text-sm text-muted-foreground">
          {phase ? `Scheduled for ${phase} — see PROJECT_STATUS.md.` : "Scheduled in a later build phase — see PROJECT_STATUS.md."}
        </p>
      </div>
    </div>
  )
}
