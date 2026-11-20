import type { Resource } from "../app/use-resource";
import { goalResumeKey } from "../app/storage";
import type { Bot, Routine } from "../shared/types";
import { Status, useAutomation } from "./automation/use-automation";
import { GoalSection } from "./automation/GoalSection";
import { TaskSection, likelyCreatedTask } from "./automation/TaskSection";
import { TriggerSection, likelyCreatedTrigger } from "./automation/TriggerSection";
import { LearningPanel, SkillLocks } from "./automation/SkillsLearning";
import "./automation.css";

export { LearningPanel, SkillLocks, likelyCreatedTask, likelyCreatedTrigger };

/**
 * `routines` is the routine list already shown beside this panel, so event triggers reuse it
 * instead of reading their own copy.
 */
export function AutomationPanel({
  botId,
  bots,
  accountScope,
  routines,
}: {
  botId: string;
  bots: Bot[];
  accountScope?: string;
  routines?: Resource<Routine[]>;
}) {
  const control = useAutomation(botId);
  return (
    <div className="automation-panel automation-work">
      <h2>Goals, tasks & triggers</h2>
      <p className="muted">
        Give this assistant work, track its tasks, or run a routine when an event arrives.
      </p>
      <Status control={control} work />
      {control.value && (
        <>
          <GoalSection
            control={control}
            intentKey={accountScope ? goalResumeKey(accountScope, botId) : undefined}
          />
          <TaskSection control={control} bots={bots} botId={botId} />
          <TriggerSection control={control} botId={botId} shared={routines} />
        </>
      )}
    </div>
  );
}
