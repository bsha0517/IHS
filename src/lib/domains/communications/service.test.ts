import { describe, it, expect } from "vitest"
import { renderTemplate } from "@/lib/domains/communications/service"

describe("renderTemplate", () => {
  it("substitutes every {{variable}} present in the map", () => {
    expect(renderTemplate("Hi {{name}}, your visit is on {{date}}.", { name: "Amina", date: "12 Sep" })).toBe(
      "Hi Amina, your visit is on 12 Sep."
    )
  })

  it("leaves an unresolved {{placeholder}} untouched rather than throwing", () => {
    expect(renderTemplate("Hi {{name}}, code {{otp}}.", { name: "Amina" })).toBe("Hi Amina, code {{otp}}.")
  })

  it("substitutes the same variable at every occurrence", () => {
    expect(renderTemplate("{{name}} {{name}}", { name: "X" })).toBe("X X")
  })

  it("passes through text with no placeholders unchanged", () => {
    expect(renderTemplate("No variables here.", {})).toBe("No variables here.")
  })
})
