import type { Page } from "@playwright/test";
import {
  assistants,
  enableFullHermes,
  expect,
  failUploads,
  type AllowedConsoleError,
} from "./fixtures.js";

/** One state of a screen, reached from the step before it in the same page. */
export interface Step {
  /** Names the state in a failure. */
  name: string;
  reach: (page: Page) => Promise<void>;
  /**
   * False reads the state at rest only. For a step whose controls are the ones a step before it already read
   * hovered, focused and pressed, and whose own rules hang on no control state.
   */
  states?: false;
}
/** A screen the cascade guard reads in several states, and what it needs before sign-in. */
export interface StatefulScreen {
  name: string;
  before?: (page: Page) => Promise<void>;
  steps: Step[];
  /** Console errors the screen's own failure logs, such as the browser reporting a refused request. */
  allowConsoleError?: AllowedConsoleError[];
}

const openChat = async (page: Page) => {
  await assistants(page)
    .getByRole("button", { name: /Ranch Hand/ })
    .click();
  await page.getByText("Which gate first?").waitFor();
};

/**
 * The microphone and the WebRTC link to OpenAI, the two edges a live Talk crosses, as tests/talk-ui.test.ts fakes
 * them: a microphone with one audio track, and a peer connection whose data channel the test speaks for, sending
 * the Realtime events the voice service would. The app's Talk code, from use-talk.ts to TalkLoop, runs as it is.
 */
async function fakeVoiceService(page: Page) {
  await page.addInitScript(() => {
    const track = { kind: "audio", enabled: true, stop() {} };
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => stream },
    });
    class Channel {
      readyState = "connecting";
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      send() {}
      close() {
        this.readyState = "closed";
      }
    }
    const voice = { channel: undefined as Channel | undefined, answered: false };
    class Peer {
      connectionState = "new";
      ontrack = null;
      onconnectionstatechange = null;
      addTrack() {}
      close() {}
      createDataChannel() {
        return (voice.channel = new Channel());
      }
      async createOffer() {
        return { type: "offer", sdp: "v=0\r\n" };
      }
      async setLocalDescription() {}
      async setRemoteDescription() {
        voice.answered = true;
      }
    }
    Object.assign(window, { RTCPeerConnection: Peer, voice });
  });
  await page.route("https://api.openai.com/v1/realtime/calls", (route) =>
    route.fulfill({
      status: route.request().method() === "OPTIONS" ? 204 : 201,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "authorization, content-type",
        "content-type": "application/sdp",
      },
      body: route.request().method() === "OPTIONS" ? "" : "v=0\r\n",
    }),
  );
}
/** Opens the data channel, then delivers each Realtime server event to the app. */
const voiceSays = (page: Page, ...events: Record<string, unknown>[]) =>
  page.evaluate((events) => {
    const { channel } = (
      window as unknown as {
        voice: {
          channel: {
            readyState: string;
            onopen: () => void;
            onmessage: (event: { data: string }) => void;
          };
        };
      }
    ).voice;
    if (channel.readyState !== "open") {
      channel.readyState = "open";
      channel.onopen();
    }
    for (const event of events) channel.onmessage({ data: JSON.stringify(event) });
  }, events);
const talk = (page: Page) => page.getByRole("region", { name: "Live talk with Ranch Hand" });

/** Opens the Ranch Hand's settings from its menu, on a section when one is named. */
async function openSettings(page: Page, section?: string) {
  await assistants(page)
    .getByRole("button", { name: /Ranch Hand/ })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: /Assistant settings/ }).click();
  await page
    .locator(".settings-dialog[open] .settings-content:not(.settings-load-state)")
    .waitFor();
  if (section)
    await page
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name: new RegExp(`^${section}`) })
      .click();
}
// A one-pixel PNG, which every browser decodes, so the photo reaches its upload.
const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

