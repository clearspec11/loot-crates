/*
  The manager's tabs follow the ARIA tabs pattern: one stop in the tab
  order, arrows (wrapping), Home and End move between them.
*/
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

vi.mock("../module/scripts/foundry/shop.js", () => ({ refreshShop: vi.fn() }));
vi.mock("../module/scripts/foundry/chat.js", () => ({ postRefundCard: vi.fn() }));

let tabAfter;
beforeAll(async () => {
  vi.stubGlobal("foundry", { utils: { escapeHTML: s => String(s), deepClone: v => structuredClone(v) }, applications: { api: { ApplicationV2: class {}, DialogV2: class {} } } });
  ({ tabAfter } = await import("../module/scripts/foundry/manager.js"));
});
afterAll(() => vi.unstubAllGlobals());

describe("tabAfter", () => {
  const keys = ["pools", "boxes", "log"];
  it("moves right and left, wrapping at the ends", () => {
    expect(tabAfter(keys, "pools", "ArrowRight")).toBe("boxes");
    expect(tabAfter(keys, "log", "ArrowRight")).toBe("pools");
    expect(tabAfter(keys, "pools", "ArrowLeft")).toBe("log");
    expect(tabAfter(keys, "boxes", "ArrowUp")).toBe("pools");
    expect(tabAfter(keys, "boxes", "ArrowDown")).toBe("log");
  });
  it("goes to the first and last on Home and End", () => {
    expect(tabAfter(keys, "log", "Home")).toBe("pools");
    expect(tabAfter(keys, "pools", "End")).toBe("log");
  });
  it("ignores every other key, so Enter, Space and Tab do what they always do", () => {
    for (const k of ["Enter", " ", "Tab", "a"]) expect(tabAfter(keys, "boxes", k)).toBeNull();
  });
});
