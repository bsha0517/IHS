"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"

type BaseActionState = { error?: string; success?: boolean }

/**
 * Drives a Dialog whose form submits a Server Action: pending/error state plus
 * auto-close on success. Deliberately does NOT use useEffect to react to the
 * action's result — the action is invoked directly inside the useTransition
 * callback, and setOpen/setState run there (an event-derived async callback),
 * not in an effect body, which is the pattern React recommends over
 * "setState-in-effect" for this exact case (see use-mobile.ts for the one place
 * an effect genuinely is the right tool — synchronizing with a browser API that
 * doesn't exist during SSR).
 */
export function useActionDialog<T extends BaseActionState>(
  action: (prevState: T, formData: FormData) => Promise<T>,
  initialState: T
) {
  const router = useRouter()
  const [open, setOpenState] = useState(false)
  const [state, setState] = useState<T>(initialState)
  const [pending, startTransition] = useTransition()

  function setOpen(next: boolean) {
    if (next) setState(initialState)
    setOpenState(next)
  }

  function submit(formData: FormData) {
    startTransition(async () => {
      const result = await action(initialState, formData)
      setState(result)
      if (result.success) {
        setOpenState(false)
        // The action already called revalidatePath server-side; calling the
        // server action directly (rather than binding it as the form's native
        // action) skips Next's automatic post-action RSC refresh, so trigger
        // it explicitly or the invalidated cache never reaches this client.
        router.refresh()
      }
    })
  }

  return { open, setOpen, state, pending, submit }
}
