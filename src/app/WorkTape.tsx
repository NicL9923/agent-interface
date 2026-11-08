import { memo } from "react";
import type { ToolCall } from "../shared/types";
import { Icon } from "../components/Icon";
import { stepStatus, tapeSteps, toolGlyph } from "./work-tape";

/**
 * The running turn's tools as a strip of glyphs that fills in as each one finishes. The current
 * step shimmers; a failed one turns red. Named for screen readers, and quiet: the live row above
 * already announces the current tool.
 */
export const WorkTape = memo(function WorkTape({ calls }: { calls: ToolCall[] }) {
  if (!calls.length) return null;
  const { shown, folded } = tapeSteps(calls);
  return <ol className="work-tape" aria-label={`${calls.length} ${calls.length === 1 ? "step" : "steps"} so far`}>
    {folded > 0 && <li className="work-tape-more" aria-label={`${folded} earlier ${folded === 1 ? "step" : "steps"}`}>+{folded}</li>}
    {shown.map(call => <li key={call.id} className={`work-tape-step is-${call.status}`} title={call.name}>
      <Icon name={toolGlyph(call.name)} size={14} />
      <span className="sr-only">{call.name}, {stepStatus[call.status]}</span>
    </li>)}
  </ol>;
});
