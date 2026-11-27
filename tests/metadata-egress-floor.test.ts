/** Tests for .agents/tools/metadata-egress-floor.mjs using a temporary root and stubbed commands. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM tool script without .d.ts
import * as floor from "../.agents/tools/metadata-egress-floor.mjs";

function makeFakeSystem(root: string) {
  const base = new floor.System(root);
  const calls: string[][] = [];
  const state = { nftEnabled: "disabled", tablePresent: true };
  const fake = Object.assign(base, {
    calls,
    requireRoot() {},
    nft() {
      return "/usr/sbin/nft";
    },
    run(argv: string[]) {
      calls.push(argv);
      if (argv[0] === "systemctl" && argv[1] === "is-enabled" && argv[2] === "nftables.service") {
        return { returncode: 0, stdout: `${state.nftEnabled}\n`, stderr: "" };
      }
      if (argv[0] === "/usr/sbin/nft" && argv[1] === "list") {
        return { returncode: state.tablePresent ? 0 : 1, stdout: "", stderr: "" };
      }
      return { returncode: 0, stdout: "", stderr: "" };
    },
  });
  return fake as {
    read: (p: string) => string | null;
    write: (p: string, text: string, mode?: number) => boolean;
    remove: (p: string) => boolean;
    path: (p: string) => string;
    calls: string[][];
  };
}

describe("metadata-egress-floor.mjs", () => {
  it("refuses root uid 0 and non-positive uids", () => {
    expect(() => floor.rules(0)).toThrow("non-root uid");
    expect(() => floor.rules(-1)).toThrow("non-root uid");
  });

  it("adds and removes marked includes in nftables.conf safely", () => {
    const base = "#!/usr/sbin/nft -f\nflush ruleset\n";
    const withInc = floor.withInclude(base);
    expect(withInc).toContain(`include "${floor.RULES}"`);
    expect(floor.withInclude(withInc)).toBe(withInc);
    expect(floor.withoutInclude(withInc)).toBe(base);
    expect(floor.markerProblem(`${floor.BEGIN_LINE}\n`)).toContain("1 BEGIN and 0 END");
  });

  it("normalizes and verifies live nft JSON rules", () => {
    const uid = 1001;
    const valid = JSON.stringify({
      nftables: [
        { chain: { name: "output", type: "filter", hook: "output", prio: 0, policy: "accept" } },
        {
          rule: {
            expr: [
              { match: { op: "==", left: { meta: { key: "skuid" } }, right: uid } },
              {
                match: {
                  op: "==",
                  left: { payload: { protocol: "ip", field: "daddr" } },
                  right: floor.METADATA_V4,
                },
              },
              { match: { op: "==", left: { meta: { key: "l4proto" } }, right: "tcp" } },
              { reject: { type: "tcp reset" } },
            ],
          },
        },
        {
          rule: {
            expr: [
              { match: { op: "==", left: { meta: { key: "skuid" } }, right: uid } },
              {
                match: {
                  op: "==",
                  left: { payload: { protocol: "ip", field: "daddr" } },
                  right: floor.METADATA_V4,
                },
              },
              { reject: { type: "icmpx", expr: "admin-prohibited" } },
            ],
          },
        },
        {
          rule: {
            expr: [
              { match: { op: "==", left: { meta: { key: "skuid" } }, right: uid } },
              {
                match: {
                  op: "==",
                  left: { payload: { protocol: "ip6", field: "daddr" } },
                  right: floor.METADATA_V6,
                },
              },
              { match: { op: "==", left: { meta: { key: "l4proto" } }, right: 6 } },
              { reject: { type: "tcp reset" } },
            ],
          },
        },
        {
          rule: {
            expr: [
              { match: { op: "==", left: { meta: { key: "skuid" } }, right: "nicolas" } },
              {
                match: {
                  op: "==",
                  left: { payload: { protocol: "ip6", field: "daddr" } },
                  right: floor.METADATA_V6,
                },
              },
              { reject: { type: "icmpx", expr: "admin-prohibited" } },
            ],
          },
        },
      ],
    });
    expect(floor.liveRuleProblems(valid, uid, "nicolas")).toEqual([]);
    expect(floor.liveRuleProblems("{bad", uid, "nicolas")).toEqual([
      "The live table could not be listed as nft JSON.",
    ]);
  });

  it("evaluates probe verdicts and requiresFloor accurately", () => {
    expect(
      floor.probeProblems({
        metadataV4: { outcome: "ECONNREFUSED", ms: 2 },
        metadataV6: { eth0: { outcome: "ENETUNREACH", ms: 1 } },
      }),
    ).toEqual([]);
    expect(
      floor.probeProblems({
        metadataV4: { outcome: "timeout", ms: 3000 },
        metadataV6: {},
      }),
    ).toHaveLength(1);
    expect(floor.requiresFloor(`Requires=${floor.UNIT}\nAfter=${floor.UNIT}\n`)).toBe(true);
    expect(floor.requiresFloor(`Requires=other.service\nAfter=${floor.UNIT}\n`)).toBe(false);
  });

  it("installs idempotently and removes cleanly in a temp root", () => {
    const root = mkdtempSync(join(tmpdir(), "egress-floor-"));
    try {
      const sys = makeFakeSystem(root);
      sys.write(floor.NFTABLES_CONF, "#!/usr/sbin/nft -f\nflush ruleset\n");
      const first = floor.install(sys, "nicolas", 1001);
      expect(first.installed).toBe(true);
      expect(first.changedFiles.length).toBeGreaterThan(0);
      expect(sys.read(floor.NFTABLES_CONF)).toContain(`include "${floor.RULES}"`);

      const second = floor.install(sys, "nicolas", 1001);
      expect(second.changedFiles).toEqual([]);

      const removed = floor.remove(sys);
      expect(removed.removed).toBe(true);
      expect(removed.tableDeleted).toBe(true);
      expect(sys.read(floor.RULES)).toBeNull();
      expect(sys.read(floor.NFTABLES_CONF)).not.toContain(`include "${floor.RULES}"`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
