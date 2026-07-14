import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import {
  createAiRequestSnapshot,
  type AiProposalEdit,
  type AiProposalResponse,
  type AiProvider,
  type CanvasSnapshot,
  type GroundingSource,
  type ProposalFeedback,
  type RejectionReason,
  type SemanticTension,
} from "./ai";
import type { CanvasDoc, StickyNote } from "./schema";

interface Act2PanelProps {
  doc: CanvasDoc;
  provider: AiProvider;
  aiEnabled?: boolean;
  selectedNotes: StickyNote[];
  surfaceMode?: WorkSurface;
  userName: string;
  onAccept: (edits: AiProposalEdit[]) => boolean;
  onPreviewChange: (edits: AiProposalEdit[] | null) => void;
  onReviewPhaseChange: (phase: AiReviewPhase) => void;
  onFeedbackMemoryChange: (count: number) => void;
  tensions?: SemanticTension[];
  tensionsLoading?: boolean;
  tensionsError?: string | null;
  onRefreshTensions?: () => void;
}

export interface Act2PanelHandle {
  runWorkflowDemo: (options: DemoWorkflowOptions) => Promise<boolean>;
  runFeedbackLoopDemo: (options?: DemoFeedbackLoopOptions) => Promise<boolean>;
  runTensionReconcileDemo: (options?: DemoTensionReconcileOptions) => Promise<boolean>;
  acceptCurrentProposal: () => boolean;
}

export type DemoWorkflowId = "mapContributions" | "createHandoff" | "clarifyState" | "semanticMerge" | "highlightPriority";

function toDemoWorkflowId(value: string): DemoWorkflowId | undefined {
  if (
    value === "mapContributions" ||
    value === "createHandoff" ||
    value === "clarifyState" ||
    value === "semanticMerge" ||
    value === "highlightPriority"
  ) {
    return value;
  }
  return undefined;
}

export interface DemoWorkflowOptions {
  workflowId?: DemoWorkflowId;
  label?: string;
  autoAccept?: boolean;
  forceWholeCanvas?: boolean;
  previewMs?: number;
}

export interface DemoTensionReconcileOptions {
  autoAccept?: boolean;
  previewMs?: number;
}

export interface DemoFeedbackLoopOptions {
  autoAccept?: boolean;
  forceWholeCanvas?: boolean;
  previewMs?: number;
}

type PanelStatus = "idle" | "loading" | "accepted" | "rejected" | "error";
export type AiReviewPhase = "idle" | "loading" | "proposal" | "accepted" | "rejected" | "error";
type WorkSurface = "canvas" | "text";
type ChangeSelections = Record<number, Set<number>>;
type TextReviewMode = "line" | "sentence";

interface ReviewHistoryItem {
  id: string;
  decision: "accepted" | "rejected";
  summary: string;
  editCount: number;
  providerLabel: string;
  instruction: string;
  timestamp: number;
}

type TextReviewSegment =
  | { kind: "equal"; units: string[] }
  | { kind: "change"; changeIndex: number; original: string[]; proposed: string[] };

interface TextReview {
  mode: TextReviewMode;
  originalText: string;
  proposedText: string;
  segments: TextReviewSegment[];
  changeCount: number;
}

interface DiffOperation {
  kind: "equal" | "remove" | "add";
  value: string;
}

interface ProposalImpactItem {
  label: string;
  detail: string;
}

interface WorkflowActionContext {
  userName?: string;
  /**
   * For the semantic-merge workflow only. When the current user authored
   * at least one of the conflicting notes, the reconcile branch switches
   * from "add a signed mediator note" to "surgically replace the
   * conflicting span in your own note". The participant note ids and the
   * raw notes are forwarded so the LLM can target the right note id and
   * see its current text verbatim.
   */
  participantNotes?: { id: string; author: string; text: string }[];
  conflictingNotes?: { id: string; author: string; text: string }[];
  /**
   * For the mapContributions workflow. Forwarded so the prompt can list
   * every distinct author in the scoped notes and force the AI to emit
   * one contributor summary per author (including authors with only a
   * single source note). Without this, the LLM tends to drop
   * low-frequency contributors.
   */
  authorBreakdown?: {
    author: string;
    noteCount: number;
    noteIds: string[];
  }[];
}

interface WorkflowAction {
  id: string;
  label: (selectedCount: number) => string;
  does: (selectedCount: number) => string;
  improves: (selectedCount: number) => string;
  instruction: (selectedCount: number, context?: WorkflowActionContext) => string;
}

const WORKFLOW_ACTIONS: WorkflowAction[] = [
  {
    id: "mapContributions",
    label: () => "Map the room",
    does: () => "Replaces scattered source notes with one readable contributor map after review.",
    improves: () => "Turns scattered room notes into a scannable map while preserving names and facts inside the generated output.",
    instruction: (_selectedCount: number, context) => {
      const breakdown = context?.authorBreakdown ?? [];
      const base = [
        "Map the room by source user.",
        "You MUST emit exactly one contributor summary note for EVERY distinct author present in the scoped notes — including authors who have only a single source note. Do not skip, merge, or drop any author.",
        "Each contributor summary note must include the author's name, the source note count, the time range when available, and one short bullet per source note.",
        "Then emit one deleteNote edit for EVERY source note represented in any contributor summary, so Accept replaces every scattered source note with the AI-generated map. Do not leave any source note orphaned.",
        "Do not invent content and do not create empty placeholder notes.",
      ].join(" ");
      if (breakdown.length === 0) return base;
      const roster = breakdown
        .map((entry) => {
          const ids = entry.noteIds.map((id) => `"${id}"`).join(", ");
          return `- ${entry.author}: ${entry.noteCount} source note${entry.noteCount === 1 ? "" : "s"} (ids: ${ids})`;
        })
        .join("\n");
      return [
        base,
        "",
        `Authors present in the scoped notes (${breakdown.length} total). You MUST produce one contributor summary note for EACH of these authors:`,
        roster,
        "",
        `Required output checklist: ${breakdown.length} contributor summary note${breakdown.length === 1 ? "" : "s"} (one per author above), plus deleteNote edits for the ${breakdown.reduce((sum, e) => sum + e.noteCount, 0)} source notes listed above. Authors with only one source note still get their own summary note.`,
      ].join("\n");
    },
  },
  {
    id: "createHandoff",
    label: () => "Ship the handoff",
    does: (selectedCount: number) =>
      selectedCount > 0
        ? "Turns concrete asks from the selected note or area into source-traced tasks."
        : "Turns concrete asks from the board into source-traced tasks.",
    improves: () => "Moves the room from discussion to accountable work while preserving who surfaced each task.",
    instruction: (selectedCount: number) =>
      selectedCount > 0
        ? "Ship the handoff from the selected note or selected area. Return only addTask edits. This is a to-do extraction, not a board summary. List the concrete things someone needs to do: commitments, asks, blockers that need an owner, or decisions that require follow-through. Write each task as a short verb-first title such as Confirm owner, Schedule review, or Resolve blocker. Keep timing when present, attach source author and source timestamp metadata, skip context-only statements, avoid duplicates already in the task list, and do not explain past/current/future state."
        : "Ship the handoff from the current board. Return only addTask edits. This is a to-do extraction, not a board summary. List the concrete things someone needs to do: commitments, asks, blockers that need an owner, or decisions that require follow-through. Prefer today, urgent, due, or blocked items first. Write each task as a short verb-first title such as Confirm owner, Schedule review, or Resolve blocker. Keep timing when present, attach source author and source timestamp metadata, skip context-only statements, avoid duplicates already in the task list, and do not explain past/current/future state.",
  },
  {
    id: "clarifyState",
    label: (selectedCount: number) => (selectedCount > 0 ? "Clarify target signal" : "Clarify the signal"),
    does: (selectedCount: number) =>
      selectedCount > 0
        ? "Distills the selected note or area into one shared-state brief."
        : "Distills the board into one shared-state brief.",
    improves: () => "Makes the current signal, evidence, and uncertainty visible without assigning work.",
    instruction: (selectedCount: number) =>
      selectedCount > 0
        ? "Clarify the signal from the selected note or selected area. Return exactly one addNote edit titled Shared state. Make the messy board easier to understand by explaining the timeline of the work, not by creating todos. Use these sections only when supported by source content: Past, Now, Future, Open questions. Future should summarize likely direction or expected state, not assign owners or create tasks. Include contributor names beside each item, preserve original facts, do not invent commitments, do not create addTask edits, and do not rewrite existing notes."
        : "Clarify the signal from the current board. Return exactly one addNote edit titled Shared state. Make the messy board easier to understand by explaining the timeline of the work, not by creating todos. Use these sections only when supported by source content: Past, Now, Future, Open questions. Future should summarize likely direction or expected state, not assign owners or create tasks. Include contributor names beside each item, preserve original facts, do not invent commitments, do not create addTask edits, and do not rewrite existing notes.",
  },
  {
    id: "semanticMerge",
    label: () => "Semantic merge",
    does: () => "Drafts a conflict brief that names the disagreement, positions, resolution, and remaining questions.",
    improves: () => "Makes the conflict reviewable without turning it into a generic shared-state summary.",
    instruction: (_selectedCount: number, context) => {
      const reviewer = context?.userName?.trim() || "the reviewer";
      const conflictingNotes = context?.conflictingNotes ?? [];
      const sourceSummary = conflictingNotes
        .map((note) => `- ${note.author} note id ${note.id}: "${note.text.replace(/\s+/g, " ").trim().slice(0, 220)}"`)
        .join("\n");

      return [
        `${reviewer} is reconciling parallel collaborator notes about the same decision or next move.`,
        "Always use the visible mediator-note pattern, even if the reviewer's display name matches one of the source authors. The accepted result must create a reviewable conflict artifact on the canvas, not a hidden sentence rewrite.",
        "",
        "Source notes in this tension:",
        sourceSummary || "(none)",
        "",
        `Add exactly one new sticky note titled "${reviewer}'s reconcile — <short topic>" attributed to ${reviewer} (drafted with AI). The note body must be a conflict brief, not a shared-state brief.`,
        "Use these labeled sections in this exact order:",
        "  • Conflict: 1-2 bullets naming the actual disagreement or decision tension.",
        "  • Positions: one bullet per source note, quoting the exact conflicting phrase in quotation marks, followed by — Author (date).",
        "  • Resolution: one concise recommendation in the reviewer's voice that chooses or combines a path forward.",
        "  • How to apply: one or two concrete steps for applying the resolution while preserving human review.",
        "  • Open questions: unresolved decisions or validation questions that still matter after the resolution.",
        "Do NOT use Shared state, Past, Now, Future, Agreed signal, Merged next move, or timeline-summary sections for semantic merge.",
        `For every source note cited in Positions, also emit one addHighlight edit with color "${SEMANTIC_CONFLICT_HIGHLIGHT_COLOR}" pointing at the exact conflicting phrase or sentence inside that source note (use a substring that appears verbatim in the note).`,
        "Do NOT emit any deleteNote, updateNoteText, replaceSpan, or moveNote edits. Original source notes must remain on the canvas, unchanged, so contributors keep authorship of their wording.",
        "Preserve original facts, do not invent owners or dates, and do not delete or rewrite source notes.",
      ].join(" \n");
    },
  },
  {
    id: "highlightPriority",
    label: () => "Spotlight priority",
    does: () => "Spotlights the highest-priority phrase directly inside its source note.",
    improves: () => "Keeps urgency in the exact place people are already reading.",
    instruction: () =>
      "Highlight exactly one concrete priority phrase or line. Choose the source note that most needs attention now using this order: overdue, blocked, due, urgent, today, now, tomorrow, then the clearest next action. Never highlight structure labels such as Shared state, Current stage, Next stage, Open questions, contributor summaries, or source-count/time-range lines. Return only one addHighlight edit, use the exact source phrase or line, attach source-note metadata, explain why that line helps the team decide what to do next, and make no other edits.",
  },
];

