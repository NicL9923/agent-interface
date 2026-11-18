import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// Operator tooling uses Node's built-in modules and has no TypeScript build step.
import {
  all,
  appleApi,
  AppleNotReady,
  distribute,
  requireReadyBuild,
  runPrivate,
  untilReady,
  // @ts-expect-error Plain JavaScript operator module.
} from "../.agents/tools/apple-api.mjs";

import {
  repositoryRelease,
  requireFullIosValidation,
  requireRepositoryRelease,
  validateCommand,
  // @ts-expect-error Plain JavaScript operator module.
} from "../.agents/tools/ios-release-gate.mjs";

const root = resolve(__dirname, "..");
const ready = () => ({
  id: "build-42",
  attributes: { version: "42", processingState: "VALID", expired: false },
  marketingVersion: "1.0",
  relationships: { app: { data: { id: "wildbots" } }, preReleaseVersion: { data: { id: "v1" } } },
});
const household = ["one@example.test", "two@example.test"];

describe("iOS publishing fences", () => {
  it("retries a transient read failure but never repeats an uncertain mutation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wildbots-api-key-"));
    try {
      const keyFile = join(directory, "test.p8");
      writeFileSync(
        keyFile,
        generateKeyPairSync("ec", {
          namedCurve: "P-256",
          privateKeyEncoding: { type: "pkcs8", format: "pem" },
          publicKeyEncoding: { type: "spki", format: "pem" },
        }).privateKey,
        { mode: 0o600 },
      );
      const reply = (status: number) => ({
        ok: status === 200,
        status,
        text: async () =>
          JSON.stringify(
            status === 200 ? { data: [] } : { errors: [{ code: "UNEXPECTED_ERROR" }] },
          ),
      });
      const transport = vi
        .fn()
        .mockResolvedValueOnce(reply(500))
        .mockRejectedValueOnce(new Error("connection reset"))
        .mockResolvedValueOnce(reply(200));
      const api = appleApi({ keyId: "test", issuerId: "test", keyFile }, transport);
      // Each of the two retries waits 2 s, which a virtual clock skips.
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      const read = expect(api("GET", "/apps")).resolves.toEqual({ data: [] });
      await vi.advanceTimersByTimeAsync(4000);
      await read;
      expect(transport).toHaveBeenCalledTimes(3);
      transport.mockReset().mockResolvedValue(reply(500));
      await expect(api("POST", "/profiles", { data: {} })).rejects.toThrow("HTTP 500");
      expect(transport).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      rmSync(directory, { recursive: true });
    }
  });
  it("does not echo signing credentials when a subprocess fails", () => {
    try {
      runPrivate(process.execPath, [
        "-e",
        "console.error(process.argv[1]); process.exit(1)",
        "private-signing-password",
      ]);
      throw new Error("Expected subprocess failure");
    } catch (error) {
      expect((error as Error).message).toContain("failed (exit 1)");
      expect((error as Error).message).not.toContain("private-signing-password");
    }
  });
  it("rejects a different app, marketing version, build, and unfinished or expired builds", () => {
    expect(() => requireReadyBuild(ready(), "1.0", 42, "wildbots")).not.toThrow();
    for (const change of [
      { marketingVersion: "2.0" },
      { relationships: { app: { data: { id: "steadlog" } } } },
      ...[{ version: "43" }, { processingState: "PROCESSING" }, { expired: true }].map(
        (attributes) => ({ attributes: { ...ready().attributes, ...attributes } }),
      ),
    ])
      expect(() => requireReadyBuild({ ...ready(), ...change }, "1.0", 42, "wildbots")).toThrow();
  });

  it("does not forward a bearer token through unexpected pagination links", async () => {
    const api = vi
      .fn()
      .mockResolvedValue({ data: [], links: { next: "https://example.com/v1/apps" } });
    await expect(all(api, "/apps")).rejects.toThrow("pagination URL");
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("only emits an announcement after exact group membership and installable state are confirmed", async () => {
    let state = "MISSING_EXPORT_COMPLIANCE";
    let member = false;
    let hasTesters = false;
    const api = vi.fn(async (method: string, route: string) => {
      if (route.startsWith("/apps?"))
        return { data: [{ id: "wildbots", attributes: { bundleId: "dev.agentinterface.ios" } }] };
      if (route.startsWith("/builds?"))
        return {
          data: [ready()],
          included: [{ id: "v1", type: "preReleaseVersions", attributes: { version: "1.0" } }],
        };
      if (route.includes("/wildbots/betaGroups"))
        return {
          data: [
            {
              id: "household",
              attributes: { name: "Household", isInternalGroup: true, hasAccessToAllBuilds: false },
            },
          ],
        };
      if (route.includes("/relationships/builds")) {
        member = true;
        return {};
      }
      if (route.includes("/household/builds")) return { data: member ? [{ id: "build-42" }] : [] };
      if (route === "/betaTesters?filter[betaGroups]=household&limit=200")
        return {
          data: hasTesters ? household.map((email) => ({ id: email, attributes: { email } })) : [],
        };
      if (route.endsWith("/buildBetaDetail"))
        return { data: { attributes: { internalBuildState: state } } };
      throw new Error(`Unexpected ${method} ${route}`);
    });
    await expect(distribute(api, 42, "1.0", household)).rejects.toThrow("exactly the two");
    hasTesters = true;
    await expect(distribute(api, 42, "1.0", household)).rejects.toThrow("not ready");
    expect(api.mock.calls.every(([method]) => method === "GET")).toBe(true);
    state = "IN_BETA_TESTING";
    const receipt = await distribute(api, 42, "1.0", household);
    expect(receipt).toMatchObject({
      appId: "wildbots",
      buildId: "build-42",
      groupId: "household",
      announcement: { IOS_APP_LATEST_BUILD: "42" },
    });
    expect(
      api.mock.calls.filter(
        ([method, route]) => method === "POST" && route.includes("relationships/builds"),
      ),
    ).toHaveLength(1);
  });

  it("does not create a group when the selected build is still processing", async () => {
    const api = vi.fn(async (_method: string, route: string) =>
      route.startsWith("/apps?")
        ? { data: [{ id: "wildbots", attributes: { bundleId: "dev.agentinterface.ios" } }] }
        : { data: [] },
    );
    await expect(distribute(api, 42, "1.0", household)).rejects.toThrow(AppleNotReady);
    await expect(distribute(api, 42, "1.0", household)).rejects.toThrow("has not listed build 42");
    expect(api.mock.calls.every(([method]) => method === "GET")).toBe(true);
  });

  it("stops at once when the build number belongs to another marketing version", async () => {
    const api = vi.fn(async (_method: string, route: string) =>
      route.startsWith("/apps?")
        ? { data: [{ id: "wildbots", attributes: { bundleId: "dev.agentinterface.ios" } }] }
        : {
            data: [ready()],
            included: [{ id: "v1", type: "preReleaseVersions", attributes: { version: "1.1" } }],
          },
    );
    const refusal = await distribute(api, 42, "1.0", household).catch((error: Error) => error);
    expect(refusal).not.toBeInstanceOf(AppleNotReady);
    expect(refusal.message).toContain("belongs to marketing version 1.1, not 1.0");
  });

  it("waits only while Apple is processing, and gives up at the deadline", async () => {
    let clock = 0;
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });
    const options = { sleep, now: () => clock, minutes: 3 };
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls < 3) throw new AppleNotReady("Apple is still processing build 42.");
      return "distributed";
    };
    await expect(untilReady(flaky, options)).resolves.toBe("distributed");
    expect(sleep).toHaveBeenCalledTimes(2);
    await expect(
      untilReady(async () => {
        throw new AppleNotReady("Apple is still processing build 42.");
      }, options),
    ).rejects.toThrow("Run distribute again later");
    await expect(
      untilReady(async () => {
        throw new Error("exactly the two testers");
      }, options),
    ).rejects.toThrow("exactly the two");
    const once = vi.fn(async () => {
      throw new AppleNotReady("not yet");
    });
    await expect(untilReady(once, { ...options, wait: false })).rejects.toThrow(
      "Run distribute again later",
    );
    expect(once).toHaveBeenCalledTimes(1);
  });
});

