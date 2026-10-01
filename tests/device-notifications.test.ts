// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { write } from "../src/client-api";
import { useDeviceNotifications } from "../src/components/use-device-notifications";
import { NotificationSettings, NotificationOnboarding } from "../src/components/DeviceNotifications";

vi.mock("../src/client-api", () => ({ write: vi.fn() }));
let container: HTMLDivElement, root: Root;
let notifications: ReturnType<typeof useDeviceNotifications>;
let subscription: PushSubscription | null;
let registered: boolean;
let permission: NotificationPermission;
let requestPermission: ReturnType<typeof vi.fn>;
let unsubscribe: ReturnType<typeof vi.fn>;
let subscribe: ReturnType<typeof vi.fn>;
let worker: ServiceWorkerRegistration;
const endpoint = "https://push.example.invalid/device";
const vapid = "ZmFrZS1wdWJsaWMta2V5";
function Harness({ userId = "one" }: { userId?: string }) {
  notifications = useDeviceNotifications(userId, vapid);
  return createElement("div", {}, createElement(NotificationSettings, { notifications }), createElement(NotificationOnboarding, { notifications }));
}
const render = async (userId = "one") => { await act(async () => root.render(createElement(Harness, { userId }))); };
const toggle = () => container.querySelector<HTMLInputElement>('[role="switch"]')!;
const fakeSubscription = () => ({ endpoint, toJSON: () => ({ endpoint, keys: { auth: "key", p256dh: "key" } }), unsubscribe } as unknown as PushSubscription);
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("PushManager", function() {});
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
  permission = "default"; subscription = null; registered = false;
  requestPermission = vi.fn(async () => { permission = "granted"; return permission; });
  vi.stubGlobal("Notification", { get permission() { return permission; }, requestPermission });
  unsubscribe = vi.fn(async () => { subscription = null; return true; });
  subscribe = vi.fn(async () => { subscription = fakeSubscription(); return subscription; });
  worker = { active: {}, pushManager: { getSubscription: vi.fn(async () => subscription), subscribe } } as unknown as ServiceWorkerRegistration;
  vi.stubGlobal("navigator", { userAgent: "Desktop fixture", platform: "Fixture", maxTouchPoints: 0,
    serviceWorker: { getRegistration: vi.fn(async () => worker), addEventListener: vi.fn(), removeEventListener: vi.fn() } });
  vi.mocked(write).mockReset().mockImplementation(async <T>(path: string, _value: unknown, method?: string) => {
    if (path.endsWith("/status")) return { registered } as T;
    registered = method !== "DELETE";
    return { ok: true } as T;
  });
  localStorage.clear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); localStorage.clear(); vi.unstubAllGlobals(); });

it("asks a new device once without requesting browser permission, including across remounts and account changes", async () => {
  await render();
  expect(container.textContent).toContain("Enable notifications on this device?");
  expect(container.textContent).toContain("Preferences > Notifications");
  expect(requestPermission).not.toHaveBeenCalled();
  await act(async () => container.querySelector<HTMLButtonElement>(".notification-onboarding button:last-child")!.click());
  await render("two");
  expect(container.querySelector(".notification-onboarding")).toBeNull();
  await act(async () => { root.unmount(); root = createRoot(container); root.render(createElement(Harness)); });
  expect(container.querySelector(".notification-onboarding")).toBeNull();
});

it("uses browser permission, subscription and this user's server registration together for a truthful toggle", async () => {
  permission = "granted"; subscription = fakeSubscription(); registered = true;
  await render();
  expect(toggle().checked).toBe(true);
  expect(write).toHaveBeenCalledExactlyOnceWith("/push/subscriptions/status", { endpoint });
  expect(container.querySelector(".notification-onboarding")).toBeNull();
  registered = false;
  await act(async () => notifications.refresh());
  expect(toggle().checked).toBe(false);
  expect(toggle().disabled).toBe(false);
  expect(requestPermission).not.toHaveBeenCalled();
});

it("does not claim enabled when permission is granted but no browser subscription exists", async () => {
  permission = "granted";
  await render();
  expect(toggle().checked).toBe(false);
  expect(write).not.toHaveBeenCalled();
  expect(container.querySelector(".notification-onboarding")).toBeNull();
});

it("requests permission directly from the enable gesture and registers before checking the switch", async () => {
  await render();
  await act(async () => {
    toggle().click();
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(toggle().checked).toBe(false);
  });
  expect(subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: expect.any(Uint8Array) });
  expect(write).toHaveBeenCalledWith("/push/subscriptions", expect.objectContaining({ endpoint }));
  expect(toggle().checked).toBe(true);
  expect(container.querySelector(".notification-onboarding")).toBeNull();
});

