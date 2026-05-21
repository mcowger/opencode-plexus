import { describe, expect, test } from "bun:test"
import { trimURL, apiBase, modelsUrl } from "../src/url"

describe("trimURL", () => {
  test("strips trailing slashes", () => {
    expect(trimURL("https://example.com/")).toBe("https://example.com")
    expect(trimURL("https://example.com///")).toBe("https://example.com")
  })

  test("strips whitespace", () => {
    expect(trimURL("  https://example.com  ")).toBe("https://example.com")
  })

  test("returns empty string for blank input", () => {
    expect(trimURL("")).toBe("")
    expect(trimURL("   ")).toBe("")
  })

  test("preserves path segments", () => {
    expect(trimURL("https://example.com/plexus")).toBe("https://example.com/plexus")
  })
})

describe("apiBase", () => {
  test("appends /v1 to a root URL", () => {
    expect(apiBase("https://example.com")).toBe("https://example.com/v1")
  })

  test("does not double-append /v1", () => {
    expect(apiBase("https://example.com/v1")).toBe("https://example.com/v1")
    expect(apiBase("https://example.com/v1/")).toBe("https://example.com/v1")
  })

  test("returns empty string for blank input", () => {
    expect(apiBase("")).toBe("")
    expect(apiBase("   ")).toBe("")
  })

  test("works with trailing slashes", () => {
    expect(apiBase("https://example.com/")).toBe("https://example.com/v1")
  })

  test("works with IP + port", () => {
    expect(apiBase("http://192.168.1.10:8080")).toBe("http://192.168.1.10:8080/v1")
    expect(apiBase("http://192.168.1.10:8080/v1")).toBe("http://192.168.1.10:8080/v1")
  })

  test("works with http scheme", () => {
    expect(apiBase("http://localhost:1234")).toBe("http://localhost:1234/v1")
  })
})

describe("modelsUrl", () => {
  test("returns /v1/models URL", () => {
    expect(modelsUrl("https://example.com")).toBe("https://example.com/v1/models")
    expect(modelsUrl("https://example.com/v1")).toBe("https://example.com/v1/models")
  })

  test("returns empty string for blank input", () => {
    expect(modelsUrl("")).toBe("")
  })
})
