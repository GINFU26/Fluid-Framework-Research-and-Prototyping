import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const act2Panel = fs.readFileSync(path.join(root, "src", "Act2Panel.tsx"), "utf8");
const ai = fs.readFileSync(path.join(root, "src", "ai.ts"), "utf8");
const useCanvas = fs.readFileSync(path.join(root, "src", "useCanvas.ts"), "utf8");

const requiredSections = ["Conflict", "Positions", "Resolution", "How to apply", "Open questions"];
const forbiddenConflictSections = ["Agreed signal", "Merged next move"];
const forbiddenClarifySections = ["Shared state", "Past", "Now", "Future"];

const semanticAction = sourceSlice(
  act2Panel,
  'id: "semanticMerge"',
  'id: "highlightPriority"',
  "semantic merge action",
);
const semanticFallback = sourceSlice(
  ai,
  "function buildSemanticMergeEdits",
  "/**\n * Picks a substring",
  "semantic merge fallback",
);
const semanticGuard = sourceSlice(
  ai,
  "function isUnusableSemanticMergeAddNote",
  "/**\n * Best-effort recovery",
  "semantic merge structure guard",
);
const globalInstruction = sourceSlice(
  ai,
  "For semantic merge instructions",
  "For shared-state clarification",
  "semantic merge global instruction",
);

for (const section of requiredSections) {
  assertIncludes(semanticAction, section, `semantic action must require ${section}`);
  assertIncludes(semanticFallback, `"${section}"`, `fallback note must include ${section}`);
  assertIncludes(globalInstruction, section, `global instruction must mention ${section}`);
}

for (const forbidden of forbiddenConflictSections) {
  assertIncludes(semanticAction, forbidden, `semantic action must explicitly reject ${forbidden}`);
  assertIncludes(semanticGuard, forbidden, `guard must reject ${forbidden}`);
  assertNotIncludes(semanticFallback, `"${forbidden}"`, `fallback must not render ${forbidden}`);
}

for (const forbidden of forbiddenClarifySections) {
  assertIncludes(globalInstruction, forbidden, `global instruction must distinguish semantic merge from ${forbidden}`);
  const guardNeedle = forbidden === "Shared state" ? "shared state" : forbidden;
  assertIncludes(semanticGuard, guardNeedle, `guard must reject clarify-style ${forbidden}`);
}

assertIncludes(
  semanticGuard,
  "SEMANTIC_MERGE_REQUIRED_NOTE_SECTIONS.every",
  "guard must require every conflict-brief section",
);
assertNotIncludes(
  semanticFallback,
  '"Shared state"',
  "fallback must not render the clarify title",
);
assertIncludes(
  semanticFallback,
  "What condition would make the team choose a different path",
  "fallback must keep open questions visible",
);
assertIncludes(
  semanticAction,
  "Always use the visible mediator-note pattern",
  "semantic action must avoid hidden participant-only rewrites",
);
assertIncludes(
  globalInstruction,
  "emit exactly one signed conflict-brief addNote",
  "global instruction must require a visible conflict artifact",
);
assertIncludes(
  globalInstruction,
  "replaceSpan for semantic merge",
  "global instruction must forbid replaceSpan for semantic merge",
);
assertIncludes(
  ai,
  '.filter((edit) => edit.type === "addNote" || edit.type === "addHighlight")',
  "semantic completion must drop non-visible/destructive semantic merge edits",
);
assertNotIncludes(
  useCanvas,
  "rationale: edit.rationale",
  "accepted highlights must not write undefined rationale into Automerge",
);
assertIncludes(
  useCanvas,
  "if (edit.rationale) highlight.rationale = edit.rationale",
  "accepted highlights should only write rationale when present",
);

console.log("Semantic merge structure smoke passed.");

function sourceSlice(source, startNeedle, endNeedle, label) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  if (start < 0 || end < 0) {
    throw new Error(`Could not locate ${label}.`);
  }
  return source.slice(start, end);
}

function assertIncludes(source, needle, message) {
  if (!source.includes(needle)) {
    throw new Error(`${message}: missing ${JSON.stringify(needle)}`);
  }
}

function assertNotIncludes(source, needle, message) {
  if (source.includes(needle)) {
    throw new Error(`${message}: found ${JSON.stringify(needle)}`);
  }
}