// The generator is the source of the shipped numbers, so the gate reads it as text.
const generator = (version: string, build: string) =>
  `MARKETING_VERSION = "${version}"\nCURRENT_PROJECT_VERSION = "${build}"\nLINK_DOMAIN = "x"\n`;
const repoFiles =
  (version = "1.0", build = "27") =>
  (_path: string) =>
    generator(version, build);

describe("iOS archive gate: the repository decides the release", () => {
  it("reads the version and build the real generator holds, so a reformat there fails here and not at release time", () => {
    const release = repositoryRelease(root);
    expect(release.version).toMatch(/^\d+\.\d+/);
    expect(Number.isInteger(release.build) && release.build > 0).toBe(true);
  });

  it("refuses a build number that is higher or lower than the repository holds, and says which file to change", () => {
    expect(requireRepositoryRelease(root, "1.0", 27, repoFiles())).toEqual({
      version: "1.0",
      build: 27,
    });
    for (const typed of [28, 26]) {
      expect(() => requireRepositoryRelease(root, "1.0", typed, repoFiles())).toThrow(
        `BUILD ${typed} does not match CURRENT_PROJECT_VERSION 27 in ios/tools/generate-project.py`,
      );
    }
  });

  it("refuses a version the repository does not hold", () => {
    expect(() => requireRepositoryRelease(root, "1.1", 27, repoFiles())).toThrow(
      "VERSION 1.1 does not match MARKETING_VERSION 1.0",
    );
  });

  it("refuses a generator it cannot read the release from, rather than guessing", () => {
    for (const text of [
      'MARKETING_VERSION = "1.0"\n',
      'CURRENT_PROJECT_VERSION = "27"\n',
      generator("1.0", "twenty-seven"),
      generator("1.0", "0"),
    ]) {
      expect(() => repositoryRelease(root, () => text)).toThrow(
        "no readable MARKETING_VERSION and CURRENT_PROJECT_VERSION",
      );
    }
  });
});

