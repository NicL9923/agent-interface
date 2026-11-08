import { useEffect } from "react";
import type { Bot } from "../shared/types";
import { isUnread, type ReadThrough } from "./unread";

const APP_NAME = "WildBots";
/** Activity that means an assistant waits on a person: an approval, a question or a secure request. */
const deciding = new Set(["waiting", "blocked"]);

/**
 * The app badge: chats home marks unread, plus assistants waiting on a decision that are not
 * already counted. The server counts the same way for push payloads.
 */
export function badgeCount(bots: readonly Bot[], shownBotId: string | undefined, readThrough: ReadThrough) {
  return bots.filter(bot => isUnread(bot, shownBotId, readThrough) || deciding.has(bot.activity)).length;
}

export function badgeTitle(count: number) {
  return count > 0 ? `(${count > 99 ? "99+" : count}) ${APP_NAME}` : APP_NAME;
}

type BadgingNavigator = Navigator & { setAppBadge?(count?: number): Promise<void>; clearAppBadge?(): Promise<void> };

let plainIcon: string | undefined;
let dotWanted = false;
let dottedIcon: Promise<string | null> | undefined;

/** The tab icon with a dot in its corner, drawn once from the app icon. */
function drawDottedIcon(source: string) {
  return dottedIcon ??= new Promise<string | null>(resolve => {
    const image = new Image();
    image.onload = () => {
      try {
        const size = 64, canvas = document.createElement("canvas");
        canvas.width = canvas.height = size;
        const context = canvas.getContext("2d");
        if (!context) return resolve(null);
        context.drawImage(image, 0, 0, size, size);
        context.beginPath();
        context.arc(size - 14, 14, 13, 0, Math.PI * 2);
        context.fillStyle = "#d4442e";
        context.fill();
        context.lineWidth = 4;
        context.strokeStyle = "#ffffff";
        context.stroke();
        resolve(canvas.toDataURL("image/png"));
      } catch { resolve(null); }
    };
    image.onerror = () => resolve(null);
    image.src = source;
  });
}

/** Keeps the tab title, favicon dot and installed app badge in step with the count. */
export function useAppBadge(count: number) {
  useEffect(() => {
    document.title = badgeTitle(count);
    const badging = navigator as BadgingNavigator;
    if (count > 0) void badging.setAppBadge?.(count).catch(() => {});
    else void badging.clearAppBadge?.().catch(() => {});
    const icons = Array.from(document.querySelectorAll<HTMLLinkElement>("link[rel='icon']"));
    const png = icons.find(link => link.type === "image/png");
    if (!png) return;
    plainIcon ??= png.href;
    // The icon draws once; a count back to zero before it is ready keeps the plain one.
    dotWanted = count > 0;
    if (dotWanted) void drawDottedIcon(plainIcon).then(dotted => {
      if (!dotWanted || !dotted) return;
      png.href = dotted;
      // Browsers prefer the SVG when present; set it aside while the dot shows.
      for (const link of icons) if (link !== png) link.media = "not all";
    });
    else {
      png.href = plainIcon;
      for (const link of icons) if (link !== png) link.removeAttribute("media");
    }
  }, [count]);
}
