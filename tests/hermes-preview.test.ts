import { expect, it } from "vitest";
import { preview } from "../src/server/hermes-mapping";

it("gives home an assistant's latest words without Markdown, as web and iOS show them as plain text", () => {
  expect(preview({ preview: "## WFT COO — audit\n**Role** ready", last_active: 0 })).toEqual({ text: "WFT COO — audit Role ready", at: "1970-01-01T00:00:00.000Z" });
  // A reply that is only code still reads as something rather than an empty row.
  expect(preview({ preview: "```\nls\n```" })?.text).toBe("``` ls ```");
  expect(preview({ preview: "   " })).toBeUndefined();
});
