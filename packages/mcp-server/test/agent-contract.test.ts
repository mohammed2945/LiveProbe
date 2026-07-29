import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import {
  AnalyzerClientError,
  BrokerClient,
  INVESTIGATION_ACTION_KINDS,
  LIVEPROBE_AGENT_SKILL_VERSION,
  LIVEPROBE_DECISION_PROTOCOL,
  createMcpServer,
} from "../src/index.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillPath = resolve(
  packageRoot,
  "../../skills/liveprobe-investigation/SKILL.md",
);

describe("LiveProbe agent contract", () => {
  it("keeps the versioned skill tied to the MCP action vocabulary", async () => {
    const skill = await readFile(skillPath, "utf8");

    expect(skill).toContain(
      `Protocol compatibility: \`${LIVEPROBE_AGENT_SKILL_VERSION}\`.`,
    );
    expect(skill).toContain(LIVEPROBE_DECISION_PROTOCOL);
    for (const actionKind of INVESTIGATION_ACTION_KINDS) {
      expect(skill).toContain(`\`${actionKind}\``);
    }
  });

  it("preserves the production investigation invariants in agent guidance", async () => {
    const skill = await readFile(skillPath, "utf8");

    expect(skill).toContain("Do not start LiveProbe cold");
    expect(skill).toContain("Probe evidence from the correlated occurrence");
    expect(skill).toContain("soft priors");
    expect(skill).toContain("Treat `actions` as a menu, not a template");
    expect(skill).toContain("Do not probe mechanically at every frontier");
    expect(skill).toContain("never deploy the stale bundle");
    expect(skill).toContain("`correlation_trace_id`");
    expect(skill).toContain("Never invent that identity");
    expect(skill).toContain(
      "if the selected direction depends on an unobserved runtime fact",
    );
    expect(skill).toContain("Never turn `UNKNOWN` into a verdict by assertion");
    expect(skill).toContain("`LOCALIZED`");
    expect(skill).toContain("`HANDOFF`");
    expect(skill).toContain("`INSUFFICIENT`");
  });

  it.each([
    [
      "stale investigation decision: current revision 4, received 3",
      "stale_revision",
      "get_investigation_context",
    ],
    [
      "selected action action_old is not available at revision 4",
      "illegal_action",
      "exact current action_id",
    ],
    [
      "confirmation probe budget exceeded",
      "budget_exceeded",
      "smaller current legal frontier",
    ],
  ])(
    "returns mechanical recovery for analyzer rejection %s",
    async (message, expectedCode, expectedRecovery) => {
      const analyzer = {
        async run() {
          throw new AnalyzerClientError(message);
        },
        async getPlan() {
          throw new AnalyzerClientError(message);
        },
      };
      const server = createMcpServer(
        new BrokerClient("http://127.0.0.1:1"),
        analyzer,
      );
      const client = new Client(
        { name: "liveprobe-agent-contract-test", version: "1.0.0" },
        { capabilities: {} },
      );
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const result = await client.callTool({
          name: "apply_investigation_decision",
          arguments: {
            repository_root: "/workspace/riderush",
            investigation_id: `inv_${"2".repeat(24)}`,
            based_on_revision: 3,
            action_ids: ["action_current"],
          },
        });
        expect(result.isError).toBe(true);
        expect(Array.isArray(result.content)).toBe(true);
        const content = result.content as Array<{
          type: string;
          text?: string;
        }>;
        const text = content.find((item) => item.type === "text");
        expect(text?.text).toContain(`"code": "${expectedCode}"`);
        expect(text?.text).toContain(expectedRecovery);
      } finally {
        await client.close();
        await server.close();
      }
    },
  );
});
