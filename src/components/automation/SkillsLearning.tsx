import { Fragment, useId, useRef, useState, type ReactNode } from "react";
import { request } from "../../client-api";
import { useAction } from "../../app/use-action";
import type { SkillContent, SkillDiff } from "../../shared/automation";
import { Button } from "../ui/button";
import { SettingsConfirmation } from "../SettingsConfirmation";
import { fire } from "../../app/fire";
import { Status, useAutomation } from "./use-automation";
import "../automation.css";

function SkillDiffPreview({ text, id }: { text: string; id: string }) {
  const lines = (text || "No textual diff.").split("\n");
  let offset = 0;
  return (
    <pre id={id} className="automation-code automation-diff">
      <code>
        {lines.map((line, index) => {
          const start = offset;
          offset += line.length + 1;
          if (index === lines.length - 1 && line === "") return null;
          const kind = /^(diff |index |@@|---|\+\+\+)/.test(line)
            ? "meta"
            : line.startsWith("+")
              ? "added"
              : line.startsWith("-")
                ? "removed"
                : "context";
          return (
            <Fragment key={start}>
              <span className={`automation-diff-line automation-diff-${kind}`}>{line}</span>
              {index < lines.length - 1 ? "\n" : ""}
            </Fragment>
          );
        })}
      </code>
    </pre>
  );
}

/** The skill write policy, shown in Advanced presentation, and skill changes waiting for review. */
export function LearningPanel({ botId, advanced = true }: { botId: string; advanced?: boolean }) {
  const control = useAutomation(botId);
  const [diff, setDiff] = useState<SkillDiff>();
  const [allowingWrites, setAllowingWrites] = useState(false);
  const policyInput = useRef<HTMLInputElement>(null);
  const id = useId();
  // Reading a pending change, one at a time.
  const reader = useAction();
  const { busy: reading, error: readError } = reader;
  const read = <T,>(load: () => Promise<T>, accept: (value: T) => void) => {
    control.clearNotice();
    return reader.run(async ({ current }) => {
      const value = await load();
      if (current()) accept(value);
    });
  };
  const setPolicy = (approvalRequired: boolean) => {
    setAllowingWrites(false);
    void control.change(
      () =>
        request("PUT /bots/:id/automation/skills/policy", {
          params: { id: botId },
          body: { approvalRequired },
        }),
      undefined,
      approvalRequired
        ? "Approval is required before skill changes are saved."
        : "Skill changes can now be saved without review.",
    );
  };
  const state = control.value?.skills;
  return (
    <div className="automation-panel automation-learning">
      <h2>Learning</h2>
      <p className="muted">
        Review changes the assistant wants to make to its skills. Skills themselves are under
        Behavior.
      </p>
      <Status control={control} />
      {readError && (
        <p className="form-error" role="alert">
          {readError}
        </p>
      )}
      {state &&
        (!state.supported ? (
          <p className="capability-note">
            {state.reason || "Learning review is unavailable for this assistant."}
          </p>
        ) : (
          <>
            {advanced && (
              <section className="automation-section automation-learning-policy">
                <h3>Skill write policy</h3>
                <label className="automation-check">
                  <input
                    ref={policyInput}
                    type="checkbox"
                    checked={state.approvalRequired}
                    disabled={control.disabled || control.value?.canManageLearningPolicy === false}
                    onChange={(event) => {
                      if (event.target.checked) setPolicy(true);
                      else setAllowingWrites(true);
                    }}
                  />
                  Require approval before skill changes are saved
                </label>
                <p className="muted">
                  When enabled, WildBots stages new skills, edits and deletions for review.
                </p>
                {control.value?.canManageLearningPolicy === false && (
                  <p className="capability-note">
                    Only an integration administrator can change the skill write policy.
                  </p>
                )}
              </section>
            )}
            <section className="automation-section">
              <h3>Pending changes ({state.pending.length})</h3>
              {!state.pending.length && (
                <p className="muted">No skill changes waiting for review.</p>
              )}
              {state.pending.map((item) => (
                <article className="automation-item" key={item.id}>
                  <h4>{item.summary || item.id}</h4>
                  <p className="muted">
                    Source:{" "}
                    {item.origin
                      ? item.origin[0].toUpperCase() + item.origin.slice(1)
                      : "Not reported"}
                  </p>
                  <Button
                    disabled={reading || control.disabled}
                    aria-expanded={diff?.id === item.id}
                    aria-controls={`${id}-diff-${item.id}`}
                    onClick={() => {
                      if (diff?.id === item.id) setDiff(undefined);
                      else
                        void read(
                          () =>
                            request("GET /bots/:id/automation/skills/pending/:pendingId", {
                              params: { id: botId, pendingId: item.id },
                            }),
                          (value) => setDiff(value),
                        );
                    }}
                  >
                    {diff?.id === item.id ? "Hide change" : "Review change"}
                  </Button>
                  {diff?.id === item.id && (
                    <>
                      <SkillDiffPreview text={diff.diff} id={`${id}-diff-${item.id}`} />
                      {diff.truncated && (
                        <p>The diff is truncated. Review the full change before approving.</p>
                      )}
                      <div className="actions">
                        <Button
                          className="primary"
                          disabled={control.disabled || diff.truncated}
                          onClick={fire(async () => {
                            if (
                              await control.change(
                                () =>
                                  request("POST /bots/:id/automation/skills/pending/:pendingId", {
                                    params: { id: botId, pendingId: item.id },
                                    body: { revision: diff.revision, decision: "approve" },
                                  }),
                                undefined,
                                "Approved the skill change.",
                              )
                            )
                              setDiff(undefined);
                          })}
                        >
                          Approve change
                        </Button>
                        <Button
                          className="danger"
                          disabled={control.disabled}
                          onClick={fire(async () => {
                            if (
                              await control.change(
                                () =>
                                  request("POST /bots/:id/automation/skills/pending/:pendingId", {
                                    params: { id: botId, pendingId: item.id },
                                    body: { revision: diff.revision, decision: "reject" },
                                  }),
                                undefined,
                                "Rejected the skill change.",
                              )
                            )
                              setDiff(undefined);
                          })}
                        >
                          Reject change
                        </Button>
                      </div>
                    </>
                  )}
                </article>
              ))}
            </section>
          </>
        ))}
      {allowingWrites && (
        <SettingsConfirmation
          className="learning-policy-confirmation"
          title="Allow skill changes without review?"
          detail="WildBots can save new skills, edits and deletions without asking for approval."
          confirmLabel="Allow changes without review"
          cancelLabel="Keep approval required"
          danger
          busy={control.disabled}
          fallbackFocus={policyInput}
          onCancel={() => setAllowingWrites(false)}
          onConfirm={() => setPolicy(false)}
        />
      )}
    </div>
  );
}

