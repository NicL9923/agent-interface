import { useRef, useState } from "react";
import { Dialog } from "./ui/dialog";
import { Button } from "./ui/button";
import { FormMessage } from "./ui/form-message";
import { Icon } from "./Icon";
import { ProviderIcon } from "./ProviderIcon";
import { SettingsConfirmation } from "./SettingsConfirmation";
import { When, useMinute } from "./When";
import { request } from "../client-api";
import { routeUrl } from "../shared/api";
import { useAction } from "../app/use-action";
import { useResource } from "../app/use-resource";
import type { Bot } from "../shared/types";
import type { UsageAccount, UsageWindow } from "../shared/account-usage";
import { accountName, resetOutcomeMessage, resetPhrase, resetWouldBeWasted, usageLevel } from "../shared/account-usage";
import "./usage.css";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Plan limits and credits for the accounts behind the assistants this person can see. */
export function UsagePanel({ bots, onClose }: { bots: Bot[]; onClose(): void }) {
  const usage = useResource(routeUrl("GET /usage/accounts", {}), { load: (_, signal) => request("GET /usage/accounts", { signal }) });
  const refreshing = useAction();
  const [outcome, setOutcome] = useState<{ key: string; text: string } | null>(null);
  const refresh = () => refreshing.run(async ({ current }) => {
    const next = await request("GET /usage/accounts", { query: { refresh: "1" } });
    if (current()) usage.setData(next);
  });
  const replace = (account: UsageAccount) => usage.setData(data => data && { ...data, accounts: data.accounts.map(row => row.key === account.key ? account : row) });
  const accounts = usage.data?.accounts ?? [];
  const newest = accounts.map(row => row.fetchedAt).sort().at(-1);
  const name = (id: string) => bots.find(bot => bot.id === id)?.name;
  return <Dialog className="usage-panel" aria-labelledby="usage-title" onCancel={onClose} onClose={onClose}>
    <header className="usage-header"><div><p className="eyebrow">Your household's accounts</p><h2 id="usage-title">Usage</h2></div>
      <Button className="icon-button" aria-label="Close usage" onClick={onClose}><Icon name="close" /></Button></header>
    <p className="muted usage-intro">Plan limits and credits for the accounts your assistants use, as each provider reports them.</p>
    <div className="usage-toolbar">
      <span className="muted" role="status">{usage.loading && !usage.data ? "Reading your accounts…" : newest ? <>Updated <When value={newest} inline /></> : ""}</span>
      <Button disabled={refreshing.busy || usage.loading} onClick={() => void refresh()}><Icon name="refresh" size={16} className={refreshing.busy ? "spin" : undefined} />Refresh</Button>
    </div>
    {(usage.error || refreshing.error) && <FormMessage tone="error">{usage.error || refreshing.error}</FormMessage>}
    {usage.data && !accounts.length && <p className="usage-empty">None of your assistants uses an account that reports limits yet.</p>}
    <div className="usage-accounts">
      {accounts.map(account => <AccountCard key={account.key} account={account} names={account.botIds.map(name).filter((value): value is string => !!value)}
        outcome={outcome?.key === account.key ? outcome.text : ""}
        onReset={async (force, requestId) => {
          const result = await request("POST /usage/accounts/:key/reset", { params: { key: account.key }, body: { confirmed: true, requestId, force } });
          setOutcome({ key: account.key, text: resetOutcomeMessage(result) });
          if (result.account) replace(result.account); else void usage.reload();
        }} />)}
    </div>
    {!!usage.data?.unavailableBots.length && <p className="muted usage-unavailable" role="status">Usage unavailable for {plural(usage.data.unavailableBots.length, "assistant")}.</p>}
  </Dialog>;
}

function AccountCard({ account, names, outcome, onReset }: { account: UsageAccount; names: string[]; outcome: string; onReset(force: boolean, requestId: string): Promise<void> }) {
  const title = accountName(account.provider);
  return <article className="usage-card" aria-label={title}>
    <div className="usage-card-heading">
      <h3><ProviderIcon provider={account.provider} size={18} />{title}{account.plan && <span className="usage-plan">{account.plan}</span>}</h3>
      {account.fallbackOnly && <span className="usage-tag">Fallback</span>}
    </div>
    {account.windows.length > 0 && <ul className="usage-windows">{account.windows.map((window, index) => <Allowance key={`${window.label}:${index}`} window={window} />)}</ul>}
    {account.details.map((line, index) => <p key={index} className="usage-detail">{line}</p>)}
    {account.unavailableReason && <p className="usage-detail muted">{account.unavailableReason}</p>}
    {account.bankedResets > 0 && <Resets account={account} onReset={onReset} />}
    {outcome && <p className="usage-outcome" role="status">{outcome}</p>}
    {names.length > 0 && <p className="usage-users">Used by {names.join(", ")}</p>}
  </article>;
}

function Allowance({ window }: { window: UsageWindow }) {
  const minute = useMinute();
  const used = window.usedPercent;
  const when = window.resetsAt ? resetPhrase(window.resetsAt, minute * 60_000) : "";
  return <li className="usage-window" data-level={used === null ? undefined : usageLevel(used)}>
    <div className="usage-window-row"><span>{window.label}</span><strong>{used === null ? "Not reported" : `${Math.round(used)}% used`}</strong></div>
    {used !== null && <div className="usage-bar" role="meter" aria-label={window.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(used)}
      aria-valuetext={`${Math.round(used)}% used`}><span style={{ width: `${used}%` }} /></div>}
    {(when || window.detail) && <small>{[when, window.detail].filter(Boolean).join(" · ")}</small>}
  </li>;
}

/** Banked ChatGPT resets, spent only after a confirmation that says plainly when one would be wasted. */
function Resets({ account, onReset }: { account: UsageAccount; onReset(force: boolean, requestId: string): Promise<void> }) {
  const [asking, setAsking] = useState(false);
  const action = useAction();
  // One ID per reset the person asked for. A failed attempt keeps it, so trying again can never spend a second reset.
  const requestId = useRef<string | null>(null);
  const early = resetWouldBeWasted(account);
  const left = account.bankedResets - 1;
  // Either way the question is answered: a failure closes it too and says why beside the button.
  const confirm = () => action.run(async () => { await onReset(early, requestId.current ??= crypto.randomUUID()); },
    { onSuccess: () => { requestId.current = null; setAsking(false); }, onError: () => { setAsking(false); } });
  return <div className="usage-resets">
    <span>{plural(account.bankedResets, "banked reset")}</span>
    <Button id={`reset-${account.key}`} disabled={action.busy} onClick={() => setAsking(true)}>Use a reset</Button>
    {action.error && <FormMessage tone="error">{action.error}</FormMessage>}
    {asking && <SettingsConfirmation busy={action.busy} danger={early} cancelLabel="Cancel" fallbackFocus={`#reset-${account.key}`}
      title={early ? "Use a reset early?" : "Use a banked reset?"}
      detail={early ? "No limit is used up yet. A reset restores the full allowance, so using it now wastes most of it."
        : `This restores this account's session and weekly limits now. You'll have ${plural(left, "reset")} left.`}
      confirmLabel={early ? "Use reset anyway" : "Use reset"} onConfirm={() => void confirm()} onCancel={() => setAsking(false)} />}
  </div>;
}
