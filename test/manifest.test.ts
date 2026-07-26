import { describe, expect, test } from "bun:test";
import { manifest } from "../src/manifest";

describe("Meeting manifest", () => {
  test("requires source factories so installation never joins a call", () => {
    expect(manifest.slots.source.contract).toBe("meeting/source-factory");
    expect(manifest.wiring[0]?.server?.code).toContain("createMeetingManager");
    expect(manifest.wiring[0]?.server?.code).not.toContain(".start(");
  });

  test("governs dynamic joins by stable session identity", () => {
    const authorization = manifest.tools.join_meeting.authorization;

    expect(authorization.approval).toBe("policy");
    expect(authorization.effects).toEqual(["write", "external-network"]);
    expect(authorization.idempotency).toEqual({ mode: "resource" });
    expect(authorization.resource).toEqual({
      idField: "sessionId",
      type: "active-meeting",
    });
  });
});
