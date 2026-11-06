// Checks a Node version against package.json "engines.node". The repository only uses caret
// alternatives such as "^24.22.2 || ^26.13.0"; any other form is refused rather than guessed at,
// so editing the range can never quietly turn the check off.
const caret = /^\^(\d+)\.(\d+)\.(\d+)$/;

export function satisfiesEngine(version, range) {
  const [major, minor, patch] = version.replace(/^v/, "").split(".").map(Number);
  return range.split("||").map(part => part.trim()).some(part => {
    const match = caret.exec(part);
    if (!match) throw new Error(`engines.node uses "${part}"; scripts/node-engine.mjs only understands ^MAJOR.MINOR.PATCH alternatives.`);
    const [, wantMajor, wantMinor, wantPatch] = match.map(Number);
    return major === wantMajor && (minor > wantMinor || (minor === wantMinor && patch >= wantPatch));
  });
}
