import { describe, expect, it, vi } from "vitest";
import { createModelNames, formatModelSlugName } from "../src/server/model-names.js";

describe("formatModelSlugName", () => {
  it.each([
    ["claude-opus-5-5", "Claude Opus 5.5"],
    ["claude-sonnet-5-5", "Claude Sonnet 5.5"],
    ["claude-haiku-5-5-20261001", "Claude Haiku 5.5 20261001"],
    ["anthropic/claude-opus-5-5", "anthropic/Claude Opus 5.5"],
    ["gpt-6.1-terra", "GPT-6.1-Terra"],
    ["openai/gpt-6-luna", "openai/GPT-6-Luna"],
    ["gemini-3-pro", "Gemini 3 Pro"],
    ["grok-4-7", "Grok 4 7"],
    // Other families are the provider's own names, so they stay as they are.
    ["llama3.1:8b", "llama3.1:8b"],
    ["house-model-7", "house-model-7"],
    ["Inherited", "Inherited"],
  ])("%s reads as %s", (slug, name) => expect(formatModelSlugName(slug)).toBe(name));
});

describe("createModelNames", () => {
  const opus = { provider: "anthropic", model: "claude-opus-5-5" };
  it("asks once for what it lacks, keeps the answer, and falls back to the formatter for null", async () => {
    const ask = vi.fn(async (models: typeof opus[]) => models.map(model => ({ ...model, name: model.provider === "anthropic" ? " Claude Opus 5.5 (latest) " : null })));
    const names = createModelNames(() => ask);
    const house = { provider: "house", model: "gpt-6.1-terra" };
    expect(names.name(opus)).toBe("Claude Opus 5.5");
    await names.load([opus, opus, house]);
    await names.load([opus, house]);
    expect(ask).toHaveBeenCalledOnce();
    expect(ask).toHaveBeenCalledWith([opus, house]);
    expect(names.name(opus)).toBe("Claude Opus 5.5 (latest)");
    expect(names.name(house)).toBe("GPT-6.1-Terra");
  });
  it("shares one request between overlapping loads and never asks for a model without a provider", async () => {
    let answer!: (rows: { provider: string; model: string; name: string | null }[]) => void;
    const ask = vi.fn(() => new Promise<{ provider: string; model: string; name: string | null }[]>(done => { answer = done; }));
    const names = createModelNames(() => ask);
    const first = names.load([opus, { model: "gpt-6.1-terra" }]);
    const second = names.load([opus]);
    answer([{ ...opus, name: "Opus" }]);
    await Promise.all([first, second]);
    expect(ask).toHaveBeenCalledOnce();
    expect(ask).toHaveBeenCalledWith([opus]);
    expect(names.name(opus)).toBe("Opus");
    expect(names.name({ model: "gpt-6.1-terra" })).toBe("GPT-6.1-Terra");
  });
  it("shows the formatted name when the add-on fails, and asks again after a minute", async () => {
    let time = 0;
    const ask = vi.fn().mockRejectedValueOnce(new Error("Unknown experience operation.")).mockResolvedValue([{ ...opus, name: "Opus" }]);
    const names = createModelNames(() => ask, () => time);
    await names.load([opus]);
    expect(names.name(opus)).toBe("Claude Opus 5.5");
    await names.load([opus]);
    expect(ask).toHaveBeenCalledOnce();
    time = 61_000;
    await names.load([opus]);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(names.name(opus)).toBe("Opus");
  });
  it("only formats when there is no lookup at all", async () => {
    const names = createModelNames(undefined);
    await names.load([opus]);
    expect(names.name(opus)).toBe("Claude Opus 5.5");
  });
});