/**
 * Lock and read controls for the skills Hermes reports as installed, matched to skill rows by
 * name. Locks save at once, apart from the settings sheet's Save changes.
 */
export function SkillLocks({
  botId,
  children,
}: {
  botId: string;
  children: (extras: (item: { id: string }) => ReactNode, messages: ReactNode) => ReactNode;
}) {
  const control = useAutomation(botId);
  const [content, setContent] = useState<SkillContent>();
  const reader = useAction();
  const state = control.value?.skills;
  const usable = !!state?.supported;
  // Locking follows the skill write policy's rule: an integration administrator decides what assistants may change.
  const canLock = control.value?.canManageLearningPolicy !== false;
  const setLock = (name: string, locked: boolean) => {
    void control.change(
      () =>
        request("PUT /bots/:id/automation/skills/lock", {
          params: { id: botId },
          body: { name, locked },
        }),
      undefined,
      locked
        ? `Locked ${name}. Assistants can't change it.`
        : `Unlocked ${name}. Assistants can change it again.`,
    );
  };
  const read = (name: string) => {
    control.clearNotice();
    if (content?.name === name) {
      setContent(undefined);
      return;
    }
    void reader.run(async ({ current }) => {
      const value = await request("GET /bots/:id/automation/skills/content", {
        params: { id: botId },
        query: { name },
      });
      if (current()) setContent(value);
    });
  };
  const extras = (item: { id: string }) => {
    const installed = usable ? state!.installed.find((skill) => skill.name === item.id) : undefined;
    if (!installed) return null;
    return (
      <div className="capability-extras">
        {installed.locked && (
          <p className="muted">
            <span className="automation-skill-locked">Locked</span> Assistants can't change this
            skill while it's locked.
          </p>
        )}
        <div className="actions">
          <Button
            type="button"
            aria-expanded={content?.name === installed.name}
            disabled={reader.busy || control.disabled}
            onClick={() => read(installed.name)}
          >
            {content?.name === installed.name ? "Hide skill" : "Read skill"}
          </Button>
          {state!.lockSupported && canLock && typeof installed.locked === "boolean" && (
            <Button
              type="button"
              disabled={control.disabled}
              onClick={() => setLock(installed.name, !installed.locked)}
            >
              {installed.locked ? "Unlock skill" : "Lock skill"}
            </Button>
          )}
        </div>
        {content?.name === installed.name && (
          <>
            <pre className="automation-code">{content.content}</pre>
            {content.truncated && <p>Preview truncated.</p>}
          </>
        )}
      </div>
    );
  };
  const messages = (
    <>
      {usable && state!.lockSupported && (
        <p className="muted">
          {canLock
            ? "Lock a skill to keep assistants from changing it."
            : "Only an integration administrator can lock or unlock skills."}
        </p>
      )}
      {(control.error || reader.error) && (
        <p className="form-error" role="alert">
          {control.error || reader.error}
        </p>
      )}
      {control.notice && (
        <p className="form-notice" role="status">
          {control.notice}
        </p>
      )}
      {(control.uncertain || (!!control.error && !control.value)) && (
        <Button type="button" disabled={control.loading} onClick={() => void control.refresh()}>
          {control.loading ? "Refreshing..." : "Refresh skill status"}
        </Button>
      )}
    </>
  );
  return <>{children(extras, messages)}</>;
}