it("respects denied permission and explains how to unblock it without asking again", async () => {
  permission = "denied";
  await render();
  expect(toggle().checked).toBe(false); expect(toggle().disabled).toBe(true);
  expect(container.textContent).toContain("browser or device settings");
  expect(container.querySelector(".notification-onboarding")).toBeNull();
  expect(requestPermission).not.toHaveBeenCalled();
});

it("keeps the switch off when the user declines the permission request", async () => {
  requestPermission.mockImplementationOnce(async () => { permission = "denied"; return permission; });
  await render();
  await act(async () => toggle().click());
  expect(toggle().checked).toBe(false); expect(toggle().disabled).toBe(true);
  expect(subscribe).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
});

it("cleans up a newly created browser subscription after failed registration", async () => {
  await render();
  vi.mocked(write).mockRejectedValueOnce(new Error("Registration failed"));
  await act(async () => toggle().click());
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(toggle().checked).toBe(false);
  expect(container.textContent).toContain("Registration failed");
  expect(toggle().disabled).toBe(false);
});

it("preserves an existing subscription when another account owns its server registration", async () => {
  permission = "granted"; subscription = fakeSubscription();
  await render();
  vi.mocked(write).mockRejectedValueOnce(new Error("This subscription belongs to another household member"));
  await act(async () => toggle().click());
  expect(unsubscribe).not.toHaveBeenCalled(); expect(subscribe).not.toHaveBeenCalled();
  expect(toggle().checked).toBe(false);
  expect(container.textContent).toContain("another household member");
});

it("removes the server registration before unsubscribing the browser", async () => {
  permission = "granted"; subscription = fakeSubscription(); registered = true;
  await render();
  unsubscribe.mockImplementationOnce(async () => { expect(registered).toBe(false); subscription = null; return true; });
  await act(async () => toggle().click());
  expect(write).toHaveBeenLastCalledWith("/push/subscriptions", { endpoint }, "DELETE");
  expect(toggle().checked).toBe(false); expect(unsubscribe).toHaveBeenCalledOnce();
});

it("shows disabled after server removal even when the browser fails to unsubscribe", async () => {
  permission = "granted"; subscription = fakeSubscription(); registered = true;
  await render();
  unsubscribe.mockResolvedValueOnce(false);
  await act(async () => toggle().click());
  expect(registered).toBe(false); expect(toggle().checked).toBe(false);
  expect(container.textContent).toContain("browser couldn't remove its subscription");
});

it("keeps enabled and explains a failed server removal without orphaning a browser subscription", async () => {
  permission = "granted"; subscription = fakeSubscription(); registered = true;
  await render();
  vi.mocked(write).mockRejectedValueOnce(new Error("Couldn't remove registration"));
  await act(async () => toggle().click());
  expect(toggle().checked).toBe(true); expect(unsubscribe).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Couldn't remove registration");
});

it("rechecks an uncertain server removal before claiming this device is still enabled", async () => {
  permission = "granted"; subscription = fakeSubscription(); registered = true;
  await render();
  vi.mocked(write).mockImplementationOnce(async () => { registered = false; throw new Error("Response lost"); });
  await act(async () => toggle().click());
  expect(write).toHaveBeenLastCalledWith("/push/subscriptions/status", { endpoint });
  expect(toggle().checked).toBe(false); expect(unsubscribe).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Response lost");
});

it("explains the iPhone installation step and leaves notification permission untouched", async () => {
  vi.stubGlobal("navigator", { userAgent: "iPhone", platform: "iPhone", maxTouchPoints: 5 });
  await render();
  expect(toggle().disabled).toBe(true);
  expect(container.textContent).toContain("Share > Add to Home Screen");
  expect(requestPermission).not.toHaveBeenCalled();
});

it("refreshes the new account after a pending permission operation settles without registering to the wrong user", async () => {
  let finish!: (permission: NotificationPermission) => void;
  requestPermission.mockReturnValueOnce(new Promise<NotificationPermission>((resolve) => { finish = resolve; }));
  await render();
  await act(async () => toggle().click());
  expect(notifications.busy).toBe(true);
  await render("two");
  expect(notifications.checking).toBe(true);
  await act(async () => { permission = "granted"; finish("granted"); });
  expect(notifications.checking).toBe(false);
  expect(toggle().disabled).toBe(false); expect(toggle().checked).toBe(false);
  expect(subscribe).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
});
