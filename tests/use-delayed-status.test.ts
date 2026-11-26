// @vitest-environment jsdom
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDelayedStatus } from "../src/app/use-delayed-status";
import { advance, mountRoot, type Mount } from "./ui-harness";

let mount: Mount;

beforeEach(() => {
  vi.useFakeTimers();
  mount = mountRoot();
});

function Probe({
  active,
  delayMs,
  minHoldMs,
}: {
  active: boolean;
  delayMs?: number;
  minHoldMs?: number;
}) {
  const shown = useDelayedStatus(active, delayMs, minHoldMs);
  return createElement("span", { id: "status" }, shown ? "shown" : "hidden");
}

const text = () => mount.container.querySelector("#status")?.textContent;

describe("useDelayedStatus", () => {
  it("never flashes when active clears before delayMs", async () => {
    await mount.render(createElement(Probe, { active: true }));
    expect(text()).toBe("hidden");
    await advance(149);
    expect(text()).toBe("hidden");
    await mount.render(createElement(Probe, { active: false }));
    await advance(500);
    expect(text()).toBe("hidden");
  });

  it("shows after delayMs and holds for at least minHoldMs once shown", async () => {
    await mount.render(createElement(Probe, { active: true }));
    await advance(150);
    expect(text()).toBe("shown");
    // Cleared 50 ms after appearing: holds for the remaining 200 ms.
    await advance(50);
    await mount.render(createElement(Probe, { active: false }));
    expect(text()).toBe("shown");
    await advance(199);
    expect(text()).toBe("shown");
    await advance(1);
    expect(text()).toBe("hidden");
  });

  it("hides immediately once active clears after minHoldMs has already elapsed", async () => {
    await mount.render(createElement(Probe, { active: true }));
    await advance(150 + 300);
    expect(text()).toBe("shown");
    await mount.render(createElement(Probe, { active: false }));
    expect(text()).toBe("hidden");
  });

  it("stays shown if active turns back on during the hold window", async () => {
    await mount.render(createElement(Probe, { active: true }));
    await advance(150);
    expect(text()).toBe("shown");
    await mount.render(createElement(Probe, { active: false }));
    await advance(100);
    expect(text()).toBe("shown");
    await mount.render(createElement(Probe, { active: true }));
    await advance(500);
    expect(text()).toBe("shown");
  });
});
