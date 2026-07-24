import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  NATIVE_REASON_CODES,
  NativeProbeStatusSchema,
  NativeReasonCodeSchema,
  UnavailableValueMetadataSchema,
  NativeAgentRegistrationSchema,
  NativeAssignmentsResponseSchema,
} from "../src/index.js";
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/native-wire.json", import.meta.url), "utf8"),
) as {
  registration: unknown;
  assignments: unknown;
};

describe("canonical native contract", () => {
  it.each(NATIVE_REASON_CODES)("accepts native reason %s", (reasonCode) => {
    expect(NativeReasonCodeSchema.parse(reasonCode)).toBe(reasonCode);
    expect(NativeProbeStatusSchema.parse({
      status: "error",
      updatedAt: "2026-07-22T00:00:00.000Z",
      reasonCode,
      probeVersion: 7,
    })).toMatchObject({ reasonCode, probeVersion: 7 });
    expect(UnavailableValueMetadataSchema.parse({ reasonCode })).toEqual({ reasonCode });
  });

  it("rejects unknown response fields", () => {
    expect(() => NativeProbeStatusSchema.parse({
      status: "armed",
      updatedAt: "2026-07-22T00:00:00.000Z",
      arbitraryBpfPath: "/tmp/evil.o",
    })).toThrow();
  });

  it("validates the Rust/TypeScript native wire fixture", () => {
    expect(NativeAgentRegistrationSchema.parse(fixture.registration))
      .toEqual(fixture.registration);
    expect(NativeAssignmentsResponseSchema.parse(fixture.assignments))
      .toEqual(fixture.assignments);
  });
});
