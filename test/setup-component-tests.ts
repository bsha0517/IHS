import "@testing-library/jest-dom/vitest"
import { cleanup } from "@testing-library/react"
import { afterEach } from "vitest"

// Unmounts whatever the previous test rendered — without this, component
// tests accumulate DOM nodes across a file and queries start matching the
// wrong instance.
afterEach(() => {
  cleanup()
})

// P4.7A.1 §46 — jsdom implements neither the Pointer Events capture API nor
// `scrollIntoView`; Radix's `Select` (used by several dialogs under test,
// e.g. DispenseItemDialog's medication picker) calls both unconditionally
// on open/select, throwing in jsdom with no polyfill. This is a documented
// jsdom environment gap, not a real browser behavior — confirmed via this
// engagement's own live browser verification of every Select-using dialog.
if (typeof window !== "undefined") {
  if (!window.HTMLElement.prototype.hasPointerCapture) {
    window.HTMLElement.prototype.hasPointerCapture = () => false
  }
  if (!window.HTMLElement.prototype.setPointerCapture) {
    window.HTMLElement.prototype.setPointerCapture = () => {}
  }
  if (!window.HTMLElement.prototype.releasePointerCapture) {
    window.HTMLElement.prototype.releasePointerCapture = () => {}
  }
  if (!window.HTMLElement.prototype.scrollIntoView) {
    window.HTMLElement.prototype.scrollIntoView = () => {}
  }
  // Several Radix primitives (Select, Checkbox) size themselves via
  // `@radix-ui/react-use-size`, which needs a real `ResizeObserver` — also
  // absent from jsdom.
  if (typeof window.ResizeObserver === "undefined") {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
}