const TEXT_SURFACE_WORKFLOW_ACTIONS: WorkflowAction[] = [
  {
    id: "textDistill",
    label: () => "Distill text",
    does: () => "Turns the long shared text surface into one concise review brief.",
    improves: () => "Lets collaborators keep writing freely while AI extracts a readable signal.",
    instruction: () =>
      "Summarize the shared text surface into one concise review note. Preserve facts from the shared text, separate current signal from open questions when possible, and do not invent owners, dates, or decisions.",
  },
  {
    id: "textNextMoves",
    label: () => "Pull next moves",
    does: () => "Finds concrete next moves hiding inside the long text draft.",
    improves: () => "Moves a dense co-writing session toward action without forcing people to stop typing.",
    instruction: () =>
      "Summarize concrete next moves from the shared text surface. Include only actions or decisions that are actually present in the text, keep the wording concise, and preserve important timing or blocker language.",
  },
  {
    id: "textTension",
    label: () => "Find tension",
    does: () => "Surfaces conflicting or unresolved ideas inside the long shared draft.",
    improves: () => "Helps collaborators resolve meaning after many small real-time edits.",
    instruction: () =>
      "Summarize the shared text surface with emphasis on unresolved tension, competing options, and the clearest merged next step. Preserve evidence from the text and avoid adding new facts.",
  },
];

const REJECTION_REASON_OPTIONS: Array<{ value: RejectionReason; label: string }> = [
  { value: "needsSmallerEdits", label: "Needs smaller changes" },
  { value: "wrongTarget", label: "Wrong target" },
  { value: "tooBroad", label: "Too broad" },
  { value: "notUseful", label: "Not useful" },
];

const REVISION_PRESET_OPTIONS: Array<{
  value: string;
  label: string;
  reason: RejectionReason;
  details: string;
}> = [
  {
    value: "smaller",
    label: "Shorter draft",
    reason: "needsSmallerEdits",
    details: "Regenerate a tighter version. Keep at most three bullets or tasks, remove broad explanation, and make the second draft visibly shorter.",
  },
  {
    value: "timeline",
    label: "Timeline brief",
    reason: "notUseful",
    details: "Regenerate as a Past / Now / Future brief. Make Future a summary of expected direction or state, not a task list.",
  },
  {
    value: "preserveFacts",
    label: "Show sources",
    reason: "notUseful",
    details: "Regenerate with stronger source trail. Keep contributor names beside each bullet or task and remove anything not grounded in the board.",
  },
  {
    value: "concrete",
    label: "More concrete",
    reason: "tooBroad",
    details: "Regenerate with more specific wording. Replace generic summaries with concrete facts, named blockers, dates, or exact asks that already appear on the board.",
  },
  {
    value: "tasks",
    label: "To-do only",
    reason: "notUseful",
    details: "Regenerate as a pure to-do handoff. Include only concrete tasks someone can check off; remove status summary, timeline explanation, and context-only bullets.",
  },
  {
    value: "questions",
    label: "Questions first",
    reason: "tooBroad",
    details: "Regenerate with open questions and blockers first. Make uncertainty visible before adding context or future direction.",
  },
];

const MAX_LOCAL_FEEDBACK = 5;
/**
 * Amber color used for highlights that mark the conflicting phrase inside a
 * source note when a semantic merge proposal is drafted. Distinct from the
 * red used by "Spotlight priority" so reviewers can tell the two intents
 * apart at a glance.
 */
const SEMANTIC_CONFLICT_HIGHLIGHT_COLOR = "#f59e0b";
const FEEDBACK_LOOP_DEMO_DETAILS =
  "Regenerate as a shorter Past / Now / Future brief. Keep at most one bullet per section, preserve contributor names, and make the revision visibly different from the first draft.";
const REPEAT_REVISION_DETAILS =
  "The previous regeneration repeated the same draft. Keep the latest user correction, but change the proposal scope, emphasis, or edit selection so the next draft is visibly different.";
// Reserved for future backend grounding retrieval; the demo UI does not expose SharePoint controls.
const RESERVED_BACKEND_GROUNDING_SOURCES: GroundingSource[] = [];