export const STATEFUL: StatefulScreen[] = [
  {
    name: "Talk",
    before: async (page) => {
      await enableFullHermes();
      await fakeVoiceService(page);
    },
    steps: [
      {
        name: "connecting",
        states: false,
        reach: async (page) => {
          await openChat(page);
          await page.getByRole("button", { name: "Talk live with Ranch Hand" }).click();
          await expect
            .poll(() =>
              page.evaluate(
                () => (window as unknown as { voice: { answered: boolean } }).voice.answered,
              ),
            )
            .toBe(true);
          await expect(talk(page).getByRole("status")).toHaveText("Connecting…");
          await expect(page.getByRole("button", { name: "Mute microphone" })).toBeDisabled();
        },
      },
      {
        name: "listening, muted, with captions and a problem",
        reach: async (page) => {
          await voiceSays(
            page,
            { type: "input_audio_buffer.speech_started" },
            {
              type: "conversation.item.input_audio_transcription.completed",
              transcript: "Is the north gate shut?",
            },
            { type: "response.created" },
            { type: "response.output_audio_transcript.delta", delta: "It is shut and latched." },
            {
              type: "response.output_audio_transcript.done",
              transcript: "It is shut and latched.",
            },
            { type: "response.done" },
            { type: "error", error: { message: "The voice service is busy. Talk keeps going." } },
          );
          await page.getByRole("button", { name: "Mute microphone" }).click();
          await expect(talk(page).getByRole("status")).toHaveText("Listening · muted");
          await expect(talk(page).locator(".talk-captions")).toContainText(
            "Is the north gate shut?",
          );
          await expect(talk(page).locator(".talk-captions")).toContainText(
            "It is shut and latched.",
          );
          await expect(talk(page).getByRole("alert")).toHaveText(
            "The voice service is busy. Talk keeps going.",
          );
          await expect(
            page.getByRole("button", { name: "Talk live with Ranch Hand" }),
          ).toHaveAttribute("aria-pressed", "true");
        },
      },
      {
        name: "speaking",
        states: false,
        reach: async (page) => {
          await voiceSays(page, {
            type: "response.output_audio_transcript.delta",
            delta: "The south one too.",
          });
          await expect(talk(page)).toHaveAttribute("data-talk-status", "speaking");
        },
      },
      {
        name: "thinking",
        states: false,
        reach: async (page) => {
          await voiceSays(page, { type: "response.done" }, { type: "response.created" });
          await expect(talk(page)).toHaveAttribute("data-talk-status", "thinking");
        },
      },
      {
        name: "ended when the connection closed",
        reach: async (page) => {
          await page.evaluate(() =>
            (
              window as unknown as { voice: { channel: { onclose: () => void } } }
            ).voice.channel.onclose(),
          );
          await expect(page.locator(".talk-panel.talk-message.talk-error")).toHaveText(
            "The voice connection closed. Start Talk again.",
          );
          await expect(
            page.getByRole("button", { name: "Talk live with Ranch Hand" }),
          ).toHaveAttribute("aria-pressed", "false");
        },
      },
    ],
  },
  {
    name: "a failed upload",
    // The browser logs each upload Hermes refuses as a failed resource. Nothing else is excused.
    allowConsoleError: [{ text: /status of 507/, url: /\/api\/bots\/ranch\/uploads$/ }],
    before: async () => {
      await failUploads();
    },
    steps: [
      {
        name: "a photo and a file that did not upload, and a photo refused before upload",
        reach: async (page) => {
          await openChat(page);
          await page.locator('.composer input[type="file"]').setInputFiles([
            { name: "gate.png", mimeType: "image/png", buffer: pixel },
            { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("Post two.\n") },
            { name: "IMG_0003.HEIC", mimeType: "image/heic", buffer: Buffer.from("not a picture") },
          ]);
          await expect(page.locator(".attachment-failed")).toHaveCount(2);
          await expect(page.locator(".attachment-error")).toHaveCount(2);
          await expect(page.locator(".attachment-notice")).toContainText("IMG_0003.HEIC");
          await expect(page.locator(".attachment-image .attachment-retry")).toBeVisible();
        },
      },
    ],
  },
  {
    name: "assistant details",
    before: async () => {
      await enableFullHermes();
    },
    steps: [
      {
        // The Trail Cook streams "Echo: …" back and leaves its turn running, so its details show what it is doing.
        name: "while the assistant works",
        states: false,
        reach: async (page) => {
          await assistants(page)
            .getByRole("button", { name: /Trail Cook/ })
            .click();
          await page
            .getByRole("textbox", { name: "Message Trail Cook" })
            .fill("Echo: Checking the pantry");
          await page.getByRole("button", { name: "Send message" }).click();
          await page.getByText("Checking the pantry").last().waitFor();
          await page.locator(".chat-identity").click();
          await page.locator(".bot-details[open] .bot-activity").waitFor();
        },
      },
      {
        name: "pinned, followed, and a new section with no name",
        reach: async (page) => {
          const details = page.locator(".bot-details[open]");
          await details.getByRole("button", { name: "Pin" }).click();
          await expect(details.getByRole("button", { name: "Unpin" })).toHaveAttribute(
            "aria-pressed",
            "true",
          );
          await details.getByRole("switch", { name: /Notify me about all activity/ }).check();
          await details
            .getByRole("combobox", { name: "Home section" })
            .selectOption("New section…");
          await details.getByRole("button", { name: "Add" }).click();
          await expect(details.getByRole("textbox", { name: "New section name" })).toHaveAttribute(
            "aria-invalid",
            "true",
          );
        },
      },
    ],
  },
  {
    name: "automation",
    before: async () => {
      await enableFullHermes();
    },
    steps: [
      {
        name: "",
        reach: async (page) => {
          await openSettings(page, "Automation");
          await page.locator(".routine-card").first().waitFor();
        },
      },
      {
        name: "delete confirmation and edit form open",
        reach: async (page) => {
          const settings = page.locator(".settings-dialog[open]");
          const feed = settings.locator(".routine-card", { hasText: "Feed inventory" });
          await feed.getByRole("button", { name: "Delete" }).click();
          await feed.getByRole("button", { name: "Confirm delete" }).waitFor();
          await settings
            .locator(".routine-card", { hasText: "Fence check" })
            .getByRole("button", { name: "Edit" })
            .click();
          await settings.locator(".routine-schedule").waitFor();
        },
      },
    ],
  },
  {
    name: "routines",
    before: async () => {
      await enableFullHermes();
    },
    steps: [
      {
        name: "runs in the chat",
        reach: async (page) => {
          await openChat(page);
          await expect(page.locator(".routine-run")).toHaveCount(4);
        },
      },
      {
        name: "a failed run open",
        reach: async (page) => {
          const failed = page.locator(".routine-run.run-failed");
          await failed.locator(".routine-run-summary").click();
          await failed.getByRole("button", { name: "All results" }).waitFor();
          await expect(failed.getByRole("button", { name: "Save output" })).toBeEnabled();
        },
      },
      {
        name: "its results",
        reach: async (page) => {
          await page
            .locator(".routine-run.run-failed")
            .getByRole("button", { name: "All results" })
            .click();
          await page.locator(".routine-results-dialog[open] .routine-output").waitFor();
        },
      },
    ],
  },
  {
    name: "the model selector",
    before: async () => {
      await enableFullHermes();
    },
    steps: [
      {
        name: "open in settings, with a favorite and an unavailable model",
        reach: async (page) => {
          await openSettings(page, "Behavior");
          await page.locator(".model-picker > summary").click();
          await page.locator(".model-picker[open]").waitFor();
          await page.getByRole("button", { name: "Add GPT-5.5 mini to favorites" }).click();
          await page.locator(".model-favorites").waitFor();
          await expect(page.locator('.model-choice[data-unavailable="true"]')).toBeDisabled();
        },
      },
      {
        name: "a search with no match",
        states: false,
        reach: async (page) => {
          await page.getByRole("searchbox", { name: "Search models" }).fill("zzz");
          await page.getByText("No models match your search.").waitFor();
        },
      },
      {
        name: "in the chat header",
        reach: async (page) => {
          await page.getByRole("button", { name: "Close assistant settings" }).click();
          await page.locator(".settings-dialog[open]").waitFor({ state: "detached" });
          await page.getByRole("button", { name: "Account" }).click();
          await page
            .getByRole("menu", { name: "Account" })
            .getByRole("menuitem", { name: /Settings/ })
            .click();
          await page.getByRole("switch", { name: /Advanced details/ }).check();
          await page.getByRole("button", { name: "Close settings" }).click();
          await page.locator(".settings-sheet[open]").waitFor({ state: "detached" });
          await openChat(page);
          await page.getByRole("button", { name: /^Model: GPT-5\.5\./ }).click();
          // The inference controls load after the popover opens, and the read must not start before them.
          const popover = page.locator(".model-popover");
          for (const control of ["Reasoning", "Speed"])
            await expect(popover.getByRole("radiogroup", { name: control })).toBeVisible();
          await expect(popover.getByRole("radio", { checked: true })).toHaveCount(2);
          await expect(popover.locator('.model-choice[aria-pressed="true"]')).toBeVisible();
        },
      },
    ],
  },
  {
    name: "the avatar editor",
    before: async () => {
      await enableFullHermes();
    },
    steps: [
      {
        name: "a chosen shape in a custom color with tuned eyes",
        reach: async (page) => {
          await openSettings(page, "Profile");
          const editor = page.locator(".avatar-editor");
          await editor.getByText("Fox", { exact: true }).click();
          await expect(editor.getByRole("radio", { name: "Fox" })).toBeChecked();
          await editor.locator('input[type="color"]').fill("#3a7d44");
          await editor.getByRole("slider", { name: /Eye width/ }).press("ArrowRight");
          await editor.getByRole("button", { name: "Reset eyes" }).waitFor();
          await expect(editor.locator(".swatch-custom")).toHaveAttribute("data-selected", "true");
        },
      },
      {
        name: "a portrait with a prompt over its limit",
        reach: async (page) => {
          const editor = page.locator(".avatar-editor");
          await editor.getByText("Portrait", { exact: true }).click();
          await page
            .getByRole("textbox", { name: "Describe a portrait" })
            .fill("A cowhand ".repeat(201));
          await expect(page.locator(".portrait-prompt-limit")).toHaveAttribute(
            "data-invalid",
            "true",
          );
        },
      },
      {
        name: "a new assistant's look, previewing a state",
        reach: async (page) => {
          await page.getByRole("button", { name: "Close assistant settings" }).click();
          await page.getByRole("button", { name: "Discard changes" }).click();
          await page.locator(".settings-dialog[open]").waitFor({ state: "detached" });
          await page.getByRole("button", { name: /^New/ }).first().click();
          const item = page.getByRole("menuitem", { name: "New assistant" });
          if (await item.isVisible()) await item.click();
          const stage = page.locator(".avatar-stage-states");
          await stage.getByRole("button", { name: "Thinking" }).click();
          await expect(stage.getByRole("button", { name: "Thinking" })).toHaveAttribute(
            "aria-pressed",
            "true",
          );
        },
      },
    ],
  },
];
