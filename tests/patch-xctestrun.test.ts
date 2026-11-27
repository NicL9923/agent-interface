/** Tests for .agents/tools/patch-xctestrun.mjs. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM tool script without .d.ts
import * as patchXctestrun from "../.agents/tools/patch-xctestrun.mjs";

const { main, parsePlistXml, patch, serializePlistXml } = patchXctestrun;

const uiTarget = (extra: Record<string, unknown> = {}) => ({
  BlueprintName: "AgentInterfaceUITests",
  IsUITestBundle: true,
  ...extra,
});

describe("patch-xctestrun.mjs", () => {
  it("patches only UI targets in FormatVersion 1 and preserves other settings", () => {
    const run = {
      __xctestrun_metadata__: { FormatVersion: 1 },
      AgentInterfaceTests: {
        BlueprintName: "AgentInterfaceTests",
        CommandLineArguments: ["-unit"],
      },
      AgentInterfaceUITests: uiTarget({
        CommandLineArguments: ["-keep"],
        EnvironmentVariables: { KEEP: "1" },
      }),
    };
    expect(patch(run, 15)).toEqual(["AgentInterfaceUITests"]);
    const ui = run.AgentInterfaceUITests as Record<string, unknown>;
    expect(ui.CommandLineArguments).toEqual(["-keep", "-XCTCrashReportCollectionTimeout", "15"]);
    expect(ui.EnvironmentVariables).toEqual({
      KEEP: "1",
      XCTCrashReportCollectionTimeout: "15",
    });
    expect(run.AgentInterfaceTests).toEqual({
      BlueprintName: "AgentInterfaceTests",
      CommandLineArguments: ["-unit"],
    });
  });

  it("handles FormatVersion 2 and repeated patching idempotently", () => {
    const run = {
      __xctestrun_metadata__: { FormatVersion: 2 },
      TestConfigurations: [{ TestTargets: [uiTarget()] }],
    };
    patch(run, 30);
    patch(run, 15);
    const target = run.TestConfigurations[0].TestTargets[0] as Record<string, unknown>;
    expect(target.CommandLineArguments).toEqual(["-XCTCrashReportCollectionTimeout", "15"]);
    expect(
      (target.EnvironmentVariables as Record<string, string>).XCTCrashReportCollectionTimeout,
    ).toBe("15");
  });

  it("refuses plans without UI targets or unknown format versions", () => {
    expect(() =>
      patch({ AgentInterfaceTests: { BlueprintName: "AgentInterfaceTests" } }, 15),
    ).toThrow("no UI test target");
    expect(() => patch({ __xctestrun_metadata__: { FormatVersion: 3 } }, 15)).toThrow(
      "Unsupported xctestrun FormatVersion 3",
    );
  });

  it("writes the copy beside the original only and round-trips XML plist", () => {
    const dir = mkdtempSync(join(tmpdir(), "patch-xctestrun-"));
    try {
      const source = join(dir, "App.xctestrun");
      writeFileSync(source, serializePlistXml({ AgentInterfaceUITests: uiTarget() }), "utf8");
      const copy = join(dir, "App-crash-wait.xctestrun");
      main([source, copy, "15"]);
      const parsedCopy = parsePlistXml(readFileSync(copy, "utf8")) as Record<
        string,
        Record<string, unknown>
      >;
      expect(parsedCopy.AgentInterfaceUITests.EnvironmentVariables).toEqual({
        XCTCrashReportCollectionTimeout: "15",
      });
      const parsedSource = parsePlistXml(readFileSync(source, "utf8")) as Record<
        string,
        Record<string, unknown>
      >;
      expect(parsedSource.AgentInterfaceUITests.EnvironmentVariables).toBeUndefined();

      mkdirSync(join(dir, "elsewhere"));
      for (const destination of [join(dir, "elsewhere", "App.xctestrun"), source]) {
        expect(() => main([source, destination, "15"])).toThrow("beside the original");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
