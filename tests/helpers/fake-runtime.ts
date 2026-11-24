import type { Runtime } from "../../src/shared/types.js";

/** Overrides must satisfy the production contract. Unexpected required calls fail at their name. */
export function fakeRuntime(members: Partial<Runtime>): Runtime {
  const missing = (name: keyof Runtime) => () => {
    throw new Error(`fakeRuntime.${name} was not configured for this test.`);
  };
  return {
    status: missing("status"),
    capabilities: missing("capabilities"),
    listBots: missing("listBots"),
    saveBot: missing("saveBot"),
    deleteBot: missing("deleteBot"),
    stop: missing("stop"),
    generatePortrait: missing("generatePortrait"),
    conversation: missing("conversation"),
    submit: missing("submit"),
    lookupSubmission: missing("lookupSubmission"),
    steer: missing("steer"),
    answerRequest: missing("answerRequest"),
    approve: missing("approve"),
    upload: missing("upload"),
    download: missing("download"),
    tools: missing("tools"),
    setTools: missing("setTools"),
    skills: missing("skills"),
    setSkills: missing("setSkills"),
    routines: missing("routines"),
    saveRoutine: missing("saveRoutine"),
    deleteRoutine: missing("deleteRoutine"),
    discoverEvents: missing("discoverEvents"),
    close: missing("close"),
    ...members,
  };
}