describe("iOS archive gate: a full passing run for these iOS inputs", () => {
  const evidence = {
    source: "abc",
    key: "k",
    summary: "/s.txt",
    result: "/r.xcresult",
    tests: { passed: 700, failed: 0, skipped: 29, expectedFailures: 1 },
  };
  const exec = (
    reply: Partial<{ status: number | null; stdout: string; stderr: string; error: Error }>,
  ) => vi.fn((..._args: unknown[]) => ({ status: 0, stdout: "", stderr: "", ...reply }));

  it("returns the evidence for the receipt, with skips and an expected failure allowed", () => {
    const run = exec({ stdout: JSON.stringify(evidence) });
    expect(requireFullIosValidation(root, run)).toEqual(evidence);
    expect(run).toHaveBeenCalledWith(
      "python3",
      [join(root, ".agents/tools/ios-validation-state.py"), "full-run"],
      root,
    );
  });

  it("relays the tool's reason and names the command that produces a run", () => {
    for (const reason of [
      "No passing iOS validation exists for the current iOS inputs (sha).",
      "Only a partial run (-only-testing or -skip-testing) passed for the current iOS inputs (sha).",
    ]) {
      const refusal = (() => {
        try {
          requireFullIosValidation(root, exec({ status: 1, stderr: reason + "\n" }));
        } catch (error) {
          return (error as Error).message;
        }
      })();
      expect(refusal).toContain(reason);
      expect(refusal).toContain(validateCommand);
    }
  });

  it("refuses when the evidence cannot be read, and says that instead of claiming no run exists", () => {
    for (const reply of [
      { status: 2, stderr: "iOS validation evidence: boom" },
      { status: null },
      { status: 0, error: new Error("spawn python3 ENOENT") },
    ]) {
      expect(() => requireFullIosValidation(root, exec(reply))).toThrow(
        "Could not read the iOS validation evidence",
      );
    }
    expect(() =>
      requireFullIosValidation(root, exec({ status: 2, stderr: "iOS validation evidence: boom" })),
    ).toThrow(validateCommand);
  });

  it("refuses success output that is not usable evidence, or that records a failure", () => {
    for (const stdout of [
      "",
      "not json",
      "{}",
      JSON.stringify({ ...evidence, tests: undefined }),
    ]) {
      expect(() => requireFullIosValidation(root, exec({ stdout }))).toThrow(
        "evidence was unreadable",
      );
    }
    expect(() =>
      requireFullIosValidation(
        root,
        exec({ stdout: JSON.stringify({ ...evidence, tests: { ...evidence.tests, failed: 2 } }) }),
      ),
    ).toThrow("records 2 failing tests");
  });
});

describe("publish-ios archive refuses before it touches the host, credentials or Apple", () => {
  // A copy of the tool in a throwaway repository with no validation records, so no outcome here can
  // reach a signing or App Store Connect step. The copy resolves its repository from its own location.
  const archive = (version: string, build: string, held = "27") => {
    const directory = mkdtempSync(join(tmpdir(), "wildbots-archive-gate-"));
    try {
      mkdirSync(join(directory, ".agents/tools"), { recursive: true });
      mkdirSync(join(directory, "ios/tools"), { recursive: true });
      for (const name of [
        "publish-ios.mjs",
        "apple-api.mjs",
        "ios-release-gate.mjs",
        "ios-validation-state.py",
      ])
        copyFileSync(join(root, ".agents/tools", name), join(directory, ".agents/tools", name));
      writeFileSync(join(directory, "ios/tools/generate-project.py"), generator("1.0", held));
      writeFileSync(join(directory, "ios/Input.swift"), "source");
      spawnSync("git", ["init", "-q", directory]);
      const result = spawnSync(
        process.execPath,
        [join(directory, ".agents/tools/publish-ios.mjs"), "archive", version, build],
        { cwd: directory, encoding: "utf8", timeout: 20000 },
      );
      return { status: result.status, stderr: result.stderr };
    } finally {
      rmSync(directory, { recursive: true });
    }
  };

  it("refuses a build number the repository does not hold", () => {
    const result = archive("1.0", "28");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("BUILD 28 does not match CURRENT_PROJECT_VERSION 27");
  });

  it("refuses when no full validation passed for the iOS inputs, naming the command to run one", () => {
    const result = archive("1.0", "27");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No passing iOS validation exists");
    expect(result.stderr).toContain(validateCommand);
    expect(result.stderr).not.toContain("Mac mini");
  });
});
