import { pool } from "@workspace/db";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PostgreSQL pool errors", () => {
  it("logs an idle-client disconnect without throwing", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = Object.assign(
      new Error("terminating connection due to administrator command"),
      { code: "57P01" },
    );

    expect(() => pool.emit("error", error)).not.toThrow();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("future queries will reconnect"),
      {
        code: "57P01",
        message: "terminating connection due to administrator command",
        name: "Error",
      },
    );
  });
});