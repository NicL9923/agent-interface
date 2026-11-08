// @vitest-environment jsdom
import { act, createElement, useRef } from "react";
import { expect, it, vi } from "vitest";
import { useSubmission } from "../src/app/use-submission";
import { request } from "../src/client-api";
import { mountRoot } from "./ui-harness";
import type { SubmissionReceipt } from "../src/shared/types";

vi.mock("../src/client-api", async original => ({ ...await original<object>(), request: vi.fn() }));

it("tracks two assistants independently and ignores an earlier send finishing during a later one", async () => {
  const completions = new Map<string, (receipt: SubmissionReceipt) => void>();
  vi.mocked(request).mockImplementation((route, options) => {
    if (route === "POST /bots/:id/messages") return new Promise(resolve => {
      const body = options!.body as unknown as { requestId: string; botId: string };
      completions.set(body.botId, receipt => resolve({ ...receipt, requestId: body.requestId } as never));
    }) as never;
    return Promise.resolve({ status: "uncertain" }) as never;
  });
  let submission!: ReturnType<typeof useSubmission>;
  const errors = vi.fn();
  function Harness({ botId }: { botId: string }) {
    const identityEpoch = useRef(0);
    submission = useSubmission({ botId, userId: "one", identityEpoch,
      draft: { botId, userId: "one", text: "Hello", attachments: [] }, setDraft: vi.fn(),
      draftReady: true, reviewed: false, connectionLost: false, setError: errors });
    return null;
  }
  const ui = mountRoot();
  await ui.render(createElement(Harness, { botId: "a" }));
  let a!: Promise<void>, b!: Promise<void>;
  await act(async () => { a = submission.send(); });
  expect(submission.sending).toBe(true);
  await ui.render(createElement(Harness, { botId: "b" }));
  expect(submission.sending).toBe(false);
  expect(submission.pending).toBeNull();
  await act(async () => { b = submission.send(); });
  expect(submission.sending).toBe(true);
  await act(async () => { completions.get("a")!({ requestId: "", status: "accepted" }); await a; });
  expect(submission.sending).toBe(true);
  expect(submission.pending?.botId).toBe("b");
  await act(async () => { completions.get("b")!({ requestId: "", status: "accepted" }); await b; });
  expect(submission.sending).toBe(false);
  expect(submission.pending).toBeNull();
  expect(errors.mock.calls.filter(([message]) => message)).toEqual([]);
});
