import { cloneElement, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ComponentProps, ComponentType, KeyboardEvent, MouseEvent, ReactElement, TouchEvent } from "react";
import type { BotMenuProps } from "./BotMenuPopup";

/*
 * The popup library stays off the path to first paint. Until it has loaded, a row wears a
 * lightweight stand-in that catches the right click, menu key or long press itself, loads the
 * menu, and hands it the position, so even the first gesture opens it where it happened.
 * Once the library has loaded (normally right after first paint) every row swaps to the real
 * menu trigger, which then handles touch and mouse exactly as it always has.
 */
type Popup = ComponentType<BotMenuProps>;
let loading: Promise<Popup> | undefined;
let loaded: Popup | undefined;
let scheduled = false;
// A swap replaces the row under a finger, which would orphan the touch, so it waits for the lift.
let touches = 0;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const ready = () => touches ? undefined : loaded;
const touchStarted = () => { touches++; };
const touchEnded = () => { touches--; if (!touches) notify(); };

/** Starts loading the menu once; a failed load can be tried again by the next gesture. */
export function preloadBotMenu() {
  return loading ??= import("./BotMenuPopup").then(module => { loaded = module.BotMenuPopup; notify(); return loaded; }, error => {
    loading = undefined;
    throw error;
  });
}

/** Loads the menu after first paint, so most first gestures find it ready. */
function preloadWhenIdle() {
  if (scheduled || loading) return;
  scheduled = true;
  const run = () => { preloadBotMenu().catch(() => {}); };
  if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 5000 });
  else setTimeout(run, 2000);
}

// The real trigger's long press, so both feel the same.
const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE = 10;
// After a lift the browser sends the tap's click right away; the swap waits that out.
const CLICK_GRACE_MS = 100;
type Point = { x: number; y: number };

export function BotMenu({ children, ...props }: Omit<BotMenuProps, "opensAt" | "restoreFocus">) {
  const [opened, setOpened] = useState<{ Popup: Popup; at: Point } | null>(null);
  const swapped = useSyncExternalStore(subscribe, ready, ready);
  const press = useRef<{ at: Point; timer: ReturnType<typeof setTimeout>; fired: boolean } | null>(null);
  const suppressTouchClick = useRef(false);
  const row = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef<boolean | null>(null);
  const holding = useRef(false);
  const settle = useRef<ReturnType<typeof setTimeout>>(undefined);
  const mounted = useRef(false);
  const cancelPress = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };
  useEffect(() => {
    mounted.current = true;
    preloadWhenIdle();
    return () => {
      mounted.current = false;
      cancelPress();
      release();
    };
  }, []);
  const release = () => {
    clearTimeout(settle.current);
    if (!holding.current) return;
    holding.current = false;
    touchEnded();
  };
  const open = (at: Point) => {
    const show = (Popup: Popup) => {
      if (!mounted.current) return;
      release();
      setOpened(current => current ?? { Popup, at });
    };
    if (loaded) show(loaded);
    else preloadBotMenu().then(show, () => {});
  };

  const Popup = opened?.Popup ?? swapped;
  if (Popup) {
    // A row focused when it is swapped keeps its focus, unless the menu is opening and takes it.
    restoreFocus.current ??= !opened && !!row.current && row.current === document.activeElement;
    return <Popup {...props} opensAt={opened?.at} restoreFocus={restoreFocus.current}>{children}</Popup>;
  }

  const child = children as ReactElement<ComponentProps<"button">>;
  const lift = () => {
    const pressed = press.current;
    cancelPress();
    if (!holding.current) return;
    // Neither the swap nor the menu replaces the row until the tap's click has come and gone.
    clearTimeout(settle.current);
    settle.current = setTimeout(() => {
      release();
      if (pressed?.fired) open(pressed.at);
    }, CLICK_GRACE_MS);
  };
  return cloneElement(child, {
    ref: row,
    // The browser's own menu must never win, even while the real one is still loading.
    onContextMenu: (event: MouseEvent) => { event.preventDefault(); open({ x: event.clientX, y: event.clientY }); },
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
      event.preventDefault();
      open({ x: 0, y: 0 });
    },
    onTouchStart: (event: TouchEvent) => {
      suppressTouchClick.current = false;
      cancelPress();
      clearTimeout(settle.current);
      if (!holding.current) { holding.current = true; touchStarted(); }
      preloadBotMenu().catch(() => {});
      if (event.touches.length !== 1) return;
      const at = { x: event.touches[0].clientX, y: event.touches[0].clientY };
      const started = { at, fired: false, timer: setTimeout(() => { started.fired = true; suppressTouchClick.current = true; }, LONG_PRESS_MS) };
      press.current = started;
    },
    onTouchMove: (event: TouchEvent) => {
      const started = press.current;
      if (!started || started.fired) return;
      const touch = event.touches[0];
      if (event.touches.length !== 1 || Math.abs(touch.clientX - started.at.x) > MOVE_TOLERANCE || Math.abs(touch.clientY - started.at.y) > MOVE_TOLERANCE) cancelPress();
    },
    onTouchEnd: lift,
    onTouchCancel: lift,
    // The lift that ends a long press must not also select the row.
    onClickCapture: (event: MouseEvent) => {
      if (!suppressTouchClick.current) return;
      event.preventDefault(); event.stopPropagation(); suppressTouchClick.current = false;
    },
    style: { WebkitTouchCallout: "none", ...child.props.style },
  });
}
