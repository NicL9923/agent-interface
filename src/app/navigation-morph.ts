import { flushSync } from "react-dom";
import { prefersReducedMotion } from "./reduced-motion";

/**
 * Phone navigation between home and a chat as one motion: the assistant's avatar flies between
 * its home row and the chat header while the screens slide, using the View Transitions API.
 * Without the API, or with Reduce Motion, the change happens at once as before.
 */
export type MorphDirection = "forward" | "back";
const NAME = "wildbots-avatar";
let current = 0;

type TransitionDocument = Document & { startViewTransition?: (update: () => void) => { finished: Promise<void> } };

const name = (element: Element | null | undefined, value: string) => {
  if (element instanceof HTMLElement) element.style.viewTransitionName = value;
};
/** Only an element on screen can lend its place to the motion. */
function onScreen(element: Element | null | undefined): Element | null {
  const box = element?.getBoundingClientRect();
  return box && box.width > 0 && box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth ? element! : null;
}

export function canMorph() {
  return typeof (document as TransitionDocument).startViewTransition === "function" && !prefersReducedMotion();
}

/** Runs `update`, which changes React state, inside a view transition that moves `from` onto `to`. */
export function morphNavigate(update: () => void, from: () => Element | null, to: () => Element | null, direction: MorphDirection) {
  if (!canMorph()) return update();
  const doc = document as TransitionDocument, root = document.documentElement, run = ++current;
  const source = onScreen(from());
  let target: Element | null = null;
  name(source, NAME);
  root.dataset.navigation = direction;
  const settle = () => {
    name(source, "");
    name(target, "");
    if (run === current) delete root.dataset.navigation;
  };
  try {
    doc.startViewTransition!(() => {
      name(source, "");
      flushSync(update);
      target = source ? onScreen(to()) : null;
      name(target, NAME);
    }).finished.then(settle, settle);
  } catch {
    settle();
    update();
  }
}

export const railAvatar = (botId: string) => () => document.querySelector(`.bot-rail [data-morph="${CSS.escape(botId)}"]`);
export const headerAvatar = () => document.querySelector(".chat-header .chat-identity-avatar");