function createTimestamp(): number {
  return Date.now();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function autosizeTextarea(textarea: HTMLTextAreaElement | null) {
  if (!textarea) return;
  const maxHeight = Number.parseInt(textarea.dataset.maxHeight ?? "220", 10);
  textarea.style.height = "auto";
  const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
}

function buildRepeatRevisionDetails(previousDetails: string): string {
  const trimmed = previousDetails.trim();
  return trimmed ? `${REPEAT_REVISION_DETAILS} Latest correction: ${trimmed}` : REPEAT_REVISION_DETAILS;
}

function proposalLooksRepeated(previous: AiProposalResponse, next: AiProposalResponse): boolean {
  return buildProposalSignature(previous) === buildProposalSignature(next);
}

function buildProposalSignature(proposal: AiProposalResponse): string {
  return JSON.stringify(proposal.edits.map(buildEditSignature));
}

// Per-edit stable string key for cross-draft diff comparison. Identical
// edits (same type, target, normalized text, color, sources) produce the
// same key, so we can detect which edits the AI kept after Regenerate.
function buildProposalSignatureKey(edit: AiProposalEdit): string {
  return JSON.stringify(buildEditSignature(edit));
}

function buildEditSignature(edit: AiProposalEdit): Record<string, unknown> {
  const sourceNoteIds = [...(edit.sourceNoteIds ?? [])].sort();

  if (edit.type === "addNote") {
    return {
      type: edit.type,
      text: normalizeSignatureText(edit.text),
      color: edit.color,
      sourceNoteIds,
    };
  }

  if (edit.type === "updateNoteText") {
    return {
      type: edit.type,
      id: edit.id,
      text: normalizeSignatureText(edit.text),
      sourceNoteIds,
    };
  }

  if (edit.type === "moveNote") {
    return {
      type: edit.type,
      id: edit.id,
      x: Math.round(edit.x),
      y: Math.round(edit.y),
      sourceNoteIds,
    };
  }

  if (edit.type === "deleteNote") {
    return {
      type: edit.type,
      id: edit.id,
      sourceNoteIds,
    };
  }

  if (edit.type === "addShape") {
    return {
      type: edit.type,
      shape: edit.shape,
      x: Math.round(edit.x),
      y: Math.round(edit.y),
      size: Math.round(edit.size ?? 60),
      color: edit.color,
      sourceNoteIds,
    };
  }

  if (edit.type === "addTask") {
    return {
      type: edit.type,
      title: normalizeSignatureText(edit.title),
      owner: normalizeSignatureText(edit.owner ?? ""),
      timing: normalizeSignatureText(edit.timing ?? ""),
      sourceAuthors: [...(edit.sourceAuthors ?? [])].sort(),
      sourceCreatedAt: [...(edit.sourceCreatedAt ?? [])].sort(),
      sourceNoteIds,
    };
  }

  if (edit.type === "replaceSpan") {
    return {
      type: edit.type,
      noteId: edit.noteId,
      find: normalizeSignatureText(edit.find),
      replace: normalizeSignatureText(edit.replace),
      sourceNoteIds,
    };
  }

  return {
    type: edit.type,
    noteId: edit.noteId,
    text: normalizeSignatureText(edit.text),
    color: edit.color,
    sourceNoteIds,
  };
}

function normalizeSignatureText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export const Act2Panel = forwardRef<Act2PanelHandle, Act2PanelProps>(function Act2Panel({
  doc,
  provider,
  aiEnabled = true,
  selectedNotes,
  surfaceMode = "canvas",
  userName,
  onAccept,
  onPreviewChange,
  onReviewPhaseChange,
  onFeedbackMemoryChange,
  tensions = [],
  tensionsLoading = false,
  tensionsError = null,
  onRefreshTensions,
}: Act2PanelProps, ref) {
  const [instruction, setInstruction] = useState(WORKFLOW_ACTIONS[0].instruction(0));
  const [activeWorkflowId, setActiveWorkflowId] = useState<DemoWorkflowId | undefined>(toDemoWorkflowId(WORKFLOW_ACTIONS[0].id));
  const [proposal, setProposal] = useState<AiProposalResponse | null>(null);
  const [proposalWorkflowId, setProposalWorkflowId] = useState<DemoWorkflowId | undefined>(undefined);
  const [sourceSnapshot, setSourceSnapshot] = useState<CanvasSnapshot | null>(null);
  const [includedEditIndexes, setIncludedEditIndexes] = useState<Set<number>>(new Set());
  const [acceptedChangeIndexes, setAcceptedChangeIndexes] = useState<ChangeSelections>({});
  const [status, setStatus] = useState<PanelStatus>("idle");
  const [decisionMessage, setDecisionMessage] = useState("");
  const [shareStatus, setShareStatus] = useState("");
  const [shareText, setShareText] = useState("");
  const [reviewHistory, setReviewHistory] = useState<ReviewHistoryItem[]>([]);
  const [feedbackHistory, setFeedbackHistory] = useState<ProposalFeedback[]>([]);
  const [rejectionReason, setRejectionReason] = useState<RejectionReason | "">("");
  const [revisionPreset, setRevisionPreset] = useState("");
  const [rejectionDetails, setRejectionDetails] = useState("");
  // previousProposal holds the draft that was rejected on the most recent
  // Regenerate. We use it to compute a "kept / new / dropped" diff banner
  // so the reviewer can see what the AI changed in response to feedback.
  // Reset on Accept, clearProposal, or new workflow start.
  const [previousProposal, setPreviousProposal] = useState<AiProposalResponse | null>(null);
  const [error, setError] = useState("");
  const instructionTextareaRef = useRef<HTMLTextAreaElement>(null);
  const rejectionDetailsRef = useRef<HTMLTextAreaElement>(null);

  const groundingSources = RESERVED_BACKEND_GROUNDING_SOURCES;
  const reviewPhase: AiReviewPhase = proposal ? "proposal" : status;
  const providerLabel = "AI coauthor";
  const hostedDisabledMessage =
    "AI generation is off for this deployment because no demo AI backend is configured.";
  const workflowActions = surfaceMode === "text" ? TEXT_SURFACE_WORKFLOW_ACTIONS : WORKFLOW_ACTIONS;
  // Chips on the canvas surface skip semanticMerge: it is surfaced through the
  // dedicated Tensions section instead of a free-form chip click.
  const chipActions = useMemo(
    () => workflowActions.filter((action) => action.id !== "semanticMerge"),
    [workflowActions],
  );

  // Build a per-author breakdown of the current scope (selected notes, or
  // the whole doc if nothing is selected). Workflows that need to ensure
  // every contributor is represented in their output (currently only
  // `mapContributions`) consume this via the instruction context so the
  // LLM sees a concrete checklist of authors it must cover.
  const authorBreakdown = useMemo(() => {
    const scope = selectedNotes.length > 0 ? selectedNotes : doc.notes;
    const byAuthor = new Map<string, string[]>();
    for (const n of scope) {
      const author = (n.author || "Unknown").trim() || "Unknown";
      if (!byAuthor.has(author)) byAuthor.set(author, []);
      byAuthor.get(author)!.push(n.id);
    }
    return Array.from(byAuthor.entries())
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .map(([author, noteIds]) => ({ author, noteCount: noteIds.length, noteIds }));
  }, [selectedNotes, doc.notes]);

  // Resolve a workflow's full instruction with all available context baked
  // in (currently just `userName` + `authorBreakdown`). Use this everywhere
  // we need a consistent canonical instruction string — the chip click
  // handler, the active-chip equality check, the surface-switch reset
  // effect, and the demo automation runner all must agree.
  const resolveActionInstruction = useCallback(
    (action: WorkflowAction, count: number) =>
      action.instruction(count, { userName, authorBreakdown }),
    [authorBreakdown, userName],
  );

  const textReviews = useMemo(
    () => buildTextReviews(proposal?.edits ?? [], sourceSnapshot),
    [proposal, sourceSnapshot],
  );

  const selectedEdits = useMemo(
    () =>
      proposal
        ? resolveSelectedEdits(proposal.edits, includedEditIndexes, acceptedChangeIndexes, textReviews)
        : [],
    [proposal, includedEditIndexes, acceptedChangeIndexes, textReviews],
  );
  const proposalImpact = useMemo(
    () => buildProposalImpact(selectedEdits, proposalWorkflowId),
    [selectedEdits, proposalWorkflowId],
  );

  // Diff the current proposal's edits against the previous (rejected) draft.
  // Edits whose signature matches a previous edit are flagged "kept"; the
  // rest are "new". We also count how many previous-draft edits no longer
  // appear ("dropped") to show in the banner.
  const proposalDiff = useMemo(() => {
    if (!proposal || !previousProposal) {
      return { keptIndexes: new Set<number>(), newIndexes: new Set<number>(), droppedCount: 0, hasDiff: false };
    }
    const previousSignatures = new Set(previousProposal.edits.map(buildProposalSignatureKey));
    const currentSignatures = proposal.edits.map(buildProposalSignatureKey);
    const keptIndexes = new Set<number>();
    const newIndexes = new Set<number>();
    const matchedPrevious = new Set<string>();
    currentSignatures.forEach((sig, index) => {
      if (previousSignatures.has(sig) && !matchedPrevious.has(sig)) {
        keptIndexes.add(index);
        matchedPrevious.add(sig);
      } else {
        newIndexes.add(index);
      }
    });
    const droppedCount = previousProposal.edits.length - matchedPrevious.size;
    return { keptIndexes, newIndexes, droppedCount, hasDiff: true };
  }, [proposal, previousProposal]);

  const includedEditCount = proposal
    ? proposal.edits.filter((_, index) => includedEditIndexes.has(index)).length
    : 0;
  const readyEditCount = selectedEdits.length;
  const feedbackMemoryCount = Math.min(feedbackHistory.length, MAX_LOCAL_FEEDBACK);

  const reportAcceptNoChange = useCallback(() => {
    const message = "Nothing changed. The source content no longer matches this draft. Regenerate the conflict draft and accept again.";
    setStatus("error");
    setError(message);
    setDecisionMessage("");
    setShareStatus("Draft kept for review. Regenerate before accepting so the edit matches the latest shared state.");
  }, []);

  useEffect(() => {
    onPreviewChange(proposal ? selectedEdits : null);
  }, [onPreviewChange, proposal, selectedEdits]);

  useEffect(() => () => onPreviewChange(null), [onPreviewChange]);

  useEffect(() => {
    onReviewPhaseChange(reviewPhase);
  }, [onReviewPhaseChange, reviewPhase]);

  useEffect(() => () => onReviewPhaseChange("idle"), [onReviewPhaseChange]);

  useEffect(() => {
    onFeedbackMemoryChange(feedbackMemoryCount);
  }, [feedbackMemoryCount, onFeedbackMemoryChange]);

  useEffect(() => () => onFeedbackMemoryChange(0), [onFeedbackMemoryChange]);

  const updateInstruction = useCallback((value: string, workflowId?: DemoWorkflowId) => {
    setInstruction(value);
    setActiveWorkflowId(workflowId);
    if (status === "accepted" || status === "rejected" || status === "error") {
      setStatus("idle");
      setDecisionMessage("");
      setShareStatus("");
      setError("");
    }
  }, [status]);

  useEffect(() => {
    if (proposal) return;
    const selectedCount = selectedNotes.length;
    const currentSurfaceActions = workflowActions.map((action) => resolveActionInstruction(action, selectedCount));
    if (currentSurfaceActions.includes(instruction)) return;
    const knownCanvasInstruction = WORKFLOW_ACTIONS.some((action) => resolveActionInstruction(action, selectedCount) === instruction);
    const knownTextInstruction = TEXT_SURFACE_WORKFLOW_ACTIONS.some((action) => resolveActionInstruction(action, selectedCount) === instruction);
    // Also treat the BASE (un-contextualized) form of any known workflow
    // instruction as "known", so the initial useState seed (which can't
    // depend on authorBreakdown) gets upgraded to the contextualized
    // version on first render.
    const knownBaseInstruction =
      WORKFLOW_ACTIONS.some((action) => action.instruction(selectedCount) === instruction) ||
      TEXT_SURFACE_WORKFLOW_ACTIONS.some((action) => action.instruction(selectedCount) === instruction);
    if (surfaceMode === "text" || knownTextInstruction || knownCanvasInstruction || knownBaseInstruction) {
      // Intentional reset when the active surface changes between canvas/text
      // so the panel never shows a chip preset that no longer applies. Safe
      // because the effect is gated on `proposal === null` and an instruction
      // membership check above.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      updateInstruction(resolveActionInstruction(workflowActions[0], selectedCount), toDemoWorkflowId(workflowActions[0].id));
    }
  }, [instruction, proposal, selectedNotes.length, surfaceMode, updateInstruction, workflowActions, resolveActionInstruction]);

  const clearProposal = useCallback(() => {
    setProposal(null);
    setProposalWorkflowId(undefined);
    setSourceSnapshot(null);
    setIncludedEditIndexes(new Set());
    setAcceptedChangeIndexes({});
    setShareText("");
    // The "vs previous draft" diff banner should only persist while the
    // current proposal is still on screen. Once the draft is accepted or the
    // workflow is reset, the comparison no longer makes sense.
    setPreviousProposal(null);
  }, []);

  const recordHistory = useCallback((
    decision: ReviewHistoryItem["decision"],
    currentProposal: AiProposalResponse,
    editCount: number,
    instructionForHistory = instruction,
  ) => {
    const timestamp = createTimestamp();
    setReviewHistory((current) => [
      {
        id: `${timestamp}-${decision}`,
        decision,
        summary: currentProposal.summary,
        editCount,
        providerLabel,
        instruction: instructionForHistory,
        timestamp,
      },
      ...current,
    ].slice(0, 5));
  }, [instruction, providerLabel]);

  const generateProposalDraft = useCallback(async (
    feedbackForRequest: ProposalFeedback[] = feedbackHistory,
    instructionForRequest: string = instruction,
    selectedNotesForRequest: StickyNote[] = selectedNotes,
    workflowIdForRequest?: DemoWorkflowId,
    previousProposalOverride?: AiProposalResponse | null,
  ): Promise<AiProposalResponse | null> => {
    if (!aiEnabled) {
      clearProposal();
      setStatus("error");
      setError(hostedDisabledMessage);
      return null;
    }

    const snapshot = createAiRequestSnapshot(doc, {
      surfaceMode,
      targetNoteIds: selectedNotesForRequest.map((note) => note.id),
    });
    setStatus("loading");
    setDecisionMessage("");
    setShareStatus("");
    setShareText("");
    setError("");
    setProposal(null);
    setProposalWorkflowId(undefined);
    setSourceSnapshot(snapshot);
    setIncludedEditIndexes(new Set());
    setAcceptedChangeIndexes({});

    try {
      const next = await provider.propose({
        instruction: instructionForRequest,
        document: snapshot,
        target: buildAiTarget(selectedNotesForRequest),
        groundingSources,
        feedback: feedbackForRequest,
        workflowId: workflowIdForRequest,
        // Tell the model and the deterministic post-processors what "today"
        // is so the priority spotlight can prefer fresh notes instead of
        // re-picking weeks-old keyword matches.
        currentDateIso: new Date().toISOString(),
        // When this is a regenerate after reject, hand the model the exact
        // edits it should NOT repeat. Without this the model often re-picks
        // the same target note even with feedback text attached, because the
        // rejected proposal itself was not in its context.
        previousProposal: (previousProposalOverride ?? previousProposal) ?? undefined,
      });
      const nextReviews = buildTextReviews(next.edits, snapshot);
      setProposal(next);
      setProposalWorkflowId(workflowIdForRequest);
      setIncludedEditIndexes(new Set(next.edits.map((_, index) => index)));
      setAcceptedChangeIndexes(createDefaultChangeSelections(nextReviews));
      setStatus("idle");
      return next;
    } catch (err) {
      clearProposal();
      setStatus("error");
      setError(err instanceof Error ? err.message : "Unable to generate proposal.");
      return null;
    }
  }, [aiEnabled, clearProposal, doc, feedbackHistory, groundingSources, hostedDisabledMessage, instruction, previousProposal, provider, selectedNotes, surfaceMode]);

  const generateProposal = useCallback(async (
    feedbackForRequest: ProposalFeedback[] = feedbackHistory,
  ): Promise<boolean> => {
    return Boolean(await generateProposalDraft(feedbackForRequest, instruction, selectedNotes, activeWorkflowId));
  }, [activeWorkflowId, feedbackHistory, generateProposalDraft, instruction, selectedNotes]);

  const reconcileTension = useCallback(async (
    tension: SemanticTension,
    options?: { autoAccept?: boolean; previewMs?: number },
  ): Promise<boolean> => {
    if (status === "loading") return false;
    const conflictingNotes = doc.notes.filter((note) => tension.noteIds.includes(note.id));
    if (conflictingNotes.length < 2) return false;
    const semanticMergeAction = WORKFLOW_ACTIONS.find((action) => action.id === "semanticMerge");
    if (!semanticMergeAction) return false;
    const participantNotes = conflictingNotes.filter((note) => note.author === userName);
    const actionInstruction = semanticMergeAction.instruction(conflictingNotes.length, {
      userName,
      participantNotes: participantNotes.map((n) => ({ id: n.id, author: n.author, text: n.text })),
      conflictingNotes: conflictingNotes.map((n) => ({ id: n.id, author: n.author, text: n.text })),
    });
    updateInstruction(actionInstruction, "semanticMerge");
    const next = await generateProposalDraft(feedbackHistory, actionInstruction, conflictingNotes, "semanticMerge");
    if (!next) return false;
    if (options?.autoAccept) {
      await delay(options.previewMs ?? 1200);
      const accepted = onAccept(next.edits);
      if (!accepted) {
        reportAcceptNoChange();
        return false;
      }
      recordHistory("accepted", next, next.edits.length, actionInstruction);
      clearProposal();
      setStatus("accepted");
      setDecisionMessage(
        `Accepted ${next.edits.length} reconciled change${next.edits.length === 1 ? "" : "s"} into the shared document as ${userName}.`,
      );
      await delay(350);
    }
    return true;
  }, [
    clearProposal,
    doc.notes,
    feedbackHistory,
    generateProposalDraft,
    onAccept,
    recordHistory,
    reportAcceptNoChange,
    status,
    updateInstruction,
    userName,
  ]);

  const runTensionReconcileDemo = useCallback(async (
    options?: DemoTensionReconcileOptions,
  ): Promise<boolean> => {
    const firstTension = tensions[0];
    if (!firstTension) return false;
    return reconcileTension(firstTension, options);
  }, [reconcileTension, tensions]);

  const runWorkflowDemo = useCallback(async ({
    workflowId,
    label,
    autoAccept = false,
    forceWholeCanvas = false,
    previewMs = 1400,
  }: DemoWorkflowOptions): Promise<boolean> => {
    const targetNotes = forceWholeCanvas ? [] : selectedNotes;
    const targetCount = targetNotes.length;
    const action = WORKFLOW_ACTIONS.find((workflowAction) =>
      workflowAction.id === workflowId || (label ? workflowAction.label(targetCount) === label : false)
    );
    if (!action) return false;

    // Match the chip-click path: surface the author roster to workflows
    // that need it (mapContributions) so demo automation produces the
    // same complete coverage a manual click does.
    const actionInstruction = resolveActionInstruction(action, targetCount);
    const workflowIdForAction = toDemoWorkflowId(action.id);
    updateInstruction(actionInstruction, workflowIdForAction);
    const next = await generateProposalDraft(feedbackHistory, actionInstruction, targetNotes, workflowIdForAction);
    if (!next) return false;

    if (autoAccept) {
      await delay(previewMs);
      const accepted = onAccept(next.edits);
      if (!accepted) {
        reportAcceptNoChange();
        return false;
      }
      recordHistory("accepted", next, next.edits.length, actionInstruction);
      clearProposal();
      setStatus("accepted");
      setDecisionMessage(
        `Accepted ${next.edits.length} change${next.edits.length === 1 ? "" : "s"} into the shared document as ${userName}.`,
      );
      await delay(350);
    }

    return true;
  }, [
    clearProposal,
    feedbackHistory,
    generateProposalDraft,
    onAccept,
    recordHistory,
    reportAcceptNoChange,
    resolveActionInstruction,
    selectedNotes,
    updateInstruction,
    userName,
  ]);

  const runFeedbackLoopDemo = useCallback(async ({
    autoAccept = false,
    forceWholeCanvas = true,
    previewMs = 1100,
  }: DemoFeedbackLoopOptions = {}): Promise<boolean> => {
    const targetNotes = forceWholeCanvas ? [] : selectedNotes;
    const targetCount = targetNotes.length;
    const action = WORKFLOW_ACTIONS.find((workflowAction) => workflowAction.id === "clarifyState");
    if (!action) return false;

    const actionInstruction = action.instruction(targetCount);
    updateInstruction(actionInstruction, "clarifyState");
    setRevisionPreset("smaller");
    setRejectionReason("needsSmallerEdits");
    setRejectionDetails(FEEDBACK_LOOP_DEMO_DETAILS);

    const firstDraft = await generateProposalDraft(feedbackHistory, actionInstruction, targetNotes, "clarifyState");
    if (!firstDraft) return false;

    await delay(previewMs);
    const feedbackItem: ProposalFeedback = {
      reason: "needsSmallerEdits",
      details: FEEDBACK_LOOP_DEMO_DETAILS,
      instruction: actionInstruction,
      summary: firstDraft.summary,
      timestamp: createTimestamp(),
    };
    const nextFeedback = [feedbackItem, ...feedbackHistory].slice(0, MAX_LOCAL_FEEDBACK);
    recordHistory("rejected", firstDraft, firstDraft.edits.length, actionInstruction);
    setFeedbackHistory(nextFeedback);
    clearProposal();
    setStatus("loading");
    setDecisionMessage("Proposal rejected. Regenerating with local feedback.");

    let feedbackForRevision = nextFeedback;
    let revisedDraft = await generateProposalDraft(feedbackForRevision, actionInstruction, targetNotes, "clarifyState");
    if (!revisedDraft) return false;

    if (proposalLooksRepeated(firstDraft, revisedDraft)) {
      const repeatFeedback: ProposalFeedback = {
        reason: "needsSmallerEdits",
        details: buildRepeatRevisionDetails(FEEDBACK_LOOP_DEMO_DETAILS),
        instruction: actionInstruction,
        summary: revisedDraft.summary,
        timestamp: createTimestamp(),
      };
      feedbackForRevision = [repeatFeedback, ...feedbackForRevision].slice(0, MAX_LOCAL_FEEDBACK);
      setFeedbackHistory(feedbackForRevision);
      setDecisionMessage("First revision repeated the draft. Regenerating once more with a stronger local correction.");
      revisedDraft = await generateProposalDraft(feedbackForRevision, actionInstruction, targetNotes, "clarifyState");
      if (!revisedDraft) return false;
    }

    setShareStatus(
      `Regenerated with local feedback. Feedback memory ${Math.min(feedbackForRevision.length, MAX_LOCAL_FEEDBACK)}/${MAX_LOCAL_FEEDBACK} local revise requests.`,
    );

    if (autoAccept) {
      await delay(previewMs);
      const accepted = onAccept(revisedDraft.edits);
      if (!accepted) {
        reportAcceptNoChange();
        return false;
      }
      recordHistory("accepted", revisedDraft, revisedDraft.edits.length, actionInstruction);
      clearProposal();
      setStatus("accepted");
      setDecisionMessage(
        `Accepted revised draft with local feedback into the shared document as ${userName}.`,
      );
      await delay(350);
    }

    return true;
  }, [
    clearProposal,
    feedbackHistory,
    generateProposalDraft,
    onAccept,
    recordHistory,
    reportAcceptNoChange,
    selectedNotes,
    updateInstruction,
    userName,
  ]);

  const toggleEdit = (index: number) => {
    setIncludedEditIndexes((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const setAllEdits = (included: boolean) => {
    if (!proposal) return;
    setIncludedEditIndexes(included ? new Set(proposal.edits.map((_, index) => index)) : new Set());
  };

  const toggleTextChange = (editIndex: number, changeIndex: number) => {
    setAcceptedChangeIndexes((current) => {
      const currentSet = current[editIndex] ?? new Set<number>();
      const nextSet = new Set(currentSet);
      if (nextSet.has(changeIndex)) nextSet.delete(changeIndex);
      else nextSet.add(changeIndex);
      return { ...current, [editIndex]: nextSet };
    });
  };

  const setAllTextChanges = (editIndex: number, accepted: boolean) => {
    const review = textReviews.get(editIndex);
    if (!review) return;
    setAcceptedChangeIndexes((current) => ({
      ...current,
      [editIndex]: accepted ? allChangeIndexes(review) : new Set<number>(),
    }));
  };

  const acceptProposal = (mode: "selected" | "whole") => {
    if (!proposal) return;
    const editsToApply = mode === "whole" ? proposal.edits : selectedEdits;
    if (editsToApply.length === 0) return;
    const accepted = onAccept(editsToApply);
    if (!accepted) {
      reportAcceptNoChange();
      return;
    }
    recordHistory("accepted", proposal, editsToApply.length);
    clearProposal();
    setStatus("accepted");
    setDecisionMessage(
      `Accepted ${editsToApply.length} change${editsToApply.length === 1 ? "" : "s"} into the shared document as ${userName}.`,
    );
  };

  const acceptCurrentProposal = useCallback((): boolean => {
    if (!proposal || selectedEdits.length === 0) return false;
    const accepted = onAccept(selectedEdits);
    if (!accepted) {
      reportAcceptNoChange();
      return false;
    }
    recordHistory("accepted", proposal, selectedEdits.length);
    clearProposal();
    setStatus("accepted");
    setDecisionMessage(
      `Accepted ${selectedEdits.length} change${selectedEdits.length === 1 ? "" : "s"} into the shared document as ${userName}.`,
    );
    return true;
  }, [clearProposal, onAccept, proposal, recordHistory, reportAcceptNoChange, selectedEdits, userName]);

  // Pure reject: discard the current draft and return to instruction-editing
  // state without generating a new draft. Unlike `rejectAndReviseProposal`,
  // this does not require feedback text and does not call the AI provider.
  // It is the right action when the reviewer simply does not want this
  // proposal applied or regenerated right now.
  const rejectProposal = useCallback(() => {
    if (!proposal) return;
    recordHistory("rejected", proposal, proposal.edits.length);
    clearProposal();
    setStatus("rejected");
    setDecisionMessage("Draft rejected. Nothing changed in the shared document.");
    setShareStatus("Draft rejected. Edit the instruction or pick another workflow to start again.");
  }, [clearProposal, proposal, recordHistory]);

  useImperativeHandle(
    ref,
    () => ({ runWorkflowDemo, runFeedbackLoopDemo, runTensionReconcileDemo, acceptCurrentProposal }),
    [acceptCurrentProposal, runFeedbackLoopDemo, runTensionReconcileDemo, runWorkflowDemo],
  );

  const rejectAndReviseProposal = async () => {
    if (!proposal) return;
    const feedbackDetails = rejectionDetails.trim();
    if (!feedbackDetails) {
      setShareStatus("Write what should change, then regenerate the draft.");
      rejectionDetailsRef.current?.focus();
      return;
    }
    const feedbackItem: ProposalFeedback = {
      reason: rejectionReason || "notUseful",
      details: feedbackDetails,
      instruction,
      summary: proposal.summary,
      timestamp: createTimestamp(),
    };
    const nextFeedback = [feedbackItem, ...feedbackHistory].slice(0, MAX_LOCAL_FEEDBACK);
    recordHistory("rejected", proposal, proposal.edits.length);
    setFeedbackHistory(nextFeedback);
    setRevisionPreset("");
    setRejectionDetails("");
    const carryWorkflowId = proposalWorkflowId;
    // Snapshot the rejected draft so the next render can diff "kept / new /
    // dropped" once setProposal(revised) lands. clearProposal would wipe it,
    // so we set it explicitly after clearing the current proposal slot.
    const rejectedDraft = proposal;
    clearProposal();
    setPreviousProposal(rejectedDraft);
    setStatus("loading");
    setDecisionMessage("Proposal rejected. Regenerating with local feedback.");
    let feedbackForRevision = nextFeedback;
    let revised = await generateProposalDraft(feedbackForRevision, instruction, selectedNotes, carryWorkflowId, rejectedDraft);
    if (revised && proposalLooksRepeated(proposal, revised)) {
      const repeatFeedback: ProposalFeedback = {
        reason: "needsSmallerEdits",
        details: buildRepeatRevisionDetails(feedbackDetails),
        instruction,
        summary: revised.summary,
        timestamp: createTimestamp(),
      };
      feedbackForRevision = [repeatFeedback, ...feedbackForRevision].slice(0, MAX_LOCAL_FEEDBACK);
      setFeedbackHistory(feedbackForRevision);
      setDecisionMessage("First revision repeated the draft. Regenerating once more with a stronger local correction.");
      revised = await generateProposalDraft(feedbackForRevision, instruction, selectedNotes, carryWorkflowId, rejectedDraft);
    }
    if (revised) {
      setShareStatus(
        `Regenerated with local feedback. Feedback memory ${Math.min(feedbackForRevision.length, MAX_LOCAL_FEEDBACK)}/${MAX_LOCAL_FEEDBACK} local revise requests. Nothing changed in the shared document.`,
      );
    }
  };

  const toggleRevisionPreset = (presetValue: string) => {
    const preset = REVISION_PRESET_OPTIONS.find((option) => option.value === presetValue);
    if (!preset) return;
    if (revisionPreset === presetValue) {
      setRevisionPreset("");
      setRejectionReason("");
      setRejectionDetails((current) => current.trim() === preset.details ? "" : current);
      setShareStatus("");
      window.requestAnimationFrame(() => autosizeTextarea(rejectionDetailsRef.current));
      return;
    }

    setRevisionPreset(presetValue);
    setRejectionReason(preset.reason);
    setRejectionDetails(preset.details);
    setShareStatus("");
    window.requestAnimationFrame(() => autosizeTextarea(rejectionDetailsRef.current));
  };

  // Per-edit feedback chips ("Drop this", "Tighten this", "Wrong target").
  // Each chip appends a structured line to the existing feedback textarea so
  // the reviewer can stack multiple surgical corrections in one Regenerate
  // turn instead of writing prose. The reason field is set to the most
  // specific signal the chip implies.
  const appendEditFeedback = (
    nextLine: string,
    reasonOverride: RejectionReason,
  ) => {
    setRevisionPreset("");
    setRejectionReason(reasonOverride);
    setRejectionDetails((prev) => {
      const trimmed = prev.trim();
      if (!trimmed) return nextLine;
      if (trimmed.split("\n").some((line) => line.trim() === nextLine)) return prev;
      return `${trimmed}\n${nextLine}`;
    });
    setShareStatus("");
    window.requestAnimationFrame(() => {
      autosizeTextarea(rejectionDetailsRef.current);
      rejectionDetailsRef.current?.focus();
    });
  };

  const copyShareSummary = async () => {
    if (!proposal) return;
    const text = buildShareSummary(proposal, selectedEdits, instruction, providerLabel, sourceSnapshot);
    setShareText(text);

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        setShareStatus("Share summary copied.");
      } else {
        setShareStatus("Share summary prepared.");
      }
    } catch {
      setShareStatus("Share summary prepared.");
    }
  };

  return (
    <aside className="act2-panel" data-testid="act2-panel" aria-label="AI review panel">
      <div className="act2-panel__header">
        <div>
          <div className="act2-panel__eyebrow">AI review</div>
        </div>
      </div>

      <div className="trust-ledger" aria-label="AI review trust ledger">
        <span>
          <strong>Draft</strong>
          <em>{!aiEnabled ? "Backend off" : proposal ? "Previewing" : status === "loading" ? "Drafting" : "Ready"}</em>
        </span>
        <span>
          <strong>Sources</strong>
          <em>{!aiEnabled ? "No AI calls" : proposal ? `${proposal.edits.length} moves` : "Prepared"}</em>
        </span>
        <span>
          <strong>Commit</strong>
          <em>{!aiEnabled ? "Manual" : status === "accepted" ? `Shared as ${userName}` : "Required"}</em>
        </span>
        <span>
          <strong>Memory</strong>
          <em>{!aiEnabled ? "Off" : `${feedbackMemoryCount}/${MAX_LOCAL_FEEDBACK}`}</em>
        </span>
      </div>

      {!aiEnabled && (
        <div className="status status--info" role="status">
          {hostedDisabledMessage}
        </div>
      )}

      {surfaceMode === "canvas" && aiEnabled && (
        <TensionsSection
          tensions={tensions}
          loading={tensionsLoading}
          error={tensionsError}
          reconciling={status === "loading"}
          onRefresh={onRefreshTensions}
          onReconcile={(tension) => { void reconcileTension(tension); }}
          notes={doc.notes}
          userName={userName}
        />
      )}

      <div className="act2-panel__section">
        <label className="field-label" htmlFor="act2-instruction">Coauthor goal</label>
        <textarea
          ref={instructionTextareaRef}
          id="act2-instruction"
          data-testid="act2-instruction"
          value={instruction}
          onChange={(event) => updateInstruction(event.target.value)}
          disabled={!aiEnabled}
          placeholder="Tell the AI what to do, or pick a move below."
        />
        <div className="preset-row" aria-label="AI workflow options">
          {chipActions.map((action) => {
            const actionLabel = action.label(selectedNotes.length);
            // For workflows that need awareness of the actual roster of
            // contributors in the scoped notes (currently only
            // `mapContributions`), bake an explicit author breakdown into
            // the prompt so the LLM cannot silently drop low-frequency
            // contributors. Falls through to plain instruction otherwise.
            const actionInstruction = resolveActionInstruction(action, selectedNotes.length);
            const actionTitle = [
              `Does: ${action.does(selectedNotes.length)}`,
              `Improves: ${action.improves(selectedNotes.length)}`,
              `Prompt: ${actionInstruction}`,
            ].join("\n");
            return (
              <button
                type="button"
                key={action.id}
                className={instruction === actionInstruction ? "preset-button preset-button--active" : "preset-button"}
                // Always (re)select the workflow instruction. Previously this
                // was a toggle that cleared the textarea when the chip was
                // already active — which made the chip look broken when the
                // panel boots with that workflow pre-selected (e.g., the
                // guided demo defaults to "Map the room"). The user can
                // clear or edit the goal directly in the textarea.
                onClick={() => updateInstruction(actionInstruction, toDemoWorkflowId(action.id))}
                title={actionTitle}
                disabled={!aiEnabled}
              >
                {actionLabel}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className="primary-button"
          onClick={() => { void generateProposal(); }}
          disabled={!aiEnabled || status === "loading" || instruction.trim().length === 0}
          data-testid="act2-generate"
        >
          {!aiEnabled ? "AI backend not configured" : status === "loading" ? "Drafting" : "Draft the next move"}
        </button>
      </div>

      {status === "loading" && (
        <div className="proposal-skeleton" aria-live="polite">
          <div className="proposal-skeleton__line proposal-skeleton__line--wide" />
          <div className="proposal-skeleton__line" />
          <div className="proposal-skeleton__line proposal-skeleton__line--short" />
        </div>
      )}
      {status === "accepted" && <div className="status status--success" role="status">{decisionMessage}</div>}
      {status === "rejected" && <div className="status" role="status">{decisionMessage}</div>}
      {status === "error" && <div className="status status--error" role="alert">{error}</div>}
      {shareStatus && <div className="status" role="status">{shareStatus}</div>}

      {proposal && (
        <div className="proposal-review">
          <div className="proposal-review__header">
            <div className="proposal-review__brief">
              <span>Coauthor brief</span>
              <p>{proposal.summary}</p>
            </div>
            <div className="proposal-review__counts">
              <span>{proposal.edits.length} proposed</span>
              <span>{readyEditCount} selected</span>
            </div>
          </div>
          <div className="proposal-impact" aria-label="Impact preview">
            <div className="proposal-impact__grid">
              {proposalImpact.map((item) => (
                <div key={item.label} className="proposal-impact__item">
                  <strong>{item.label}</strong>
                  <span>{item.detail}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="proposal-review__tools" aria-label="Proposal selection tools">
            <button type="button" className="secondary-button" onClick={() => setAllEdits(true)}>
              Include all
            </button>
            <button type="button" className="secondary-button" onClick={() => setAllEdits(false)}>
              Skip all
            </button>
          </div>
          <details className="share-panel">
            <summary>Share selected moves</summary>
            <button type="button" className="secondary-button" onClick={copyShareSummary}>
              Copy storyline
            </button>
            {shareText && (
              <textarea
                className="share-text"
                value={shareText}
                readOnly
                aria-label="Shareable proposal summary"
                rows={5}
              />
            )}
          </details>
          <div>
            <div className="proposal-section-heading">
              <span>Choose the moves</span>
              <strong>{includedEditCount}/{proposal.edits.length} included</strong>
            </div>
            {proposalDiff.hasDiff && (
              <div className="proposal-diff-banner" role="status">
                <strong>Based on your feedback</strong>
                <span>
                  {proposalDiff.newIndexes.size} new
                  {" \u00b7 "}
                  {proposalDiff.keptIndexes.size} kept
                  {" \u00b7 "}
                  {proposalDiff.droppedCount} dropped
                </span>
              </div>
            )}
            <ol className="edit-list">
              {proposal.edits.map((edit, index) => {
                const included = includedEditIndexes.has(index);
                const diffTag = proposalDiff.hasDiff
                  ? proposalDiff.newIndexes.has(index)
                    ? "new"
                    : proposalDiff.keptIndexes.has(index)
                      ? "kept"
                      : null
                  : null;
                return (
                  <li
                    key={`${edit.type}-${index}`}
                    className={included ? "edit-list__item" : "edit-list__item edit-list__item--excluded"}
                    data-edit-diff={diffTag ?? undefined}
                  >
                    <label className="edit-include">
                      <input
                        type="checkbox"
                        checked={included}
                        onChange={() => toggleEdit(index)}
                      />
                      <span>{included ? "Included" : "Skipped"}</span>
                    </label>
                    <details className="edit-collapse" open={index === 0}>
                      <summary>
                        Change {index + 1}: {getEditQuickLabel(edit, proposalWorkflowId)}
                        {diffTag && (
                          <span className={`edit-diff-badge edit-diff-badge--${diffTag}`}>{diffTag}</span>
                        )}
                      </summary>
                      <div className="edit-collapse__body">
                        {renderEdit({
                          edit,
                          index,
                          included,
                          textReview: textReviews.get(index),
                          acceptedChanges: acceptedChangeIndexes[index] ?? new Set<number>(),
                          sourceSnapshot,
                          groundingSources,
                          workflowId: proposalWorkflowId,
                          onToggleTextChange: toggleTextChange,
                          onSetAllTextChanges: setAllTextChanges,
                        })}
                        <div className="edit-card__feedback-chips" role="group" aria-label="Quick feedback for this change">
                          <span className="edit-card__feedback-label">Feedback on this change:</span>
                          <button
                            type="button"
                            className="edit-card__feedback-chip"
                            onClick={() => appendEditFeedback(
                              `Drop change #${index + 1} (${getEditQuickLabel(edit, proposalWorkflowId)}) from the next draft.`,
                              "notUseful",
                            )}
                            title="Append a 'drop this change' line to the feedback box."
                          >
                            Drop
                          </button>
                          <button
                            type="button"
                            className="edit-card__feedback-chip"
                            onClick={() => appendEditFeedback(
                              `Tighten change #${index + 1} (${getEditQuickLabel(edit, proposalWorkflowId)}). Keep only the highest-value part, cut prose and meta.`,
                              "tooBroad",
                            )}
                            title="Append a 'tighten this change' line to the feedback box."
                          >
                            Tighten
                          </button>
                          <button
                            type="button"
                            className="edit-card__feedback-chip"
                            onClick={() => appendEditFeedback(
                              `Change #${index + 1} (${getEditQuickLabel(edit, proposalWorkflowId)}) targets the wrong note. Pick a more relevant source note for this edit.`,
                              "wrongTarget",
                            )}
                            title="Append a 'wrong target' line to the feedback box."
                          >
                            Wrong target
                          </button>
                        </div>
                      </div>
                    </details>
                  </li>
                );
              })}
            </ol>
          </div>
          <div className="reject-feedback">
            <div className="proposal-section-heading">
              <span>Tune the draft</span>
              <strong title={`AI remembers up to ${MAX_LOCAL_FEEDBACK} local revise requests in this browser session.`}>
                Memory {feedbackMemoryCount}/{MAX_LOCAL_FEEDBACK}
              </strong>
            </div>
            <div className="reject-feedback__controls">
              <div
                className="reject-feedback__preset-group"
                role="group"
                aria-label="Optional revision presets"
                data-testid="revision-preset"
              >
                {REVISION_PRESET_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={
                      revisionPreset === option.value
                        ? "reject-feedback__preset reject-feedback__preset--active"
                        : "reject-feedback__preset"
                    }
                    aria-pressed={revisionPreset === option.value}
                    onClick={() => toggleRevisionPreset(option.value)}
                    title={option.details}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <textarea
                ref={rejectionDetailsRef}
                value={rejectionDetails}
                onChange={(event) => {
                  setRejectionDetails(event.target.value);
                  if (revisionPreset) setRevisionPreset("");
                }}
                onInput={(event) => autosizeTextarea(event.currentTarget)}
                placeholder="Write your own correction, or pick an optional preset"
                aria-label="Reject feedback details"
                rows={3}
              />
            </div>
            <p className="reject-feedback__hint">
              Write one concrete correction. AI remembers up to {MAX_LOCAL_FEEDBACK} local revise requests in this browser session; older feedback drops off, and nothing is shared until Accept.
            </p>
          </div>
          <div className="review-actions review-actions--quad">
            <button
              type="button"
              className="secondary-button review-actions__reject"
              onClick={rejectProposal}
              data-testid="act2-reject-discard"
              title="Discard this draft without regenerating. Nothing changes in the shared document."
            >
              Reject
            </button>
            <button type="button" className="secondary-button" onClick={rejectAndReviseProposal} data-testid="act2-reject">
              Regenerate with feedback
            </button>
            <button type="button" className="secondary-button" onClick={() => acceptProposal("whole")}>
              Accept whole
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={() => acceptProposal("selected")}
              disabled={includedEditCount === 0 || readyEditCount === 0}
              data-testid="act2-accept"
            >
              Accept selected
            </button>
          </div>
        </div>
      )}



      {reviewHistory.length > 0 && (
        <details className="history-details" open={reviewHistory.length <= 1}>
          <summary>
            <span>This session</span>
            <strong>{reviewHistory.length} item{reviewHistory.length === 1 ? "" : "s"}</strong>
          </summary>
          <div className="review-history">
            {reviewHistory.map((item) => (
              <div key={item.id} className="review-history__item">
                <div>
                  <strong>{item.decision === "accepted" ? "Accepted" : "Rejected"} {item.editCount} change{item.editCount === 1 ? "" : "s"}</strong>
                  <span>{formatTime(item.timestamp)} · {item.providerLabel}</span>
                </div>
                <p>{item.summary}</p>
              </div>
            ))}
          </div>
        </details>
      )}

      {feedbackHistory.length > 0 && (
        <details className="history-details" open={feedbackHistory.length <= 1}>
          <summary>
            <span>Feedback memory</span>
            <strong>{feedbackHistory.length}/{MAX_LOCAL_FEEDBACK} local</strong>
          </summary>
          <div className="review-history">
            {feedbackHistory.map((item) => (
              <div key={`${item.timestamp}-${item.reason}`} className="review-history__item">
                <div>
                  <strong>{formatReason(item.reason)}</strong>
                  <span>{formatTime(item.timestamp)}</span>
                </div>
                <p>{item.details || item.summary}</p>
              </div>
            ))}
          </div>
        </details>
      )}
    </aside>
  );
});

function buildAiTarget(selectedNotes: StickyNote[]) {
  if (selectedNotes.length === 0) return { kind: "canvas" as const };
  if (selectedNotes.length === 1) return { kind: "note" as const, id: selectedNotes[0].id };
  return { kind: "notes" as const, ids: selectedNotes.map((note) => note.id) };
}

function renderEdit({
  edit,
  index,
  included,
  textReview,
  acceptedChanges,
  sourceSnapshot,
  groundingSources,
  workflowId,
  onToggleTextChange,
  onSetAllTextChanges,
}: {
  edit: AiProposalEdit;
  index: number;
  included: boolean;
  textReview?: TextReview;
  acceptedChanges: Set<number>;
  sourceSnapshot: CanvasSnapshot | null;
  groundingSources: GroundingSource[];
  workflowId?: DemoWorkflowId;
  onToggleTextChange: (editIndex: number, changeIndex: number) => void;
  onSetAllTextChanges: (editIndex: number, accepted: boolean) => void;
}) {
  if (edit.type === "addNote") {
    const noteLabel = getAddNoteReviewLabel(edit.text);
    return (
      <div className="edit-card">
        {renderEditHeader(index, noteLabel.action, noteLabel.detail)}
        <div className="edit-card__content">{edit.text}</div>
        {renderImprovement(edit, sourceSnapshot)}
        {renderEvidence(edit, sourceSnapshot, groundingSources)}
      </div>
    );
  }

  if (edit.type === "updateNoteText") {
    const acceptedText = textReview ? buildAcceptedText(textReview, acceptedChanges) : edit.text;
    return (
      <div className="edit-card edit-card--text-update">
        {renderEditHeader(index, "Rewrite note", "Text review")}
        <div className="text-diff-grid">
          <div>
            <div className="field-label">Before</div>
            <div className="edit-card__content edit-card__content--before">
              {textReview?.originalText ?? "Original note unavailable."}
            </div>
          </div>
          <div>
            <div className="field-label">Accepted preview</div>
            <div className="edit-card__content edit-card__content--accepted">
              {acceptedText}
            </div>
          </div>
        </div>
        {textReview && textReview.changeCount > 0 && (
          <>
            <div className="partial-controls">
              <button
                type="button"
                className="secondary-button"
                disabled={!included}
                onClick={() => onSetAllTextChanges(index, true)}
              >
                Accept whole update
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={!included}
                onClick={() => onSetAllTextChanges(index, false)}
              >
                Keep original
              </button>
            </div>
            <div className="inline-diff" aria-label="Inline review parts">
              {textReview.segments.map((segment, segmentIndex) => {
                if (segment.kind === "equal") {
                  return (
                    <div key={`equal-${segmentIndex}`} className="diff-part diff-part--same">
                      {joinUnits(segment.units, textReview.mode)}
                    </div>
                  );
                }

                const accepted = acceptedChanges.has(segment.changeIndex);
                return (
                  <div
                    key={`change-${segment.changeIndex}`}
                    className={accepted ? "diff-part diff-part--accepted" : "diff-part"}
                  >
                    <label className="diff-part__toggle">
                      <input
                        type="checkbox"
                        checked={accepted}
                        disabled={!included}
                        onChange={() => onToggleTextChange(index, segment.changeIndex)}
                      />
                      <span>{accepted ? "Accept part" : "Keep original"}</span>
                    </label>
                    <div className="diff-columns">
                      <div>
                        <span>Original</span>
                        <p>{joinUnits(segment.original, textReview.mode) || "No original text"}</p>
                      </div>
                      <div>
                        <span>Proposed</span>
                        <p>{joinUnits(segment.proposed, textReview.mode) || "No proposed text"}</p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
        {renderImprovement(edit, sourceSnapshot)}
        {renderEvidence(edit, sourceSnapshot, groundingSources)}
      </div>
    );
  }

  if (edit.type === "moveNote") {
    return (
      <div className="edit-card">
        {renderEditHeader(index, "Move note", "Preview on canvas")}
        <div className="edit-card__content">
          {getMoveNoteReviewText(edit, sourceSnapshot)}
        </div>
        {renderImprovement(edit, sourceSnapshot)}
        {renderEvidence(edit, sourceSnapshot, groundingSources)}
      </div>
    );
  }

  if (edit.type === "deleteNote") {
    const isSemanticMerge = workflowId === "semanticMerge";
    return (
      <div className="edit-card">
        {renderEditHeader(index, isSemanticMerge ? "Remove source note" : "Replace source note", isSemanticMerge ? "Distilled into the brief" : "Captured in map")}
        <div className="edit-card__content">
          {getDeleteNoteReviewText(edit, sourceSnapshot)}
        </div>
        {renderImprovement(edit, sourceSnapshot)}
        {renderEvidence(edit, sourceSnapshot, groundingSources)}
      </div>
    );
  }

  if (edit.type === "addTask") {
    return (
      <div className="edit-card">
        {renderEditHeader(index, "Create task", edit.owner || edit.sourceAuthors?.join(", ") || "Source-traced")}
        <div className="edit-card__content">{edit.title}</div>
        {renderTaskMetadata(edit, sourceSnapshot)}
        {renderImprovement(edit, sourceSnapshot)}
        {renderEvidence(edit, sourceSnapshot, groundingSources)}
      </div>
    );
  }

  if (edit.type === "addHighlight") {
    const sourceNote = sourceNoteForHighlight(edit, sourceSnapshot);
    const isSemanticMerge = workflowId === "semanticMerge";
    return (
      <div className="edit-card">
        {renderEditHeader(index, isSemanticMerge ? "Mark conflict source" : "Underline priority", isSemanticMerge ? "Quoted in brief" : "Inside note")}
        <div className="edit-card__content edit-card__content--highlight">
          {edit.text}
        </div>
        {sourceNote && (
          <div className="task-metadata">
            <span>Canvas target: {sourceNote.author}'s note</span>
          </div>
        )}
        {renderImprovement(edit, sourceSnapshot)}
        {renderEvidence(edit, sourceSnapshot, groundingSources)}
      </div>
    );
  }

  if (edit.type === "replaceSpan") {
    const targetNote = sourceSnapshot?.notes.find((note) => note.id === edit.noteId);
    return (
      <div className="edit-card edit-card--replace-span">
        {renderEditHeader(index, "Reconcile your phrase", "Edits only your own note")}
        <div className="replace-span-card">
          <div className="replace-span-card__row replace-span-card__row--before">
            <span className="replace-span-card__label">Before</span>
            <span className="replace-span-card__text">{edit.find}</span>
          </div>
          <div className="replace-span-card__row replace-span-card__row--after">
            <span className="replace-span-card__label">After</span>
            <span className="replace-span-card__text">{edit.replace}</span>
          </div>
        </div>
        {targetNote && (
          <div className="task-metadata">
            <span>Canvas target: {targetNote.author}'s note &middot; rest of the note is untouched</span>
          </div>
        )}
        {renderImprovement(edit, sourceSnapshot)}
        {renderEvidence(edit, sourceSnapshot, groundingSources)}
      </div>
    );
  }

  return (
    <div className="edit-card">
      {renderEditHeader(index, "Add visual marker", toTitleCase(edit.shape))}
      <div className="edit-card__content">
        Adds a {edit.shape} marker inside the related note.
      </div>
      {renderImprovement(edit, sourceSnapshot)}
      {renderEvidence(edit, sourceSnapshot, groundingSources)}
    </div>
  );
}

function renderEditHeader(index: number, action: string, detail?: string) {
  return (
    <div className="edit-card__meta">
      <span>Change {index + 1}: {action}</span>
      {detail && <span>{detail}</span>}
    </div>
  );
}

function getEditQuickLabel(edit: AiProposalEdit, workflowId?: DemoWorkflowId): string {
  if (edit.type === "addNote") return getAddNoteReviewLabel(edit.text).action;
  if (edit.type === "updateNoteText") return "Rewrite note";
  if (edit.type === "moveNote") return "Move note";
  if (edit.type === "deleteNote") {
    return workflowId === "semanticMerge" ? "Remove source note" : "Replace source note";
  }
  if (edit.type === "addTask") return "Create task";
  if (edit.type === "addHighlight") {
    return workflowId === "semanticMerge" ? "Mark conflict source" : "Underline priority";
  }
  if (edit.type === "replaceSpan") return "Reconcile your phrase";
  return "Add visual marker";
}

function renderTaskMetadata(edit: Extract<AiProposalEdit, { type: "addTask" }>, snapshot: CanvasSnapshot | null) {
  const sourceNotes = (edit.sourceNoteIds ?? [])
    .map((id) => snapshot?.notes.find((note) => note.id === id))
    .filter((note): note is CanvasSnapshot["notes"][number] => Boolean(note));
  const authors = edit.sourceAuthors?.length
    ? edit.sourceAuthors
    : [...new Set(sourceNotes.map((note) => note.author).filter(Boolean))];
  const sourceTimes = edit.sourceCreatedAt?.length
    ? edit.sourceCreatedAt
    : sourceNotes.map((note) => note.createdAt).filter((time): time is number => typeof time === "number");

  if (authors.length === 0 && sourceTimes.length === 0 && !edit.timing) return null;

  return (
    <div className="task-metadata">
      {authors.length > 0 && <span>From {authors.join(", ")}</span>}
      {sourceTimes.length > 0 && <span>Added {formatTime(Math.min(...sourceTimes))}</span>}
      {edit.timing && <span>Timing {edit.timing}</span>}
    </div>
  );
}

function getAddNoteReviewLabel(text: string): { action: string; detail: string } {
  const firstLine = text.trim().split(/\r?\n/)[0] ?? "";
  if (/^contributor map$/i.test(firstLine)) return { action: "Add contributor map", detail: "Source-preserving room map" };
  if (/^shared state$/i.test(firstLine)) return { action: "Add shared-state brief", detail: "Current / Next / Open" };
  if (/^semantic merge$/i.test(firstLine)) return { action: "Add semantic merge", detail: "Agreement / tension / next move" };
  if (/\bsummary$/i.test(firstLine) || /^contributor\s*:/i.test(firstLine)) return { action: "Add map summary", detail: firstLine };
  if (/\binput$/i.test(firstLine)) return { action: "Add contributor header", detail: firstLine };
  const laneLabel = getLaneHeaderLabel(text);
  if (laneLabel) return { action: "Add group header", detail: laneLabel };
  return { action: "Add sticky note", detail: "New note" };
}

function getLaneHeaderLabel(text: string): string | null {
  const firstLine = text.trim().split(/\r?\n/)[0]?.toLowerCase() ?? "";
  if (firstLine === "contributor map") return "Contributor map";
  if (firstLine === "shared state") return "Shared state";
  if (/\bsummary$/.test(firstLine) || /^contributor\s*:/.test(firstLine)) return "Contributor";
  if (/\binput$/.test(firstLine)) return "Contributor";
  if (/\bcontext|background|facts?\b/.test(firstLine)) return "Context";
  if (/\brisks?|blockers?|unknowns?\b/.test(firstLine)) return "Risks";
  if (/\bnext steps?|actions?|follow-ups?\b/.test(firstLine)) return "Next steps";
  return null;
}

function getMoveNoteReviewText(edit: Extract<AiProposalEdit, { type: "moveNote" }>, snapshot: CanvasSnapshot | null): string {
  const sourceNote = snapshot?.notes.find((note) => note.id === edit.id);
  if (!sourceNote) return "Moves an existing note into the proposed group shown on the canvas.";
  return `Moves "${truncate(sourceNote.text || "Untitled note", 80)}" into the proposed group shown on the canvas.`;
}

function getDeleteNoteReviewText(edit: Extract<AiProposalEdit, { type: "deleteNote" }>, snapshot: CanvasSnapshot | null): string {
  const sourceNote = snapshot?.notes.find((note) => note.id === edit.id);
  const semanticDelete = edit.rationale?.toLowerCase().includes("semantic") ?? false;
  const mergeTarget = semanticDelete ? "decision brief" : "contributor map";
  if (!sourceNote) return `Captures one source note in the ${mergeTarget}, then removes the original sticky.`;
  if (edit.rationale?.toLowerCase().includes("semantic")) {
    return `Merges "${truncate(sourceNote.text || "Untitled note", 96)}" into the decision brief, then removes the original sticky.`;
  }
  return `Replaces "${truncate(sourceNote.text || "Untitled note", 96)}" after the contributor map captures its signal.`;
}

function renderImprovement(edit: AiProposalEdit, snapshot: CanvasSnapshot | null) {
  const improvement = describeImprovement(edit, snapshot);
  if (!improvement) return null;
  return (
    <div className="edit-improvement">
      <span>Improves</span>
      <p>{improvement}</p>
    </div>
  );
}

function describeImprovement(edit: AiProposalEdit, snapshot: CanvasSnapshot | null): string | null {
  if (edit.type === "addNote") {
    const firstLine = edit.text.trim().split(/\r?\n/)[0]?.toLowerCase() ?? "";
    if (firstLine === "semantic merge") {
      return "Combines parallel collaborator intent into one reviewable brief while preserving source contributors.";
    }
    const laneLabel = getLaneHeaderLabel(edit.text);
    if (laneLabel) {
      if (laneLabel === "Contributor map") return "Creates a visible map layer so the team can scan who contributed which signal.";
      if (laneLabel === "Contributor") return "Adds a readable contributor map that will replace the scattered source layer after review.";
      if (laneLabel === "Shared state") return "Separates the project state into reviewable stages without rewriting the source notes.";
      return `Turns loose notes into a named ${laneLabel} lane, so the board reads as a structured workspace instead of scattered stickies.`;
    }
    return "Adds a concise derived note so important context is visible on the board.";
  }

  if (edit.type === "updateNoteText") {
    const sourceNote = snapshot?.notes.find((note) => note.id === edit.id);
    if (!sourceNote) return "Rewrites the note into a cleaner review-ready version.";
    return `Turns "${truncate(sourceNote.text || "Untitled note", 72)}" into a review brief with clearer context, next action, and open question.`;
  }

  if (edit.type === "moveNote") {
    const sourceNote = snapshot?.notes.find((note) => note.id === edit.id);
    const lane = sourceNote ? classifyReviewLane(sourceNote.text) : "the right group";
    return `Keeps the original content, but makes its role clearer by placing it under ${lane}.`;
  }

  if (edit.type === "deleteNote") {
    const sourceNote = firstSourceNote(edit, snapshot);
    const target = edit.rationale?.toLowerCase().includes("semantic") ? "decision brief" : "contributor map";
    if (!sourceNote) return `Removes a source sticky after its content has been captured in the ${target}.`;
    if (edit.rationale?.toLowerCase().includes("semantic")) {
      return `Reduces duplicate or competing canvas state by folding ${sourceNote.author}'s sticky into the decision brief.`;
    }
    return `Shows the transformation clearly by replacing ${sourceNote.author}'s original sticky after the map captures the signal.`;
  }

  if (edit.type === "addTask") {
    const sourceNote = firstSourceNote(edit, snapshot);
    if (!sourceNote) return "Converts a loose next step into a trackable shared task.";
    return `Converts "${truncate(sourceNote.text || "Untitled note", 72)}" into the action-ready task "${truncate(edit.title, 72)}".`;
  }

  if (edit.type === "addHighlight") {
    const sourceNote = firstSourceNote(edit, snapshot);
    if (!sourceNote) return "Underlines the priority phrase without changing the underlying note text.";
    return `Underlines "${truncate(edit.text, 72)}" inside ${sourceNote.author}'s source note so the priority stays attached to the evidence.`;
  }

  if (edit.type === "replaceSpan") {
    const targetNote = snapshot?.notes.find((note) => note.id === edit.noteId);
    const owner = targetNote?.author ?? "the reviewer";
    return `Lets ${owner} reconcile by surgically replacing "${truncate(edit.find, 64)}" with a softened version that acknowledges the other side. Nothing else in the note changes.`;
  }

  const sourceNote = firstSourceNote(edit, snapshot);
  if (!sourceNote) return "Adds visible priority without changing the underlying note text.";
  return `Makes "${truncate(sourceNote.text || "Untitled note", 72)}" stand out as the priority item without rewriting it.`;
}

function firstSourceNote(edit: AiProposalEdit, snapshot: CanvasSnapshot | null): CanvasSnapshot["notes"][number] | undefined {
  const [firstId] = edit.sourceNoteIds ?? [];
  return snapshot?.notes.find((note) => note.id === firstId);
}

function sourceNoteForHighlight(
  edit: Extract<AiProposalEdit, { type: "addHighlight" }>,
  snapshot: CanvasSnapshot | null,
): CanvasSnapshot["notes"][number] | undefined {
  return snapshot?.notes.find((note) => note.id === edit.noteId) ?? firstSourceNote(edit, snapshot);
}

function classifyReviewLane(text: string): string {
  const normalized = text.toLowerCase();
  if (/\b(risk|blocker|blocked|auth|permission|unclear|unknown|issue|problem|gap|depend|decision|decide)\b/.test(normalized)) {
    return "Risks";
  }
  if (/\b(next|todo|task|action|follow(?:-?up)?|ask|schedule|owner|meeting|meet|talk|call|sync|implement|ship|build|send|email|ping|confirm|review|assign|due|today|tomorrow)\b/.test(normalized)) {
    return "Next steps";
  }
  return "Context";
}

function buildProposalImpact(edits: AiProposalEdit[], workflowId?: DemoWorkflowId): ProposalImpactItem[] {
  if (edits.length === 0) {
    return [{ label: "No selected moves", detail: "Select at least one coauthor move to preview its impact." }];
  }

  const semanticMerges = edits.filter((edit) =>
    edit.type === "addNote" && /^semantic merge$/i.test(edit.text.trim().split(/\r?\n/)[0] ?? "")
  ).length;
  const contributorMapHeaders = edits.filter((edit) =>
    edit.type === "addNote" && /^contributor map$/i.test(edit.text.trim().split(/\r?\n/)[0] ?? "")
  ).length;
  const contributorSummaries = edits.filter((edit) => {
    const firstLine = edit.type === "addNote" ? edit.text.trim().split(/\r?\n/)[0] ?? "" : "";
    return /\bsummary$/i.test(firstLine) || /^contributor\s*:/i.test(firstLine);
  }).length;
  const groupHeaders = edits.filter((edit) =>
    edit.type === "addNote" &&
    getLaneHeaderLabel(edit.text) &&
    !/^contributor map$/i.test(edit.text.trim().split(/\r?\n/)[0] ?? "") &&
    !/\bsummary$/i.test(edit.text.trim().split(/\r?\n/)[0] ?? "")
  ).length;
  const stickyNotes = edits.filter((edit) =>
    edit.type === "addNote" &&
    !getLaneHeaderLabel(edit.text) &&
    !/^semantic merge$/i.test(edit.text.trim().split(/\r?\n/)[0] ?? "")
  ).length;
  const rewrites = edits.filter((edit) => edit.type === "updateNoteText").length;
  const moves = edits.filter((edit) => edit.type === "moveNote").length;
  const merged = edits.filter((edit) => edit.type === "deleteNote" && edit.rationale?.toLowerCase().includes("semantic")).length;
  const replacements = edits.filter((edit) => edit.type === "deleteNote" && !edit.rationale?.toLowerCase().includes("semantic")).length;
  const tasks = edits.filter((edit) => edit.type === "addTask").length;
  const markers = edits.filter((edit) => edit.type === "addShape").length;
  const highlights = edits.filter((edit) => edit.type === "addHighlight").length;
  const replaceSpans = edits.filter((edit) => edit.type === "replaceSpan").length;
  const items: ProposalImpactItem[] = [];

  if (semanticMerges > 0) {
    items.push({
      label: pluralize(semanticMerges, "decision brief"),
      detail: "Parallel notes will become one source-traced decision brief.",
    });
  }
  if (contributorMapHeaders > 0) {
    items.push({
      label: "1 contributor map",
      detail: "A generated map will become the new canvas structure after review.",
    });
  }
  if (contributorSummaries > 0) {
    items.push({
      label: pluralize(contributorSummaries, "contributor map"),
      detail: "Generated summaries will preserve names and facts from the original source notes.",
    });
  }
  if (groupHeaders > 0) {
    items.push({
      label: pluralize(groupHeaders, "signal lane"),
      detail: "New lanes will give the board a clearer review shape.",
    });
  }
  if (stickyNotes > 0) {
    items.push({
      label: pluralize(stickyNotes, "coauthor note"),
      detail: "New notes will land on the canvas as private-to-shared moves.",
    });
  }
  if (moves > 0) {
    items.push({
      label: pluralize(moves, "canvas move"),
      detail: "Existing notes will glide to their previewed positions.",
    });
  }
  if (merged > 0) {
    items.push({
      label: `${merged} source note${merged === 1 ? "" : "s"} distilled`,
      detail: "Source notes fully represented by the brief will be removed after review.",
    });
  }
  if (replacements > 0) {
    items.push({
      label: `${replacements} source note${replacements === 1 ? "" : "s"} replaced`,
      detail: "Original scattered notes represented in the map will leave the canvas after review.",
    });
  }
  if (rewrites > 0) {
    items.push({
      label: pluralize(rewrites, "text refinement"),
      detail: "Selected note text will update only after human approval.",
    });
  }
  if (tasks > 0) {
    items.push({
      label: pluralize(tasks, "handoff launch"),
      detail: "Tasks will move into the shared handoff strip.",
    });
  }
  if (markers > 0) {
    items.push({
      label: pluralize(markers, "priority spark"),
      detail: "A marker will attach to the note that needs attention.",
    });
  }
  if (highlights > 0) {
    if (workflowId === "semanticMerge") {
      items.push({
        label: `${highlights} conflict source${highlights === 1 ? "" : "s"} highlighted`,
        detail: "Each cited source note gets the conflicting phrase highlighted. Original wording stays intact.",
      });
    } else {
      items.push({
        label: pluralize(highlights, "priority spotlight"),
        detail: "A phrase will be underlined inside its source note.",
      });
    }
  }
  if (replaceSpans > 0) {
    items.push({
      label: `${replaceSpans} conflicting phrase${replaceSpans === 1 ? "" : "s"} reconciled in your own note`,
      detail: "Only the conflicting phrase changes. The rest of your note stays exactly as you wrote it. Other authors' notes are not modified.",
    });
  }

  return items.length > 0 ? items : [{ label: pluralize(edits.length, "coauthor move"), detail: "Selected moves apply only after Accept." }];
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function toTitleCase(value: string): string {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function buildTextReviews(edits: AiProposalEdit[], snapshot: CanvasSnapshot | null): Map<number, TextReview> {
  const reviews = new Map<number, TextReview>();
  if (!snapshot) return reviews;

  edits.forEach((edit, index) => {
    if (edit.type !== "updateNoteText") return;
    const sourceNote = snapshot.notes.find((note) => note.id === edit.id);
    if (!sourceNote) return;
    reviews.set(index, buildTextReview(sourceNote.text, edit.text));
  });

  return reviews;
}

function renderEvidence(
  edit: AiProposalEdit,
  snapshot: CanvasSnapshot | null,
  groundingSources: GroundingSource[],
) {
  const noteSources = (edit.sourceNoteIds ?? [])
    .map((id) => snapshot?.notes.find((note) => note.id === id))
    .filter((note): note is CanvasSnapshot["notes"][number] => Boolean(note));
  const grounding = (edit.sourceGroundingIds ?? [])
    .map((id) => groundingSources.find((source) => source.id === id))
    .filter((source): source is GroundingSource => Boolean(source));

  if (!edit.rationale && noteSources.length === 0 && grounding.length === 0) return null;

  return (
    <div className="evidence-row" aria-label="Edit evidence">
      {edit.rationale && <span title={edit.rationale}>Reason: {truncate(edit.rationale, 72)}</span>}
      {noteSources.map((note) => (
        <span key={note.id} title={note.text}>
          From {note.author}{typeof note.createdAt === "number" ? `, ${formatTime(note.createdAt)}` : ""}: {truncate(note.text || note.id, 42)}
        </span>
      ))}
      {grounding.map((source) => (
        <span key={source.id} title={source.text}>
          Source: {truncate(source.title, 54)}
        </span>
      ))}
    </div>
  );
}

function createDefaultChangeSelections(reviews: Map<number, TextReview>): ChangeSelections {
  const selections: ChangeSelections = {};
  reviews.forEach((review, editIndex) => {
    selections[editIndex] = allChangeIndexes(review);
  });
  return selections;
}

function resolveSelectedEdits(
  edits: AiProposalEdit[],
  includedEditIndexes: Set<number>,
  acceptedChangeIndexes: ChangeSelections,
  reviews: Map<number, TextReview>,
): AiProposalEdit[] {
  const selected: AiProposalEdit[] = [];

  edits.forEach((edit, index) => {
    if (!includedEditIndexes.has(index)) return;

    if (edit.type !== "updateNoteText") {
      selected.push(edit);
      return;
    }

    const review = reviews.get(index);
    if (!review) {
      selected.push(edit);
      return;
    }

    const acceptedText = buildAcceptedText(review, acceptedChangeIndexes[index] ?? allChangeIndexes(review));
    if (acceptedText !== review.originalText) {
      selected.push({ ...edit, text: acceptedText });
    }
  });

  return selected;
}

function buildTextReview(originalText: string, proposedText: string): TextReview {
  const mode = chooseReviewMode(originalText, proposedText);
  const originalUnits = splitReviewUnits(originalText, mode);
  const proposedUnits = splitReviewUnits(proposedText, mode);
  const operations = diffUnits(originalUnits, proposedUnits);
  const segments = groupDiffOperations(operations);
  const changeCount = segments.filter((segment) => segment.kind === "change").length;

  return {
    mode,
    originalText,
    proposedText,
    segments,
    changeCount,
  };
}

function chooseReviewMode(originalText: string, proposedText: string): TextReviewMode {
  return originalText.includes("\n") || proposedText.includes("\n") ? "line" : "sentence";
}

function splitReviewUnits(text: string, mode: TextReviewMode): string[] {
  if (mode === "line") return text.replace(/\r/g, "").split("\n");
  const matches = text.match(/[^.!?\n]+[.!?]?/g);
  return matches?.map((part) => part.trim()).filter(Boolean) ?? [text.trim()].filter(Boolean);
}

function diffUnits(original: string[], proposed: string[]): DiffOperation[] {
  const rows = original.length + 1;
  const cols = proposed.length + 1;
  const dp = Array.from({ length: rows }, () => Array<number>(cols).fill(0));

  for (let i = original.length - 1; i >= 0; i--) {
    for (let j = proposed.length - 1; j >= 0; j--) {
      dp[i][j] = original[i] === proposed[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const operations: DiffOperation[] = [];
  let i = 0;
  let j = 0;

  while (i < original.length && j < proposed.length) {
    if (original[i] === proposed[j]) {
      operations.push({ kind: "equal", value: original[i] });
      i++;
      j++;
      continue;
    }

    if (dp[i + 1][j] >= dp[i][j + 1]) {
      operations.push({ kind: "remove", value: original[i] });
      i++;
    } else {
      operations.push({ kind: "add", value: proposed[j] });
      j++;
    }
  }

  while (i < original.length) operations.push({ kind: "remove", value: original[i++] });
  while (j < proposed.length) operations.push({ kind: "add", value: proposed[j++] });

  return operations;
}

function groupDiffOperations(operations: DiffOperation[]): TextReviewSegment[] {
  const segments: TextReviewSegment[] = [];
  let equalUnits: string[] = [];
  let originalUnits: string[] = [];
  let proposedUnits: string[] = [];
  let changeIndex = 0;

  const flushEqual = () => {
    if (equalUnits.length > 0) {
      segments.push({ kind: "equal", units: equalUnits });
      equalUnits = [];
    }
  };

  const flushChange = () => {
    if (originalUnits.length > 0 || proposedUnits.length > 0) {
      segments.push({ kind: "change", changeIndex, original: originalUnits, proposed: proposedUnits });
      originalUnits = [];
      proposedUnits = [];
      changeIndex++;
    }
  };

  operations.forEach((operation) => {
    if (operation.kind === "equal") {
      flushChange();
      equalUnits.push(operation.value);
      return;
    }

    flushEqual();
    if (operation.kind === "remove") originalUnits.push(operation.value);
    else proposedUnits.push(operation.value);
  });

  flushChange();
  flushEqual();
  return segments;
}

function buildAcceptedText(review: TextReview, acceptedChanges: Set<number>): string {
  const units: string[] = [];

  review.segments.forEach((segment) => {
    if (segment.kind === "equal") {
      units.push(...segment.units);
      return;
    }

    units.push(...(acceptedChanges.has(segment.changeIndex) ? segment.proposed : segment.original));
  });

  return joinUnits(units, review.mode);
}

function joinUnits(units: string[], mode: TextReviewMode): string {
  return mode === "line" ? units.join("\n") : units.join(" ").trim();
}

function allChangeIndexes(review: TextReview): Set<number> {
  return new Set(Array.from({ length: review.changeCount }, (_, index) => index));
}

function buildShareSummary(
  proposal: AiProposalResponse,
  selectedEdits: AiProposalEdit[],
  instruction: string,
  providerLabel: string,
  snapshot: CanvasSnapshot | null,
): string {
  const snapshotLine = snapshot
    ? `${snapshot.notes.length} notes, ${snapshot.shapes.length} shapes, ${snapshot.strokes.length} strokes`
    : "snapshot unavailable";

  return [
    "AI review summary",
    `AI goal: ${instruction}`,
    `Review mode: ${providerLabel}`,
    `Source snapshot: ${snapshotLine}`,
    `Selected changes: ${selectedEdits.length}`,
    `Summary: ${proposal.summary}`,
    "Changes:",
    ...selectedEdits.map((edit, index) => `${index + 1}. ${describeEdit(edit, snapshot)}`),
  ].join("\n");
}

function describeEdit(edit: AiProposalEdit, snapshot: CanvasSnapshot | null): string {
  if (edit.type === "addNote") {
    const laneLabel = getLaneHeaderLabel(edit.text);
    return laneLabel ? `Add group header: ${laneLabel}` : `Add sticky note: ${truncate(edit.text, 140)}`;
  }
  if (edit.type === "updateNoteText") return `Rewrite note: ${truncate(edit.text, 140)}`;
  if (edit.type === "moveNote") {
    const sourceNote = snapshot?.notes.find((note) => note.id === edit.id);
    return `Move note: ${truncate(sourceNote?.text || "selected note", 120)}`;
  }
  if (edit.type === "addTask") return `Create task: ${truncate(edit.title, 140)}`;
  if (edit.type === "addHighlight") return `Underline priority: ${truncate(edit.text, 140)}`;
  if (edit.type === "replaceSpan") return `Reconcile your phrase: replace "${truncate(edit.find, 80)}" with "${truncate(edit.replace, 80)}"`;
  if (edit.type === "deleteNote") {
    const sourceNote = snapshot?.notes.find((note) => note.id === edit.id);
    return `Replace source note: ${truncate(sourceNote?.text || "source note", 120)}`;
  }
  return `Add visual marker: ${toTitleCase(edit.shape)}`;
}

function truncate(value: string, maxLength: number): string {
  const cleaned = value.trim().replace(/\s+/g, " ");
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 3)}...` : cleaned;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatReason(reason: RejectionReason): string {
  return REJECTION_REASON_OPTIONS.find((option) => option.value === reason)?.label ?? reason;
}

interface TensionsSectionProps {
  tensions: SemanticTension[];
  loading: boolean;
  error: string | null;
  reconciling: boolean;
  onRefresh?: () => void;
  onReconcile: (tension: SemanticTension) => void;
  /** Notes on the canvas, used to look up authors per tension. */
  notes: StickyNote[];
  /** Who is currently acting on the canvas. */
  userName: string;
}

function TensionsSection({
  tensions,
  loading,
  error,
  reconciling,
  onRefresh,
  onReconcile,
  notes,
  userName,
}: TensionsSectionProps) {
  const count = tensions.length;
  const hasContent = count > 0 || loading || Boolean(error);
  const [expanded, setExpanded] = useState(false);
  const bodyId = "tensions-section-body";
  const notesById = useMemo(() => new Map(notes.map((note) => [note.id, note])), [notes]);

  return (
    <section className="tensions-section" aria-label="AI-detected cross-note tensions">
      <header className="tensions-section__header">
        <button
          type="button"
          className="tensions-section__heading tensions-section__toggle"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-controls={bodyId}
          title={expanded ? "Collapse the Tensions section" : "Expand the Tensions section"}
        >
          <span className="tensions-section__chevron" aria-hidden="true">{expanded ? "\u25BE" : "\u25B8"}</span>
          <span className="tensions-section__eyebrow">Tensions in the room</span>
          <strong className="tensions-section__count">
            {loading && count === 0 ? "Scanning" : count === 0 ? "None detected" : `${count} found`}
          </strong>
        </button>
        {onRefresh && expanded && (
          <button
            type="button"
            className="tensions-section__refresh"
            onClick={onRefresh}
            disabled={loading || reconciling}
            title="Re-scan the canvas for cross-note tensions"
          >
            {loading ? "Scanning" : "Rescan"}
          </button>
        )}
      </header>
      {expanded && (
        <div id={bodyId}>
          {!hasContent && (
            <p className="tensions-section__empty">
              The AI judge will flag here any cross-note contradictions or self-evolution it spots on the board.
            </p>
          )}
          {error && <p className="tensions-section__error" role="alert">{error}</p>}
          {count > 0 && (
            <ul className="tensions-section__list">
              {tensions.map((tension) => {
                const participantAuthors = new Set(
                  tension.noteIds
                    .map((id) => notesById.get(id)?.author)
                    .filter((author): author is string => Boolean(author)),
                );
                const isParticipant = participantAuthors.has(userName);
                const buttonLabel = isParticipant ? "Reconcile your stance" : "Suggest a synthesis";
                const buttonHint = isParticipant
                  ? `Edits only ${userName}'s own note — other authors stay untouched.`
                  : `Adds a signed reconcile note authored by ${userName}.`;
                return (
                  <li
                    key={tension.id}
                    className="tension-card"
                    data-tension-type={tension.type}
                    data-tension-role={isParticipant ? "participant" : "observer"}
                  >
                    <div className="tension-card__body">
                      <span className="tension-card__type">
                        {tension.type === "self-evolution" ? "Priority drift" : "Cross-author"}
                      </span>
                      <strong className="tension-card__title">{tension.title}</strong>
                      <p className="tension-card__summary">{tension.summary}</p>
                      <span className="tension-card__sources">
                        {tension.noteIds.length} source notes
                        {participantAuthors.size > 0 ? ` · ${[...participantAuthors].join(", ")}` : ""}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="tension-card__reconcile"
                      onClick={() => onReconcile(tension)}
                      disabled={reconciling || loading}
                      title={buttonHint}
                    >
                      <span className="tension-card__reconcile-label">{buttonLabel}</span>
                      <span className="tension-card__reconcile-hint">{buttonHint}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
