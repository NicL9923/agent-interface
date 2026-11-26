export const DEFAULT_BANNED_ENTRY_PACKAGES = ["@novnc/novnc", "@xterm/xterm", "highlight.js"];

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const packageMatcher = (pkg) =>
  new RegExp(`(?:^|[\\\\/])node_modules[\\\\/]${escapeRegex(pkg)}(?:[\\\\/]|$)`);

const defaultEntryMatcher = (chunk) => {
  if (!chunk.isEntry) return false;
  if (chunk.facadeModuleId) return /(?:^|[\\/])index\.html$/.test(chunk.facadeModuleId);
  return chunk.name === "index";
};

function chunksOf(bundle) {
  const chunks = new Map();
  for (const [key, item] of Object.entries(bundle)) {
    if (item && item.type === "chunk") {
      chunks.set(item.fileName ?? key, item);
    }
  }
  return chunks;
}

/**
 * Fails the build if emitted JS chunks contain any circular static import cycle.
 */
export function assertNoChunkCycles(bundle) {
  const chunks = chunksOf(bundle);
  // 0 = unvisited, 1 = visiting (on current DFS stack), 2 = completely explored
  const state = new Map();
  const stack = [];

  const visit = (fileName) => {
    state.set(fileName, 1);
    stack.push(fileName);
    const chunk = chunks.get(fileName);
    for (const imported of chunk?.imports ?? []) {
      if (!chunks.has(imported)) continue;
      const status = state.get(imported) ?? 0;
      if (status === 1) {
        const start = stack.indexOf(imported);
        const cycle = [...stack.slice(start), imported].join(" -> ");
        throw new Error(`Circular static chunk import detected: ${cycle}`);
      }
      if (status === 0) visit(imported);
    }
    stack.pop();
    state.set(fileName, 2);
  };

  for (const fileName of chunks.keys()) {
    if ((state.get(fileName) ?? 0) === 0) visit(fileName);
  }
}

/**
 * Fails the build if any heavy lazy-only package is statically reachable from the index.html entry chunk.
 */
export function assertNoBannedEntryImports(
  bundle,
  { bannedPackages = DEFAULT_BANNED_ENTRY_PACKAGES, entryMatcher = defaultEntryMatcher } = {},
) {
  const chunks = chunksOf(bundle);
  const roots = [...chunks.entries()]
    .filter(([, chunk]) => entryMatcher(chunk))
    .map(([fileName]) => fileName);

  const closure = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const fileName = queue.shift();
    if (closure.has(fileName) || !chunks.has(fileName)) continue;
    closure.add(fileName);
    for (const imported of chunks.get(fileName).imports ?? []) {
      if (chunks.has(imported) && !closure.has(imported)) queue.push(imported);
    }
  }

  const matchers = bannedPackages.map((pkg) => ({ pkg, regex: packageMatcher(pkg) }));
  const violations = [];

  for (const fileName of closure) {
    const chunk = chunks.get(fileName);
    const moduleIds = new Set([
      ...Object.keys(chunk.modules ?? {}),
      ...(Array.isArray(chunk.moduleIds) ? chunk.moduleIds : []),
    ]);
    for (const moduleId of moduleIds) {
      for (const { pkg, regex } of matchers) {
        if (regex.test(moduleId)) {
          violations.push(`${pkg} (in ${fileName}: ${moduleId})`);
        }
      }
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `Banned heavy package(s) statically imported in index.html entry closure: ${violations.join("; ")}`,
    );
  }
}

/**
 * Vite / Rolldown plugin that guards against circular static chunk imports and
 * banned heavy lazy packages leaking into the index.html entry closure.
 */
export function chunkCycleGuardPlugin(options = {}) {
  return {
    name: "chunk-cycle-guard",
    generateBundle(_outputOptions, bundle) {
      assertNoChunkCycles(bundle);
      assertNoBannedEntryImports(bundle, options);
    },
  };
}
