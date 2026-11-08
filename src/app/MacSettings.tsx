import { useCallback, useEffect, useState } from "react";
import { request } from "../client-api";
import { SettingsConfirmation } from "../components/SettingsConfirmation";
import { Button } from "../components/ui/button";
import type { LinkedMac } from "../shared/mac";
import { formatWhen } from "../time";

/** Where a Mac stands, in a few words. */
export function macStatus(mac: LinkedMac, now = Date.now()) {
  if (mac.online && mac.state?.paused) return "Online · assistants paused";
  if (mac.online) return mac.state?.screenLocked ? "Online · screen locked" : "Online";
  return mac.lastSeenAt ? `Offline · last seen ${formatWhen(mac.lastSeenAt, { now, inline: true })}` : "Never connected";
}

/**
 * The person's Macs linked with WildBots for Mac, each with Revoke. Hidden while the server has
 * Mac links turned off, and while the list cannot be read: Settings stays usable either way.
 */
export function MacSettings() {
  const [macs, setMacs] = useState<LinkedMac[] | null>(null);
  const [revoking, setRevoking] = useState<LinkedMac | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const listed = await request("GET /mac/devices");
      setMacs(listed.available ? listed.devices : null);
    } catch {
      setMacs(current => current);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (!macs) return null;
  const revoke = async (mac: LinkedMac) => {
    setBusy(true);
    setError("");
    try {
      await request("DELETE /mac/devices/:id", { params: { id: mac.id } });
      setMacs(current => current?.filter(candidate => candidate.id !== mac.id) ?? null);
      setRevoking(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The Mac could not be unlinked. Try again.");
      setRevoking(null);
      void load();
    } finally {
      setBusy(false);
    }
  };
  return <>
    <h3 className="settings-heading">Macs</h3>
    <div className="settings-group" role="group" aria-label="Linked Macs">
      {macs.length === 0
        ? <div className="settings-row"><span className="row-text"><span className="row-label">No Macs linked</span>
          <small>Link one with WildBots for Mac so your personal assistants can work on it.</small></span></div>
        : macs.map(mac => <div className="settings-row" key={mac.id}>
          <span className="row-text"><span className="row-label">{mac.name}</span><small>{macStatus(mac)}</small></span>
          <Button type="button" className="danger" id={`revoke-${mac.id}`} onClick={() => setRevoking(mac)}>Revoke</Button>
        </div>)}
    </div>
    {error && <p className="settings-footnote" role="alert">{error}</p>}
    <p className="settings-footnote">Only your personal assistants can use your Macs, and only as each Mac allows.</p>
    {revoking && <SettingsConfirmation title={`Revoke ${revoking.name}?`}
      detail="It disconnects at once, stops what assistants are running there and must be linked again to be used."
      confirmLabel="Revoke" cancelLabel="Keep linked" danger busy={busy} fallbackFocus="#settings-title"
      onCancel={() => setRevoking(null)} onConfirm={() => void revoke(revoking)} />}
  </>;
}
