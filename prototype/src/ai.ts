import type { CanvasDoc, CanvasTask, InkStroke, Shape, ShapeType, StickyNote } from "./schema";

export interface CanvasSnapshot {
  notes: Array<Pick<StickyNote, "id" | "text" | "x" | "y" | "color" | "author" | "createdAt">>;
  shapes: Array<Pick<Shape, "id" | "type" | "x" | "y" | "size" | "color" | "author">>;
  strokes: Array<Pick<InkStroke, "id" | "points" | "color" | "width" | "author">>;
  tasks: Array<Pick<CanvasTask, "id" | "title" | "status" | "owner" | "timing" | "sourceAuthors" | "sourceCreatedAt" | "sourceNoteIds" | "sourceGroundingIds" | "completedBy" | "completedAt" | "author" | "createdAt">>;
  text: string;
}

export interface AiRequestSnapshotOptions {
  surfaceMode?: "canvas" | "text";
  targetNoteIds?: string[];
  includeTasks?: boolean;
  includeInkAndShapes?: boolean;
}

export interface GroundingSource {
  id: string;
  title: string;
  url?: string;
  text: string;
  kind: "sharepoint" | "manual";
}

export type AiTarget =
  | { kind: "canvas" }
  | { kind: "note"; id: string }
  | { kind: "notes"; ids: string[] };

export type RejectionReason = "notUseful" | "tooBroad" | "wrongTarget" | "needsSmallerEdits";

export interface ProposalFeedback {
  reason: RejectionReason;
  details?: string;
  instruction: string;
  summary: string;
  timestamp: number;
}

export interface AiProposalRequest {
  instruction: string;
  document: CanvasSnapshot;
  target?: AiTarget;
  groundingSources?: GroundingSource[];
  feedback?: ProposalFeedback[];
  /**
   * Optional id of the demo workflow that originated this request
   * (e.g. "semanticMerge", "mapContributions"). Used by the review UI to
   * label edits accurately instead of guessing from edit rationale strings.
   */
  workflowId?: string;
  /**
   * ISO date string for "today" from the client's perspective. Used by the
   * priority spotlight scorer to prefer notes whose author-line date is
   * today or recent over notes dated weeks ago. Also surfaced in the system
   * prompt so the model can reason about freshness instead of just keyword
   * matching.
   */
  currentDateIso?: string;
  /**
   * The most recently rejected proposal, if any. Surfaced both in the prompt
   * (so the model is told what to avoid) and in deterministic post-processors
   * (so the priority spotlight will skip the same target note instead of
   * repeating the rejected pick).
   */
  previousProposal?: AiProposalResponse;
}

export interface AiProposalEditMetadata {
  sourceNoteIds?: string[];
  sourceGroundingIds?: string[];
  rationale?: string;
}

export type AddNoteEdit = AiProposalEditMetadata & {
      type: "addNote";
      text: string;
      x: number;
      y: number;
      color?: StickyNote["color"];
    };

export type UpdateNoteTextEdit = AiProposalEditMetadata & {
      type: "updateNoteText";
      id: string;
      text: string;
    };

export type MoveNoteEdit = AiProposalEditMetadata & {
      type: "moveNote";
      id: string;
      x: number;
      y: number;
    };

export type DeleteNoteEdit = AiProposalEditMetadata & {
  type: "deleteNote";
  id: string;
};

export type AddShapeEdit = AiProposalEditMetadata & {
      type: "addShape";
      shape: ShapeType;
      x: number;
      y: number;
      size?: number;
      color?: string;
    };

export type AddTaskEdit = AiProposalEditMetadata & {
  type: "addTask";
  title: string;
  owner?: string;
  timing?: string;
  sourceAuthors?: string[];
  sourceCreatedAt?: number[];
};

export type AddHighlightEdit = AiProposalEditMetadata & {
  type: "addHighlight";
  noteId: string;
  text: string;
  color?: string;
};

// Surgical phrase-level replacement on a single note. Used by the
// semantic-merge flow when the current user is a participant in the tension:
// instead of adding a new mediator note, AI rewrites just the conflicting
// span inside the user's own note. `find` must appear verbatim in the
// target note; apply logic replaces the first occurrence.
export type ReplaceSpanEdit = AiProposalEditMetadata & {
  type: "replaceSpan";
  noteId: string;
  find: string;
  replace: string;
};

export type AiProposalEdit =
  | AddNoteEdit
  | UpdateNoteTextEdit
  | MoveNoteEdit
  | DeleteNoteEdit
  | AddShapeEdit
  | AddTaskEdit
  | AddHighlightEdit
  | ReplaceSpanEdit;

type LaneKey = "context" | "risks" | "next";

const CANVAS_NOTE_WIDTH = 300;
const GENERATED_NOTE_GAP_X = 36;
const GENERATED_NOTE_GAP_Y = 36;
const ORGANIZE_LANE_WIDTH = 348;
const CONTRIBUTION_LANE_WIDTH = 348;
const CONTRIBUTION_SUMMARY_GAP_Y = 36;
const CONTRIBUTION_NOTE_COLORS: StickyNote["color"][] = ["pink", "purple", "orange", "blue", "green", "yellow"];

interface LayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AiProposalResponse {
  summary: string;
  edits: AiProposalEdit[];
}

export interface AiProvider {
  propose(request: AiProposalRequest): Promise<AiProposalResponse>;
  chatOnce?(systemPrompt: string, userPrompt: string, options?: { signal?: AbortSignal }): Promise<string>;
}

export function createCanvasSnapshot(doc: CanvasDoc): CanvasSnapshot {
  return {
    notes: doc.notes.map(({ id, text, x, y, color, author, createdAt }) => ({
      id,
      text,
      x,
      y,
      color,
      author,
      createdAt,
    })),
    shapes: doc.shapes.map(({ id, type, x, y, size, color, author }) => ({
      id,
      type,
      x,
      y,
      size,
      color,
      author,
    })),
    strokes: (doc.strokes ?? []).map(({ id, points, color, width, author }) => ({
      id,
      points: [...points],
      color,
      width,
      author,
    })),
    tasks: (doc.tasks ?? []).map(({
      id,
      title,
      status,
      owner,
      timing,
      sourceAuthors,
      sourceCreatedAt,
      sourceNoteIds,
      sourceGroundingIds,
      completedBy,
      completedAt,
      author,
      createdAt,
    }) => ({
      id,
      title,
      status,
      owner,
      timing,
      sourceAuthors: [...(sourceAuthors ?? [])],
      sourceCreatedAt: [...(sourceCreatedAt ?? [])],
      sourceNoteIds: [...(sourceNoteIds ?? [])],
      sourceGroundingIds: [...(sourceGroundingIds ?? [])],
      completedBy,
      completedAt,
      author,
      createdAt,
    })),
    text: String(doc.text ?? ""),
  };
}

export function createAiRequestSnapshot(
  doc: CanvasDoc,
  {
    surfaceMode = "canvas",
    targetNoteIds = [],
    includeTasks = true,
    includeInkAndShapes = false,
  }: AiRequestSnapshotOptions = {},
): CanvasSnapshot {
  const snapshot = createCanvasSnapshot(doc);

  if (surfaceMode === "text") {
    return {
      notes: [],
      shapes: [],
      strokes: [],
      tasks: [],
      text: snapshot.text,
    };
  }

  const targetIds = new Set(targetNoteIds);
  const notes = targetIds.size > 0
    ? snapshot.notes.filter((note) => targetIds.has(note.id))
    : snapshot.notes;

  return {
    notes,
    shapes: includeInkAndShapes ? snapshot.shapes : [],
    strokes: includeInkAndShapes ? snapshot.strokes : [],
    tasks: includeTasks ? snapshot.tasks : [],
    text: "",
  };
}

export class FunctionAppAiProvider implements AiProvider {
  private readonly endpointUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(endpointUrl: string, fetchImpl: typeof fetch = fetch) {
    this.endpointUrl = endpointUrl;
    this.fetchImpl = (input, init) => fetchImpl(input, init);
  }

  async propose(request: AiProposalRequest): Promise<AiProposalResponse> {
    const response = await this.fetchImpl(this.endpointUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`AI proposal request failed: ${response.status}`);
    }

    return (await response.json()) as AiProposalResponse;
  }
}

export class OpenAiCompatibleAiProvider implements AiProvider {
  private readonly endpointUrl: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    options: {
      endpointUrl?: string;
      model?: string;
      fetchImpl?: typeof fetch;
    } = {},
  ) {
    this.endpointUrl = options.endpointUrl ?? "/ai-proxy/openai/v1/chat/completions";
    this.model = options.model ?? "gpt-5.1";
    const fetchImpl = options.fetchImpl ?? fetch;
    this.fetchImpl = (input, init) => fetchImpl(input, init);
  }

  async propose(request: AiProposalRequest): Promise<AiProposalResponse> {
    const response = await this.fetchImpl(this.endpointUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: ACT2_SYSTEM_PROMPT },
          { role: "user", content: buildOpenAiUserPrompt(request) },
        ],
      }),
    });

    if (!response.ok) {
      const details = truncateError(await response.text());
      throw new Error(`AI proposal request failed: ${response.status}${details ? ` ${details}` : ""}`);
    }

    const raw = (await response.json()) as OpenAiChatCompletionResponse;
    const content = getChatCompletionContent(raw);
    const parsed = parseJsonObject(content);
    return normalizeAiProposalResponse(parsed, request);
  }

  async chatOnce(
    systemPrompt: string,
    userPrompt: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<string> {
    const response = await this.fetchImpl(this.endpointUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
      signal: options.signal,
    });

    if (!response.ok) {
      const details = truncateError(await response.text());
      throw new Error(`AI review request failed: ${response.status}${details ? ` ${details}` : ""}`);
    }

    const raw = (await response.json()) as OpenAiChatCompletionResponse;
    const content = getChatCompletionContent(raw);
    return typeof content === "string" ? content.trim() : "";
  }
}

export type SemanticTensionType = "cross-author" | "self-evolution";

export interface SemanticTension {
  id: string;
  noteIds: string[];
  title: string;
  summary: string;
  type: SemanticTensionType;
}

const SEMANTIC_TENSION_SYSTEM_PROMPT = [
  "You are a senior product reviewer scanning a shared collaboration canvas.",
  "You read a list of sticky notes, each with an author, optional date, and body text.",
  "Your job is to surface material SEMANTIC TENSIONS that real collaborators would want to reconcile before shipping.",
  "",
  "A tension is one of:",
  "- cross-author: two or more different authors recommend or imply OPPOSITE moves, priorities, costs, or scopes on the same topic.",
  "- self-evolution: the SAME author contradicts or materially walks back their own earlier note on the same topic across different dates.",
  "",
  "Strict rules:",
  "- Only report tensions that are clearly grounded in the notes. Do not invent disagreements.",
  "- Ignore notes that only repeat or expand on each other without disagreement.",
  "- Each tension must reference at least 2 noteIds drawn from the input.",
  "- Prefer fewer, higher-signal tensions. Return 0 if nothing material.",
  "- Cap output at 4 tensions, ordered by importance.",
  "",
  "Return ONLY a JSON object of the shape:",
  "{ \"tensions\": [ { \"title\": string, \"summary\": string, \"type\": \"cross-author\" | \"self-evolution\", \"noteIds\": string[] } ] }",
  "",
  "Field rules:",
  "- title: max 70 chars. Pattern \"<A> vs <B> — <topic>\" for cross-author, or \"<Author> · priority drift — <topic>\" for self-evolution.",
  "- summary: one neutral sentence (max 28 words) naming the unresolved tradeoff. No quotes, no markdown.",
  "- noteIds: must be exact ids from the input list. No new ids.",
  "- type: must match one of the two allowed values.",
].join("\n");

function buildTensionUserPrompt(notes: Array<Pick<StickyNote, "id" | "text" | "author" | "createdAt">>): string {
  const lines = notes
    .filter((note) => typeof note.text === "string" && note.text.trim().length > 0)
    .map((note) => {
      const author = note.author?.trim() || "Unknown";
      const dateLabel = typeof note.createdAt === "number" && Number.isFinite(note.createdAt)
        ? new Date(note.createdAt).toISOString().slice(0, 10)
        : "no-date";
      const body = note.text.replace(/\s+/g, " ").trim().slice(0, 320);
      return `- id=${note.id} | author=${author} | date=${dateLabel}\n  text: ${body}`;
    });
  return [
    "Sticky notes on the shared canvas:",
    "",
    lines.join("\n"),
    "",
    "Return the JSON object as specified. If there are no material tensions, return { \"tensions\": [] }.",
  ].join("\n");
}

export async function detectSemanticTensions(
  notes: Array<Pick<StickyNote, "id" | "text" | "author" | "createdAt">>,
  ai: AiProvider,
  options: { signal?: AbortSignal } = {},
): Promise<SemanticTension[]> {
  if (typeof ai.chatOnce !== "function") return [];
  const eligible = notes.filter((note) => typeof note.text === "string" && note.text.trim().length > 0);
  if (eligible.length < 2) return [];

  let raw: string;
  try {
    raw = await ai.chatOnce(
      SEMANTIC_TENSION_SYSTEM_PROMPT,
      buildTensionUserPrompt(eligible),
      { signal: options.signal },
    );
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = parseJsonObject(raw);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];
  const list = Array.isArray(parsed.tensions) ? parsed.tensions : [];
  const validIds = new Set(eligible.map((note) => note.id));
  const result: SemanticTension[] = [];
  const seen = new Set<string>();

  for (const candidate of list) {
    if (!isRecord(candidate)) continue;
    const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
    const summary = typeof candidate.summary === "string" ? candidate.summary.trim() : "";
    const rawType = typeof candidate.type === "string" ? candidate.type.trim().toLowerCase() : "";
    const type: SemanticTensionType = rawType === "self-evolution" ? "self-evolution" : "cross-author";
    const rawIds = Array.isArray(candidate.noteIds) ? candidate.noteIds : [];
    const noteIds: string[] = [];
    const idSeen = new Set<string>();
    for (const item of rawIds) {
      if (typeof item !== "string") continue;
      const id = item.trim();
      if (!validIds.has(id) || idSeen.has(id)) continue;
      idSeen.add(id);
      noteIds.push(id);
    }
    if (!title || !summary || noteIds.length < 2) continue;

    const id = `tension-${[...noteIds].sort().join("-")}`;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push({
      id,
      noteIds,
      title: title.slice(0, 120),
      summary: summary.slice(0, 240),
      type,
    });
    if (result.length >= 4) break;
  }

  return result;
}

interface OpenAiChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
}

const ACT2_SYSTEM_PROMPT = [
  "You generate structured canvas edit proposals for a human review workflow.",
  "Return JSON only. Do not include markdown, prose, or code fences.",
  'The JSON shape must be: {"summary":"short summary","edits":[...]}',
  "Allowed edit types:",
  '{"type":"addNote","text":"note text","x":100,"y":100,"color":"yellow"}',
  '{"type":"updateNoteText","id":"existing note id","text":"replacement text"}',
  '{"type":"moveNote","id":"existing note id","x":100,"y":100}',
  '{"type":"deleteNote","id":"existing note id"}',
  '{"type":"addShape","shape":"circle","x":100,"y":100,"size":60,"color":"#64a7dd"}',
  '{"type":"addTask","title":"task title","owner":"optional owner","timing":"optional timing","sourceAuthors":["Alex"],"sourceCreatedAt":[1716400000000]}',
  '{"type":"addHighlight","noteId":"existing note id","text":"exact phrase or line to underline","color":"#c83f4f"}',
  '{"type":"replaceSpan","noteId":"existing note id","find":"verbatim substring of the note","replace":"softened revision text"}',
  'Every edit may include optional evidence metadata: {"sourceNoteIds":["n1"],"sourceGroundingIds":["g1"],"rationale":"why this edit is useful"}.',
  "Only use updateNoteText, moveNote, deleteNote, addHighlight, or replaceSpan note ids that already exist in the provided document.",
  "Only use sourceNoteIds that exist in the document and sourceGroundingIds that exist in request.groundingSources.",
  'If request.target.kind is "note" or "notes", focus on that target first.',
  "Treat the instruction as a product workflow goal, not a generic chat prompt. The output must visibly improve the source canvas.",
  "For polish, rewrite, clarify, or review-ready instructions on a target note, prefer updateNoteText on that target note.",
  "For contribution mapping, you MUST add exactly one concise contributor summary note for EVERY distinct source author present in the scoped notes, including authors with only a single source note. Do not skip, merge, or omit any author. Each summary note must include the author's name, the source note count, the time range when available, and one short bullet per source note. Then add exactly one deleteNote edit for every source note that is represented in any contributor summary, so Accept replaces the scattered source layer with the AI-generated contributor map.",
  "For live semantic conflict instructions, update only the target note with a Live semantic merge. Preserve both collaborator intents, include Source trail and Review boundary sections, and do not add, delete, move, or highlight anything.",
  "For semantic merge instructions, emit exactly one signed conflict-brief addNote plus addHighlight edits on every cited source note. The conflict brief must use Conflict, Positions, Resolution, How to apply, and Open questions sections. Do not use Shared state, Past, Now, Future, Agreed signal, Merged next move, generic timeline language, updateNoteText, deleteNote, moveNote, or replaceSpan for semantic merge.",
  "For shared-state clarification, return exactly one addNote titled Shared state. Make the messy board easier to understand with Past, Now, Future, and Open questions sections when each has source evidence. Future is a summary of expected direction or state, not a task list. Do not assign owners, create commitments, emit addTask, or emit any other edit type.",
  "For organize, group, cluster, or clean-up instructions, prefer moveNote plus concise header addNote edits.",
  "For organize, preserve original note text. Use addNote only for lane/group headers, then move existing notes into those groups.",
  "For organize, only create a group header if at least one existing note will move into that group.",
  "Do not write placeholder content such as TBD, fill this in, add details here, none captured yet, or example-only content.",
  "For task handoff instructions, return addTask edits only. Treat this as to-do extraction, not board clarification. Do not emit addNote, stage summaries, briefs, highlights, moves, rewrites, shapes, or deletes. Create tasks only from concrete actions, owner/timing needs, blockers, or decisions. Avoid duplicate tasks already present in document.tasks.",
  "For task handoff, if one source note contains multiple concrete actions, create separate tasks. Do not rewrite or move notes unless the instruction explicitly asks.",
  "Task titles must be action-ready. Do not merely copy the source note text. Rewrite it into a clear verb-first phrase with timing or owner context when present.",
  "For task handoff, include sourceAuthors and sourceCreatedAt from the source notes so users can trace who proposed the action and when it entered the board.",
  "For clarify instructions, prefer updateNoteText edits that make selected notes easier to review without inventing facts.",
  "Clarify output must improve the source by separating past context, current state, future direction, and what remains uncertain. Use a compact review-brief structure. Do not append a generic revision note or create a separate follow-up note.",
  "Every rationale should explain the user-facing improvement, such as easier scanning, clearer ownership, priority, or conversion into shared work.",
  "When request.feedback is provided, treat it as a rejection of the previous draft. The next proposal must directly address the latest feedback details and should visibly differ from the rejected proposal in scope, emphasis, or edit selection.",
  "When request.previousProposal is provided, treat its edits as already rejected by the human reviewer. The next proposal MUST pick a different target. For addHighlight in particular, never reuse the same noteId as the rejected highlight; choose a different source note even if the second-best candidate seems weaker.",
  "When request.currentDateIso is provided, treat it as today's date. For visual marker and priority spotlight, freshness is a HARD requirement: the highlighted source note's author-line date (e.g. \"Alex - May 14\") MUST be within the past 7 days of today whenever any note in scope qualifies. Only fall back to an older note (8+ days) if NO note dated within the past 7 days carries any priority signal at all (overdue, blocked, due, urgent, today, now, tomorrow, risk, blocker, action). Never highlight a note dated 2+ weeks ago when a fresher note exists in scope, even if the older note has stronger keyword matches like 'blocker' or 'priority'.",
  "For visual marker, priority, highlight, or underline instructions, return exactly one addHighlight edit by default. Choose the highest-priority exact source phrase or line using this order: overdue, blocked, due, urgent, today, now, tomorrow, then concrete action. Never highlight structural headers such as Shared state, Past, Now, Future, Previous stage, Current stage, Next stage, Open questions, contributor summaries, or source-count/time-range lines. Make no other edit for a marker-only request.",
  "The summary should say what improved, such as mapped contributor inputs, created handoff tasks, clarified shared state, or highlighted the priority phrase.",
  "If groundingSources are provided, use them as private evidence and include sourceGroundingIds on relevant edits.",
  "Make the proposal complete enough to accept after review. It should not feel like a partial example.",
  "Keep the proposal focused enough for a human to review, usually 3 to 12 edits. EXCEPTION: when the user prompt provides an explicit roster of authors or source-note ids that must each be represented (for example a contributor-mapping checklist), emit every edit the checklist requires, even if the total exceeds 12.",
  "Keep addNote text concise enough to read comfortably on a sticky note.",
  "Do not label proposed document content as AI-generated or mention this review mechanism inside the proposed content.",
].join("\n");

function buildOpenAiUserPrompt(request: AiProposalRequest): string {
  const feedbackDetails = formatFeedbackForPrompt(request.feedback);
  const rejectedSummary = formatRejectedProposalForPrompt(request.previousProposal);
  const today = request.currentDateIso
    ? `Today's date (client local): ${request.currentDateIso}. Use this when judging whether a source note is recent.`
    : "";
  return [
    "Create a proposed edit set for this collaborative canvas.",
    "Do not apply the edits directly; they will be reviewed by a human first.",
    today,
    rejectedSummary ? `Previously rejected proposal (DO NOT REPEAT). Pick a different target note and/or different phrase. Rejected edits:\n${rejectedSummary}` : "",
    feedbackDetails ? `Reviewer feedback so far (most recent first). The next proposal must address every entry, with priority on the most recent. If two entries conflict, the more recent one wins.\n${feedbackDetails}` : "",
    JSON.stringify(request),
  ].filter(Boolean).join("\n\n");
}

function formatRejectedProposalForPrompt(previous?: AiProposalResponse): string {
  if (!previous || !previous.edits.length) return "";
  return previous.edits
    .map((edit, index) => {
      if (edit.type === "addHighlight") {
        return `#${index + 1} addHighlight noteId=${edit.noteId} text="${truncateForNote(edit.text, 80)}"`;
      }
      if (edit.type === "updateNoteText") {
        return `#${index + 1} updateNoteText noteId=${edit.id} text="${truncateForNote(edit.text, 80)}"`;
      }
      if (edit.type === "replaceSpan") {
        return `#${index + 1} replaceSpan noteId=${edit.noteId} find="${truncateForNote(edit.find, 60)}"`;
      }
      if (edit.type === "addNote") {
        return `#${index + 1} addNote text="${truncateForNote(edit.text, 80)}"`;
      }
      return `#${index + 1} ${edit.type}`;
    })
    .join("\n");
}

function formatFeedbackForPrompt(feedback?: ProposalFeedback[]): string {
  if (!feedback || feedback.length === 0) return "";
  // feedbackHistory is ordered newest-first (see Act2Panel reject handlers).
  // We surface every retained turn so the LLM can carry context across
  // multiple Regenerate clicks, not just the latest one. Each entry is
  // numbered and labelled so the model can refer back to prior asks.
  return feedback
    .map((entry, index) => {
      const tag = index === 0 ? "latest" : `turn -${index}`;
      const reason = entry.reason;
      const details = entry.details?.trim();
      const head = `#${index + 1} (${tag}) — Reason: ${reason}`;
      return details ? `${head}\nUser correction: ${details}` : head;
    })
    .join("\n\n");
}

function getChatCompletionContent(response: OpenAiChatCompletionResponse): string {
  const content = response.choices?.[0]?.message?.content;

  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (isRecord(part) && typeof part.text === "string") return part.text;
        return "";
      })
      .join("");
  }

  throw new Error("The AI backend returned no chat completion content.");
}

function parseJsonObject(content: string): unknown {
  const trimmed = stripCodeFence(content.trim());

  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
  }

  throw new Error("The AI backend returned content that was not valid proposal JSON.");
}

function normalizeAiProposalResponse(value: unknown, request: AiProposalRequest): AiProposalResponse {
  if (!isRecord(value)) {
    throw new Error("The AI backend returned an invalid proposal object.");
  }

  const rawEdits = Array.isArray(value.edits) ? value.edits : [];
  const noteIds = new Set(request.document.notes.map((note) => note.id));
  const groundingIds = new Set((request.groundingSources ?? []).map((source) => source.id));
  const edits: AiProposalEdit[] = [];

  for (const rawEdit of rawEdits) {
    const edit = normalizeEdit(rawEdit, noteIds, groundingIds);
    if (edit) edits.push(edit);
  }

  if (edits.length === 0) {
    throw new Error("The AI backend returned no usable structured edits.");
  }

  const completedEdits = stabilizeProposalLayout(completeProposalEdits(edits, request), request.document.notes);
  if (completedEdits.length === 0) {
    throw new Error("The AI backend returned no complete usable structured edits.");
  }

  return {
    summary: coerceText(value.summary, "The AI backend prepared a proposal."),
    edits: completedEdits,
  };
}

function completeProposalEdits(edits: AiProposalEdit[], request: AiProposalRequest): AiProposalEdit[] {
  const normalizedInstruction = request.instruction.trim().toLowerCase();

  // Check semantic merge before visual marker, because the semantic merge
  // instruction also mentions "highlight" (it asks for addHighlight edits on
  // source notes) and would otherwise be misrouted to the priority spotlight
  // post-processor.
  // Routing prefers the explicit workflowId (set by Act2Panel for reconcile
  // calls) so the participant-mode instruction does not need to share lexical
  // markers with the outside-observer instruction.
  if (request.workflowId === "semanticMerge" || isSemanticMergeInstruction(normalizedInstruction)) {
    return completeSemanticMergeProposalEdits(edits, request);
  }

  if (request.workflowId === "createHandoff") {
    return completeTaskHandoffProposalEdits(edits, request);
  }

  if (request.workflowId === "clarifyState") {
    return completeSharedStateProposalEdits(edits, request);
  }

  if (request.workflowId === "mapContributions") {
    return completeContributionMapProposalEdits(edits, request);
  }

  if (request.workflowId === "highlightPriority") {
    return completeVisualMarkerProposalEdits(edits, request);
  }

  if (isVisualMarkerInstruction(normalizedInstruction)) {
    return completeVisualMarkerProposalEdits(edits, request);
  }

  if (isSharedStateInstruction(normalizedInstruction)) {
    return completeSharedStateProposalEdits(edits, request);
  }

  if (isContributionMapInstruction(normalizedInstruction)) {
    return completeContributionMapProposalEdits(edits, request);
  }

  if (isOrganizeInstruction(normalizedInstruction)) {
    return completeOrganizeProposalEdits(edits, request);
  }

  if (isTaskHandoffInstruction(normalizedInstruction)) {
    return completeTaskHandoffProposalEdits(edits, request);
  }

  return edits;
}

function stabilizeProposalLayout(
  edits: AiProposalEdit[],
  notes: CanvasSnapshot["notes"],
): AiProposalEdit[] {
  if (!edits.some((edit) => edit.type === "addNote" || edit.type === "moveNote")) return edits;

  const noteById = new Map(notes.map((note) => [note.id, note]));
  const finalTextById = new Map(notes.map((note) => [note.id, note.text]));
  edits.forEach((edit) => {
    if (edit.type === "updateNoteText") finalTextById.set(edit.id, edit.text);
  });

  const occupiedRects = notes
    .map((note) => noteToLayoutRect({ ...note, text: finalTextById.get(note.id) ?? note.text }));

  return edits.map((edit) => {
    if (edit.type === "addNote") {
      const { x, y } = findOpenNotePosition(occupiedRects, edit.x, edit.y, edit.text);
      occupiedRects.push(textToLayoutRect(x, y, edit.text));
      return { ...edit, x, y };
    }

    if (edit.type === "moveNote") {
      const note = noteById.get(edit.id);
      if (!note) return edit;
      const text = finalTextById.get(edit.id) ?? note.text;
      const { x, y } = findOpenNotePosition(occupiedRects, edit.x, edit.y, text);
      occupiedRects.push(textToLayoutRect(x, y, text));
      return { ...edit, x, y };
    }

    return edit;
  });
}

function findOpenNotePosition(
  occupiedRects: LayoutRect[],
  preferredX: number,
  preferredY: number,
  text: string,
): { x: number; y: number } {
  const x = Math.max(24, Math.round(preferredX));
  let y = Math.max(24, Math.round(preferredY));
  const height = estimateCanvasNoteHeightForLayout(text);

  for (let guard = 0; guard < 120; guard += 1) {
    const candidate = { x, y, width: CANVAS_NOTE_WIDTH, height };
    const overlap = occupiedRects.find((rect) => layoutRectsOverlap(candidate, rect));
    if (!overlap) return { x, y };
    y = Math.max(y + GENERATED_NOTE_GAP_Y, overlap.y + overlap.height + GENERATED_NOTE_GAP_Y);
  }

  return { x, y };
}

function noteToLayoutRect(note: CanvasSnapshot["notes"][number]): LayoutRect {
  return textToLayoutRect(note.x, note.y, note.text);
}

function textToLayoutRect(x: number, y: number, text: string): LayoutRect {
  return {
    x,
    y,
    width: CANVAS_NOTE_WIDTH,
    height: estimateCanvasNoteHeightForLayout(text),
  };
}

function layoutRectsOverlap(left: LayoutRect, right: LayoutRect): boolean {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

function estimateCanvasNoteHeightForLayout(text: string): number {
  const isBoardHeader = isBoardHeaderText(text);
  const base = isBoardHeader ? 76 : 86;
  const lineHeight = isBoardHeader ? 20 : 22;
  const minHeight = isBoardHeader ? 126 : 180;
  const maxHeight = isBoardHeader ? 920 : 720;
  const wrappedLines = estimateWrappedLineCountForLayout(text, isBoardHeader ? 35 : 34);
  return Math.min(Math.max(minHeight, base + wrappedLines * lineHeight), maxHeight);
}

function estimateWrappedLineCountForLayout(text: string, charsPerLine: number): number {
  return text.replace(/\r/g, "").split("\n").reduce((total, line) => {
    const trimmed = line.trim();
    return total + Math.max(1, Math.ceil(trimmed.length / charsPerLine));
  }, 0);
}

function isBoardHeaderText(text: string): boolean {
  const firstLine = text.trim().split(/\r?\n/)[0]?.toLowerCase() ?? "";
  return Boolean(
    firstLine === "contributor map" ||
    firstLine === "shared state" ||
    firstLine === "semantic merge" ||
    firstLine === "live semantic merge" ||
    /\bsummary$/.test(firstLine) ||
    /^contributor\s*:/.test(firstLine) ||
    /\binput$/.test(firstLine) ||
    /\b(context|risks?|next steps?)\b/.test(firstLine)
  );
}

function completeOrganizeProposalEdits(edits: AiProposalEdit[], request: AiProposalRequest): AiProposalEdit[] {
  const scopedNotes = selectNotesForFeedback(getTargetNotes(request.target, request.document.notes), request.feedback);
  if (scopedNotes.length === 0) return edits.filter((edit) => !isPlaceholderAddNote(edit));

  const activeLaneKeys = getActiveLaneKeys(scopedNotes);
  const completed = edits.filter((edit) => !isPlaceholderAddNote(edit) && !isInactiveLaneHeader(edit, activeLaneKeys));
  const fallbackEdits = buildOrganizeCanvasEdits(scopedNotes, request.feedback);
  const laneHeaders = new Set(completed.flatMap((edit) => getLaneHeaderKey(edit)));
  const movedNoteIds = new Set(completed.filter((edit) => edit.type === "moveNote").map((edit) => edit.id));

  fallbackEdits
    .filter((edit) => edit.type === "addNote")
    .forEach((edit) => {
      const [laneKey] = getLaneHeaderKey(edit);
      if (laneKey && !laneHeaders.has(laneKey)) {
        completed.push(edit);
        laneHeaders.add(laneKey);
      }
    });

  fallbackEdits
    .filter((edit) => edit.type === "moveNote")
    .forEach((edit) => {
      if (!movedNoteIds.has(edit.id)) {
        completed.push(edit);
        movedNoteIds.add(edit.id);
      }
    });

  return completed;
}

function completeContributionMapProposalEdits(edits: AiProposalEdit[], request: AiProposalRequest): AiProposalEdit[] {
  const scopedNotes = getTargetNotes(request.target, request.document.notes);
  const modelEdits = normalizeContributionMapEdits(
    edits.filter((edit): edit is Extract<AiProposalEdit, { type: "addNote" }> =>
      edit.type === "addNote" && !isPlaceholderAddNote(edit)
    ),
    scopedNotes,
    request.feedback,
  );
  if (modelEdits.length > 0) return modelEdits;

  const fallbackEdits = buildContributionMapEdits(scopedNotes, request.feedback);
  return fallbackEdits.length > 0 ? fallbackEdits : modelEdits;
}

function completeSharedStateProposalEdits(edits: AiProposalEdit[], request: AiProposalRequest): AiProposalEdit[] {
  const scopedNotes = getTargetNotes(request.target, request.document.notes);
  const modelNotes = edits.filter((edit): edit is Extract<AiProposalEdit, { type: "addNote" }> =>
    edit.type === "addNote" && !isPlaceholderAddNote(edit)
  );
  if (modelNotes.length > 0) return [normalizeSharedStateNoteEdit(modelNotes, scopedNotes)];

  const fallbackEdits = buildSharedStateEdits(scopedNotes, request.feedback);
  return fallbackEdits.length > 0 ? fallbackEdits : [];
}

function completeTaskHandoffProposalEdits(edits: AiProposalEdit[], request: AiProposalRequest): AiProposalEdit[] {
  const scopedNotes = getTargetNotes(request.target, request.document.notes);
  const modelTasks = edits.filter((edit): edit is Extract<AiProposalEdit, { type: "addTask" }> => edit.type === "addTask");
  const completed = modelTasks.length > 0
    ? modelTasks
    : buildTaskHandoffEdits(
      scopedNotes,
      request.groundingSources ?? [],
      request.document.tasks,
      request.feedback,
    );

  return completed.map((edit) => edit.type === "addTask" ? enrichTaskEdit(edit, request) : edit);
}

function normalizeSharedStateNoteEdit(
  modelNotes: Array<Extract<AiProposalEdit, { type: "addNote" }>>,
  scopedNotes: CanvasSnapshot["notes"],
): Extract<AiProposalEdit, { type: "addNote" }> {
  const first = modelNotes[0];
  const body = modelNotes
    .map((note) => stripSharedStateTitle(note.text))
    .filter(Boolean)
    .join("\n\n");
  const sourceNoteIds = first.sourceNoteIds?.length
    ? first.sourceNoteIds
    : scopedNotes.map((note) => note.id).slice(0, 8);

  return {
    ...first,
    text: body ? `Shared state\n${body}` : "Shared state",
    color: "green",
    sourceNoteIds,
    rationale: first.rationale ?? "Adds one shared-state brief without turning the signal into task handoff items.",
  };
}

function stripSharedStateTitle(text: string): string {
  const lines = text.trim().split(/\r?\n/);
  if (/^shared state$/i.test(lines[0]?.trim() ?? "")) {
    return lines.slice(1).join("\n").trim();
  }
  return text.trim();
}

function completeVisualMarkerProposalEdits(edits: AiProposalEdit[], request: AiProposalRequest): AiProposalEdit[] {
  const target = request.target;
  const targetNote = target?.kind === "note"
    ? request.document.notes.find((note) => note.id === target.id)
    : undefined;
  const scopedNotes = getTargetNotes(request.target, request.document.notes);
  // When regenerating after a reject, exclude every noteId that the rejected
  // proposal already pointed at. Without this the model often re-picks the
  // same note (its keyword score has not changed), and the deterministic
  // fallback below was previously feedback-blind.
  const excludedNoteIds = collectRejectedHighlightNoteIds(request.previousProposal);
  // Also exclude notes that are too stale relative to the client's "today"
  // when a fresher candidate exists. This enforces the prompt rule even when
  // the model ignores it (e.g. it picks a 2-week-old "blocker" line when a
  // fresh note in scope also has a priority signal).
  const todayMs = resolveTodayMs(request.currentDateIso);
  const candidatePool = scopedNotes.length > 0 ? scopedNotes : request.document.notes;
  const staleNoteIds = collectStaleNoteIds(candidatePool, todayMs);
  // Combine, but back off the stale filter if combining with the explicit
  // reject list would leave no candidates at all. Otherwise the user gets a
  // useless empty "Priority" placeholder after rejecting the freshest note.
  const combinedExclusions = new Set<string>([...excludedNoteIds, ...staleNoteIds]);
  const hasAnyEligible = candidatePool.some((note) => !combinedExclusions.has(note.id));
  const effectiveExclusions = hasAnyEligible
    ? combinedExclusions
    : new Set<string>(excludedNoteIds); // keep only the explicit reject list
  const modelHighlight = getUsableHighlightEdit(edits, request.document.notes, effectiveExclusions);
  if (modelHighlight) return [modelHighlight];

  const markerEdit = buildPriorityHighlightEdit(
    scopedNotes,
    request.document.notes,
    targetNote && !effectiveExclusions.has(targetNote.id) ? targetNote : undefined,
    { excludedNoteIds: effectiveExclusions, currentDateIso: request.currentDateIso },
  );
  if (!request.document.notes.length) return edits.filter((edit) => edit.type !== "addShape");
  return [markerEdit];
}

function collectRejectedHighlightNoteIds(previous?: AiProposalResponse): Set<string> {
  const ids = new Set<string>();
  if (!previous) return ids;
  previous.edits.forEach((edit) => {
    if (edit.type === "addHighlight" && edit.noteId) {
      ids.add(edit.noteId);
    }
  });
  return ids;
}

/**
 * Returns the ids of notes that are too stale to be the priority spotlight
 * target when at least one fresher candidate exists. "Stale" means the note's
 * author-line date is more than 7 days before today AND the pool also
 * contains at least one candidate within the past 7 days that has any
 * non-structural body line. If no fresh candidate qualifies we leave the
 * stale candidates in play (better to highlight an old priority signal than
 * nothing).
 */
function collectStaleNoteIds(notes: CanvasSnapshot["notes"], todayMs: number): Set<string> {
  const stale = new Set<string>();
  if (notes.length === 0) return stale;
  const oneDayMs = 24 * 60 * 60 * 1000;
  const freshThresholdDays = 7;
  const annotated = notes.map((note) => {
    const noteMs = resolveNoteDateMs(note, todayMs);
    const ageDays = noteMs === null ? Number.POSITIVE_INFINITY : Math.round((todayMs - noteMs) / oneDayMs);
    const candidate = extractPriorityLineCandidate(note.text);
    // A note qualifies as a fresh substitute if it has any non-structural
    // body content — we do not require a priority keyword, because the user
    // intent is "stay current", not "only highlight blockers". This lets the
    // spotlight rotate onto a recent contextual note instead of repeating a
    // weeks-old blocker line.
    const hasUsableBody = candidate !== null;
    return { note, ageDays, hasUsableBody };
  });
  const anyFreshUsable = annotated.some(({ ageDays, hasUsableBody }) => ageDays <= freshThresholdDays && hasUsableBody);
  if (!anyFreshUsable) return stale;
  annotated.forEach(({ note, ageDays }) => {
    if (ageDays > freshThresholdDays) stale.add(note.id);
  });
  return stale;
}

function completeSemanticMergeProposalEdits(edits: AiProposalEdit[], request: AiProposalRequest): AiProposalEdit[] {
  const scopedNotes = getTargetNotes(request.target, request.document.notes);
  const modelEdits = edits
    .filter((edit) => !isPlaceholderAddNote(edit) && !isUnusableSemanticMergeAddNote(edit))
    .filter((edit) => edit.type === "addNote" || edit.type === "addHighlight");
  const reviewerName = extractReviewerNameFromInstruction(request.instruction);

  const modelHasReconcileNote = modelEdits.some((edit) => edit.type === "addNote");

  // If the model already produced both a signed reconcile note and at least one
  // additional edit (typically the source-note highlights), accept its draft as-is.
  if (modelHasReconcileNote && modelEdits.length > 1) {
    return modelEdits;
  }

  // Otherwise, synthesize the missing pieces from the deterministic fallback so
  // the demo always lands on (1 signed reconcile note + N source highlights),
  // even when the LLM emits a partial result.
  const fallbackEdits = buildSemanticMergeEdits(scopedNotes, request.feedback, reviewerName);
  if (fallbackEdits.length === 0) {
    return modelEdits;
  }

  const merged: AiProposalEdit[] = [];
  const fallbackAddNote = fallbackEdits.find((edit) => edit.type === "addNote");
  if (modelHasReconcileNote) {
    merged.push(...modelEdits.filter((edit) => edit.type === "addNote"));
  } else if (fallbackAddNote) {
    merged.push(fallbackAddNote);
  }

  const modelHighlightsByNote = new Map<string, AiProposalEdit>();
  modelEdits
    .filter((edit): edit is Extract<AiProposalEdit, { type: "addHighlight" }> => edit.type === "addHighlight")
    .forEach((edit) => {
      modelHighlightsByNote.set(edit.noteId, edit);
    });

  const fallbackHighlights = fallbackEdits.filter(
    (edit): edit is Extract<AiProposalEdit, { type: "addHighlight" }> => edit.type === "addHighlight",
  );

  fallbackHighlights.forEach((fbEdit) => {
    const modelEdit = modelHighlightsByNote.get(fbEdit.noteId);
    merged.push(modelEdit ?? fbEdit);
  });

  // Keep model highlights that target notes the fallback did not cover.
  modelHighlightsByNote.forEach((edit, noteId) => {
    const alreadyIncluded = merged.includes(edit);
    const coveredByFallback = fallbackHighlights.some((fb) => fb.noteId === noteId);
    if (!alreadyIncluded && !coveredByFallback) {
      merged.push(edit);
    }
  });

  // Suppress any destructive edits the model might have slipped in.
  return merged.filter((edit) => edit.type === "addNote" || edit.type === "addHighlight");
}

const SEMANTIC_MERGE_REQUIRED_NOTE_SECTIONS = [
  "Conflict",
  "Positions",
  "Resolution",
  "How to apply",
  "Open questions",
];

function isUnusableSemanticMergeAddNote(edit: AiProposalEdit): boolean {
  if (edit.type !== "addNote") return false;
  const firstLine = edit.text.trim().split(/\r?\n/)[0]?.trim().toLowerCase() ?? "";
  if (firstLine === "shared state") return true;
  if (hasSectionHeading(edit.text, "Past") || hasSectionHeading(edit.text, "Now") || hasSectionHeading(edit.text, "Future")) {
    return true;
  }
  if (hasSectionHeading(edit.text, "Agreed signal") || hasSectionHeading(edit.text, "Merged next move")) {
    return true;
  }
  return !SEMANTIC_MERGE_REQUIRED_NOTE_SECTIONS.every((section) => hasSectionHeading(edit.text, section));
}

function hasSectionHeading(text: string, section: string): boolean {
  const normalizedSection = section.toLowerCase();
  return text.split(/\r?\n/).some((line) => {
    const normalizedLine = line.trim().toLowerCase();
    return normalizedLine === normalizedSection || normalizedLine.startsWith(`${normalizedSection}:`);
  });
}

/**
 * Best-effort recovery of the reviewer's display name from the semantic-merge
 * instruction text. The instruction is generated in Act2Panel.tsx and begins
 * with `<reviewer> is reconciling parallel collaborator notes...`. Returning
 * undefined falls back to a generic label.
 */
function extractReviewerNameFromInstruction(instruction: string): string | undefined {
  const match = instruction.match(/^([\w\-'.]+(?:\s[\w\-'.]+){0,2})\s+is\s+reconciling\b/);
  return match?.[1]?.trim() || undefined;
}

function getUsableHighlightEdit(
  edits: AiProposalEdit[],
  notes: CanvasSnapshot["notes"],
  excludedNoteIds: Set<string> = new Set(),
): Extract<AiProposalEdit, { type: "addHighlight" }> | null {
  const noteById = new Map(notes.map((note) => [note.id, note]));
  const highlight = edits.find((edit): edit is Extract<AiProposalEdit, { type: "addHighlight" }> => {
    if (edit.type !== "addHighlight") return false;
    if (excludedNoteIds.has(edit.noteId)) return false;
    const note = noteById.get(edit.noteId);
    return Boolean(note && edit.text.trim() && note.text.includes(edit.text.trim()));
  });
  if (!highlight) return null;

  return {
    ...highlight,
    sourceNoteIds: highlight.sourceNoteIds?.length ? highlight.sourceNoteIds : [highlight.noteId],
  };
}

function isPlaceholderAddNote(edit: AiProposalEdit): boolean {
  if (edit.type !== "addNote") return false;
  const normalized = edit.text.trim().toLowerCase();
  return (
    /\b(tbd|todo|placeholder|example only)\b/.test(normalized) ||
    /\b(add|fill|insert|capture|write)\b.{0,48}\b(here|later|details)\b/.test(normalized) ||
    /\bnone captured\b/.test(normalized)
  );
}

function getLaneHeaderKey(edit: AiProposalEdit): string[] {
  if (edit.type !== "addNote") return [];
  const firstLine = edit.text.trim().split(/\r?\n/)[0]?.toLowerCase() ?? "";
  if (/\bcontext|background|facts?\b/.test(firstLine)) return ["context"];
  if (/\brisks?|blockers?|unknowns?\b/.test(firstLine)) return ["risks"];
  if (/\bnext steps?|actions?|follow-ups?\b/.test(firstLine)) return ["next"];
  return [];
}

function isInactiveLaneHeader(edit: AiProposalEdit, activeLaneKeys: Set<LaneKey>): boolean {
  const [laneKey] = getLaneHeaderKey(edit);
  return isLaneKey(laneKey) && !activeLaneKeys.has(laneKey);
}

function normalizeEdit(value: unknown, noteIds: Set<string>, groundingIds: Set<string>): AiProposalEdit | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  const metadata = normalizeEditMetadata(value, noteIds, groundingIds);

  if (value.type === "addNote") {
    const text = coerceText(value.text, "");
    if (!text) return null;
    return {
      ...metadata,
      type: "addNote",
      text,
      x: coerceNumber(value.x, 120),
      y: coerceNumber(value.y, 120),
      color: coerceNoteColor(value.color),
    };
  }

  if (value.type === "updateNoteText") {
    const id = coerceText(value.id, "");
    const text = coerceText(value.text, "");
    if (!id || !text || !noteIds.has(id)) return null;
    return { ...metadata, type: "updateNoteText", id, text };
  }

  if (value.type === "moveNote") {
    const id = coerceText(value.id, "");
    if (!id || !noteIds.has(id)) return null;
    return {
      ...metadata,
      type: "moveNote",
      id,
      x: coerceNumber(value.x, 120),
      y: coerceNumber(value.y, 120),
    };
  }

  if (value.type === "deleteNote") {
    const id = coerceText(value.id, "");
    if (!id || !noteIds.has(id)) return null;
    return {
      ...metadata,
      type: "deleteNote",
      id,
      sourceNoteIds: metadata.sourceNoteIds ?? [id],
    };
  }

  if (value.type === "addShape") {
    const shape = coerceShapeType(value.shape);
    if (!shape) return null;
    return {
      ...metadata,
      type: "addShape",
      shape,
      x: coerceNumber(value.x, 120),
      y: coerceNumber(value.y, 120),
      size: coerceNumber(value.size, 60),
      color: coerceText(value.color, "#64a7dd"),
    };
  }

  if (value.type === "addTask") {
    const title = coerceText(value.title, "");
    if (!title) return null;
    return {
      ...metadata,
      type: "addTask",
      title: title.slice(0, 180),
      owner: coerceOptionalText(value.owner, 80),
      timing: coerceOptionalText(value.timing, 80),
      sourceAuthors: coerceStringArray(value.sourceAuthors, 8),
      sourceCreatedAt: coerceNumberArray(value.sourceCreatedAt, 8),
    };
  }

  if (value.type === "addHighlight") {
    const noteId = coerceText(value.noteId, "");
    const text = coerceText(value.text, "");
    if (!noteId || !noteIds.has(noteId) || !text) return null;
    return {
      ...metadata,
      type: "addHighlight",
      noteId,
      text: text.slice(0, 160),
      color: coerceOptionalText(value.color, 32),
    };
  }

  if (value.type === "replaceSpan") {
    const noteId = coerceText(value.noteId, "");
    const find = coerceText(value.find, "");
    const replace = coerceText(value.replace, "");
    if (!noteId || !noteIds.has(noteId) || !find || !replace) return null;
    return {
      ...metadata,
      type: "replaceSpan",
      noteId,
      find: find.slice(0, 320),
      replace: replace.slice(0, 320),
    };
  }

  return null;
}

function normalizeEditMetadata(
  value: Record<string, unknown>,
  noteIds: Set<string>,
  groundingIds: Set<string>,
): AiProposalEditMetadata {
  return {
    sourceNoteIds: coerceIdArray(value.sourceNoteIds, noteIds),
    sourceGroundingIds: coerceIdArray(value.sourceGroundingIds, groundingIds),
    rationale: coerceOptionalText(value.rationale, 240),
  };
}

function isOrganizeInstruction(normalizedInstruction: string): boolean {
  return (
    normalizedInstruction.includes("organize") ||
    normalizedInstruction.includes("group") ||
    normalizedInstruction.includes("cluster") ||
    normalizedInstruction.includes("arrange") ||
    normalizedInstruction.includes("structure") ||
    normalizedInstruction.includes("clean up") ||
    normalizedInstruction.includes("cleanup")
  );
}

function isContributionMapInstruction(normalizedInstruction: string): boolean {
  return (
    normalizedInstruction.includes("map contribution") ||
    normalizedInstruction.includes("contribution map") ||
    normalizedInstruction.includes("contributions by") ||
    normalizedInstruction.includes("contributor summary") ||
    normalizedInstruction.includes("one note per contributor") ||
    normalizedInstruction.includes("by author") ||
    normalizedInstruction.includes("by user") ||
    normalizedInstruction.includes("source user")
  );
}

function isSemanticMergeInstruction(normalizedInstruction: string): boolean {
  return (
    normalizedInstruction.includes("semantic merge") ||
    normalizedInstruction.includes("merged decision") ||
    normalizedInstruction.includes("merge parallel") ||
    normalizedInstruction.includes("parallel collaborator") ||
    normalizedInstruction.includes("overlapping collaborator")
  );
}

function isSharedStateInstruction(normalizedInstruction: string): boolean {
  return (
    normalizedInstruction.includes("shared state") ||
    normalizedInstruction.includes("current stage") ||
    normalizedInstruction.includes("previous stage") ||
    normalizedInstruction.includes("next stage") ||
    normalizedInstruction.includes("open question") ||
    normalizedInstruction.includes("stage brief")
  );
}

function isTaskHandoffInstruction(normalizedInstruction: string): boolean {
  if (isVisualMarkerInstruction(normalizedInstruction)) return false;
  return (
    normalizedInstruction.includes("task handoff") ||
    normalizedInstruction.includes("create task") ||
    normalizedInstruction.includes("tasks") ||
    normalizedInstruction.includes("work item") ||
    normalizedInstruction.includes("handoff")
  );
}

function isVisualMarkerInstruction(normalizedInstruction: string): boolean {
  return (
    normalizedInstruction.includes("marker") ||
    normalizedInstruction.includes("flag") ||
    normalizedInstruction.includes("visual") ||
    normalizedInstruction.includes("priority") ||
    normalizedInstruction.includes("highlight") ||
    normalizedInstruction.includes("underline")
  );
}

function getTargetNotes(target: AiTarget | undefined, notes: CanvasSnapshot["notes"]): CanvasSnapshot["notes"] {
  if (!target || target.kind === "canvas") return notes;
  if (target.kind === "note") return notes.filter((note) => note.id === target.id);
  const ids = new Set(target.ids);
  return notes.filter((note) => ids.has(note.id));
}

function getFeedbackLimit(feedback?: ProposalFeedback[]): number {
  const latest = feedback?.[0];
  if (!latest) return 12;
  const revisionCount = getFeedbackRevisionCount(feedback);
  if (latest.reason === "needsSmallerEdits") return Math.max(1, 3 - revisionCount);
  if (latest.reason === "tooBroad") return Math.max(2, 5 - revisionCount);
  return 12;
}

function getFeedbackRevisionCount(feedback?: ProposalFeedback[]): number {
  return Math.min(feedback?.length ?? 0, 3);
}

function focusNotesByFeedback(notes: CanvasSnapshot["notes"], feedback?: ProposalFeedback[]): CanvasSnapshot["notes"] {
  const tokens = getFeedbackFocusTokens(feedback);
  if (tokens.length === 0 || notes.length <= 1) return notes;

  const scored = notes
    .map((note, index) => {
      const haystack = normalizeComparableText(`${note.author} ${note.text}`);
      const score = tokens.reduce((total, token) => total + (haystack.includes(token) ? 1 : 0), 0);
      return { note, index, score };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);

  if (scored.length === 0) return notes;

  const focused = scored.map((item) => item.note);
  const rest = notes.filter((note) => !focused.some((focusedNote) => focusedNote.id === note.id));
  return [...focused, ...rest];
}

function selectNotesForFeedback(
  notes: CanvasSnapshot["notes"],
  feedback?: ProposalFeedback[],
): CanvasSnapshot["notes"] {
  return focusNotesByFeedback(notes, feedback).slice(0, getFeedbackLimit(feedback));
}

function getFeedbackFocusTokens(feedback?: ProposalFeedback[]): string[] {
  const details = feedback?.[0]?.details;
  if (!details) return [];
  const stopWords = new Set([
    "about",
    "after",
    "again",
    "change",
    "clear",
    "draft",
    "focus",
    "focused",
    "make",
    "more",
    "next",
    "only",
    "please",
    "proposal",
    "review",
    "should",
    "this",
    "with",
    "action",
    "actions",
    "author",
    "carefully",
    "changes",
    "checkable",
    "collaborators",
    "concrete",
    "context",
    "dates",
    "draft",
    "easier",
    "facts",
    "highest",
    "improvement",
    "invent",
    "keep",
    "notes",
    "original",
    "owners",
    "preserve",
    "relevant",
    "remove",
    "risks",
    "selected",
    "skip",
    "smaller",
    "source",
    "summaries",
    "target",
    "timing",
    "unrelated",
    "value",
    "wording",
  ]);
  return [...new Set(
    normalizeComparableText(details)
      .split(" ")
      .filter((token) => token.length >= 4 && !stopWords.has(token)),
  )].slice(0, 8);
}

function buildFeedbackFocusLine(feedback?: ProposalFeedback[]): string {
  const latest = feedback?.[0];
  const details = normalizeComparableText(latest?.details ?? "");
  if (!latest || !details) return "";

  const focusParts: string[] = [];
  if (latest.reason === "needsSmallerEdits" || /\b(smaller|highest value|focused|narrow)\b/.test(details)) {
    focusParts.push("highest-value changes");
  }
  if (/\b(leadership|manager|stakeholder|exec|executive)\b/.test(details)) {
    focusParts.push("stakeholder-ready progress");
  }
  if (/\b(progress|current|status)\b/.test(details)) {
    focusParts.push("current progress");
  }
  if (/\b(decision|decisions|risk|risks|blocker|blocked)\b/.test(details)) {
    focusParts.push("decisions and blockers");
  }
  if (/\b(next|step|steps|action|actions|task|tasks|handoff)\b/.test(details)) {
    focusParts.push("next steps");
  }
  if (/\b(preserve|facts|source|wording)\b/.test(details)) {
    focusParts.push("source facts");
  }

  const uniqueParts = [...new Set(focusParts)].slice(0, 3);
  if (uniqueParts.length === 0) return "";
  return `Focus: ${uniqueParts.join(", ")}.`;
}

function buildOrganizeCanvasEdits(
  notes: CanvasSnapshot["notes"],
  feedback?: ProposalFeedback[],
): AiProposalEdit[] {
  const selectedNotes = selectNotesForFeedback(notes, feedback);
  type OrganizeLane = {
    key: LaneKey;
    title: string;
    prompt: string;
    x: number;
    y: number;
    color: StickyNote["color"];
  };

  const lanes: Record<LaneKey, OrganizeLane> = {
    context: {
      key: "context",
      title: "Context",
      prompt: "Shared facts and goals",
      x: 72,
      y: 78,
      color: "blue" as const,
    },
    risks: {
      key: "risks",
      title: "Risks",
      prompt: "Blockers, unknowns, and decisions",
      x: 388,
      y: 78,
      color: "pink" as const,
    },
    next: {
      key: "next",
      title: "Next steps",
      prompt: "Concrete follow-ups and owners",
      x: 704,
      y: 78,
      color: "green" as const,
    },
  };
  const activeLaneKeys = getActiveLaneKeys(selectedNotes);
  const laneOrder = (["context", "risks", "next"] as LaneKey[])
    .filter((key) => activeLaneKeys.has(key))
    .map((key, index) => ({
      ...lanes[key],
      x: 72 + index * ORGANIZE_LANE_WIDTH,
    }));
  const laneByKey = new Map<LaneKey, OrganizeLane>(laneOrder.map((lane) => [lane.key, lane]));
  const laneNextY = new Map<LaneKey, number>();
  const edits: AiProposalEdit[] = laneOrder.map((lane) => {
    const text = `${lane.title}\n${lane.prompt}`;
    laneNextY.set(lane.key, lane.y + estimateCanvasNoteHeightForLayout(text) + GENERATED_NOTE_GAP_Y);
    return {
      type: "addNote",
      text,
      x: lane.x,
      y: lane.y,
      color: lane.color,
      sourceNoteIds: selectedNotes
        .filter((note) => classifyNoteForLane(note.text) === lane.key)
        .map((note) => note.id)
        .slice(0, 6),
      rationale: `Creates a visible ${lane.title} lane for reviewing the selected canvas content.`,
    };
  });

  for (const note of selectedNotes) {
    const laneKey = classifyNoteForLane(note.text);
    const lane = laneByKey.get(laneKey);
    if (!lane) continue;
    const y = laneNextY.get(laneKey) ?? lane.y + 180 + GENERATED_NOTE_GAP_Y;
    laneNextY.set(laneKey, y + estimateCanvasNoteHeightForLayout(note.text) + GENERATED_NOTE_GAP_Y);
    edits.push({
      type: "moveNote",
      id: note.id,
      x: lane.x,
      y,
      sourceNoteIds: [note.id],
      rationale: `Moves this note into the ${lane.title} group based on its content.`,
    });
  }

  return edits;
}

function buildContributionMapEdits(
  notes: CanvasSnapshot["notes"],
  feedback?: ProposalFeedback[],
): AiProposalEdit[] {
  // Same rationale as `normalizeContributionMapEdits`: contribution
  // mapping must cover every author, so we cannot let the feedback
  // 12-note cap drop low-frequency contributors.
  const selectedNotes = notes.filter((note) => !isDerivedBoardNote(note.text));
  void feedback;
  if (selectedNotes.length === 0) return [];

  const grouped = groupNotesByAuthor(selectedNotes);
  const edits: AiProposalEdit[] = [buildContributionMapHeaderEdit(selectedNotes, grouped.length)];
  const summaryTexts = grouped.map((group) => formatContributionMapSummaryText(group));
  const summaryPositions = getContributionSummaryPositions(selectedNotes, summaryTexts);
  const usedColors = new Set<StickyNote["color"]>();

  grouped.forEach((group, groupIndex) => {
    const { x, y } = summaryPositions[groupIndex];
    const sourceNoteIds = group.notes.map((note) => note.id);
    const color = getContributionGroupColor(group, usedColors);
    usedColors.add(color);
    edits.push({
      type: "addNote",
      text: summaryTexts[groupIndex],
      x,
      y,
      color,
      sourceNoteIds,
      rationale: `Adds a readable map of ${group.author}'s source notes before replacing the scattered originals.`,
    });
  });

  edits.push(...buildContributionMapReplacementDeleteEdits(selectedNotes));

  return edits;
}

function normalizeContributionMapEdits(
  edits: Extract<AiProposalEdit, { type: "addNote" }>[],
  notes: CanvasSnapshot["notes"],
  feedback?: ProposalFeedback[],
): AiProposalEdit[] {
  // Contribution mapping must cover EVERY author in the scoped notes
  // (including authors with only a single source note). Do NOT use
  // `selectNotesForFeedback` here: that helper caps the candidate set at
  // 12 notes by default, which silently drops low-frequency contributors
  // (e.g. an author with one note when the board has more than 12 notes
  // in total) and produces an incomplete contributor map.
  const selectedNotes = notes.filter((note) => !isDerivedBoardNote(note.text));
  // Acknowledge `feedback` so the param is intentionally consumed for
  // any future "reject + regenerate" tuning we add to this workflow.
  void feedback;
  if (selectedNotes.length === 0 || edits.length === 0) return [];

  const grouped = groupNotesByAuthor(selectedNotes);
  const usedEditIndexes = new Set<number>();
  const normalized: AiProposalEdit[] = [buildContributionMapHeaderEdit(selectedNotes, grouped.length)];
  const summaryTexts = grouped.map((group) => {
    const matchingEdit = edits.find((edit) => contributionMapEditMatchesGroup(edit, group));
    return formatContributionMapSummaryText(group, matchingEdit?.text);
  });
  const summaryPositions = getContributionSummaryPositions(selectedNotes, summaryTexts);
  const usedColors = new Set<StickyNote["color"]>();

  grouped.forEach((group, groupIndex) => {
    const matchingEditIndex = edits.findIndex((edit, index) =>
      !usedEditIndexes.has(index) && contributionMapEditMatchesGroup(edit, group)
    );
    if (matchingEditIndex >= 0) usedEditIndexes.add(matchingEditIndex);

    const matchingEdit = matchingEditIndex >= 0 ? edits[matchingEditIndex] : undefined;
    const { x, y } = summaryPositions[groupIndex];
    const color = getContributionGroupColor(group, usedColors);
    usedColors.add(color);
    normalized.push({
      type: "addNote",
      text: summaryTexts[groupIndex],
      x,
      y,
      color,
      sourceNoteIds: group.notes.map((note) => note.id),
      sourceGroundingIds: matchingEdit?.sourceGroundingIds,
      rationale: matchingEdit?.rationale ?? `Adds a readable map of ${group.author}'s source notes before replacing the scattered originals.`,
    });
  });

  return [...normalized, ...buildContributionMapReplacementDeleteEdits(selectedNotes)];
}

function buildContributionMapReplacementDeleteEdits(
  notes: CanvasSnapshot["notes"],
): Extract<AiProposalEdit, { type: "deleteNote" }>[] {
  return notes.map((note) => ({
    type: "deleteNote",
    id: note.id,
    sourceNoteIds: [note.id],
    rationale: "Contributor map captures this original source note, so Accept replaces the scattered source layer with the map.",
  }));
}

function buildContributionMapHeaderEdit(
  notes: CanvasSnapshot["notes"],
  contributorCount: number,
): Extract<AiProposalEdit, { type: "addNote" }> {
  const { x, y } = getContributionMapHeaderPosition(notes);
  return {
    type: "addNote",
    text: [
      "Contributor map",
      `${pluralize(contributorCount, "contributor")} · ${pluralize(notes.length, "source note")}`,
      "Scan who brought which signal. Accept replaces the scattered source notes with this map.",
    ].join("\n"),
    x,
    y,
    color: "green",
    sourceNoteIds: notes.map((note) => note.id),
    rationale: "Creates a visible AI-generated map layer that replaces scattered source notes after review.",
  };
}

function formatContributionMapSummaryText(
  group: { author: string; notes: CanvasSnapshot["notes"] },
  modelText?: string,
): string {
  const timeRange = formatNoteTimeRange(group.notes);
  const modelBullets = extractContributionMapBullets(modelText, group.author);
  const fallbackBullets = group.notes.map((note) => `- ${summarizeContributorNoteWithDate(note)}`);
  return [
    `${group.author} summary`,
    `${pluralize(group.notes.length, "source note")}${timeRange ? ` · ${timeRange}` : ""}`,
    ...(modelBullets.length > 0 ? modelBullets : fallbackBullets),
  ].filter(Boolean).join("\n");
}

function extractContributionMapBullets(modelText: string | undefined, author: string): string[] {
  if (!modelText) return [];
  const lines = modelText
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const contentLines = lines.filter((line, index) => {
    const normalizedLine = line.replace(/^[-*•]\s*/, "");
    if (index === 0 && (normalizedLine.toLowerCase().includes(author.toLowerCase()) || /\b(contributor|summary|map)\b/i.test(normalizedLine))) return false;
    if (/^\d+\s+source notes?\b|^sources?\b|^source note count\b|^time range\b|^createdat\b|^created at\b|^contributor\b/i.test(normalizedLine)) return false;
    return true;
  });
  return contentLines
    .slice(0, 4)
    .map((line) => `- ${line.replace(/^[-*•]\s*/, "")}`);
}

function contributionMapEditMatchesGroup(
  edit: Extract<AiProposalEdit, { type: "addNote" }>,
  group: { author: string; notes: CanvasSnapshot["notes"] },
): boolean {
  const groupNoteIds = new Set(group.notes.map((note) => note.id));
  if ((edit.sourceNoteIds ?? []).some((id) => groupNoteIds.has(id))) return true;
  return edit.text.toLowerCase().includes(group.author.toLowerCase());
}

function getContributionMapHeaderPosition(notes: CanvasSnapshot["notes"]): { x: number; y: number } {
  return {
    x: 72,
    y: getContributionMapStartY(notes),
  };
}

function getContributionSummaryPositions(
  notes: CanvasSnapshot["notes"],
  summaryTexts: string[],
): Array<{ x: number; y: number }> {
  const viewportWidth = typeof window === "undefined" ? 1200 : window.innerWidth;
  const columns = viewportWidth < 760 ? 1 : viewportWidth < 1120 ? 2 : 3;
  const headerHeight = estimateContributionMapNoteHeight(buildContributionMapHeaderEdit(notes, groupNotesByAuthor(notes).length).text);
  const columnY = Array.from({ length: columns }, () => getContributionMapStartY(notes) + headerHeight + CONTRIBUTION_SUMMARY_GAP_Y);

  return summaryTexts.map((text, index) => {
    const column = index % columns;
    const position = {
      x: 72 + column * CONTRIBUTION_LANE_WIDTH,
      y: columnY[column],
    };
    columnY[column] += estimateContributionMapNoteHeight(text) + CONTRIBUTION_SUMMARY_GAP_Y;
    return position;
  });
}

function getContributionMapStartY(notes: CanvasSnapshot["notes"]): number {
  if (notes.length === 0) return 340;
  return Math.max(340, Math.max(...notes.map((note) => note.y)) + 280);
}

function estimateContributionMapNoteHeight(text: string): number {
  return estimateCanvasNoteHeightForLayout(text);
}

function getContributionGroupColor(
  group: { author: string; notes: CanvasSnapshot["notes"] },
  usedColors: Set<StickyNote["color"]>,
): StickyNote["color"] {
  const colorCounts = new Map<StickyNote["color"], number>();
  group.notes.forEach((note) => {
    colorCounts.set(note.color, (colorCounts.get(note.color) ?? 0) + 1);
  });

  const preferred = [...colorCounts.entries()]
    .sort((left, right) => right[1] - left[1])[0]?.[0];
  if (preferred && !usedColors.has(preferred)) return preferred;

  return CONTRIBUTION_NOTE_COLORS.find((color) => !usedColors.has(color)) ?? preferred ?? CONTRIBUTION_NOTE_COLORS[0];
}

function buildSemanticMergeEdits(
  notes: CanvasSnapshot["notes"],
  feedback?: ProposalFeedback[],
  reviewerName?: string,
): AiProposalEdit[] {
  const candidates = selectNotesForFeedback(
    notes.filter((note) => isSemanticMergeCandidate(note.text)),
    feedback,
  );
  const selectedNotes = chooseSemanticMergeNotes(candidates);
  if (selectedNotes.length < 2) return [];

  const reviewer = reviewerName?.trim() || "Reviewer";
  const sourceNoteIds = selectedNotes.map((note) => note.id);
  const authors = [...new Set(selectedNotes.map((note) => getSemanticContributorLabel(note)).filter(Boolean))];
  const nextMove = buildSemanticNextMoveLine(selectedNotes);

  const conflictPhraseByNote = new Map<string, string>();
  selectedNotes.forEach((note) => {
    const phrase = pickSemanticConflictPhrase(note.text);
    if (phrase) conflictPhraseByNote.set(note.id, phrase);
  });

  const conflict = buildSemanticConflictLine(selectedNotes, conflictPhraseByNote);
  const tensionQuoteLines = selectedNotes.map((note) => {
    const phrase = conflictPhraseByNote.get(note.id) ?? summarizeNoteForState(getContributorNoteBody(note.text));
    const credit = getSemanticContributorCredit(note);
    return `- "${phrase}" — ${credit}`;
  });

  const topic = buildSemanticReconcileTopic(selectedNotes);
  const text = [
    `${reviewer}'s reconcile — ${topic}`,
    `Drafted with AI from ${pluralize(selectedNotes.length, "source note")} · Cited: ${authors.join(", ")}`,
    "",
    "Conflict",
    `- ${conflict}`,
    "",
    "Positions",
    ...tensionQuoteLines,
    "",
    "Resolution",
    `- Recommended path: ${nextMove}`,
    "",
    "How to apply",
    "- Keep original source notes unchanged; use the highlighted phrases as the review boundary.",
    "- If accepted, use this reconcile note as the shared decision record, not as a rewrite of any contributor's note.",
    "",
    "Open questions",
    "- What condition would make the team choose a different path or reopen this conflict?",
  ].join("\n");
  const { x, y } = getSemanticMergePosition(notes, text);
  const edits: AiProposalEdit[] = [{
    type: "addNote",
    text,
    x,
    y,
    color: "purple",
    sourceNoteIds,
    rationale: `${reviewer}'s conflict brief names the disagreement, proposed resolution, application boundary, and remaining question while preserving every source contributor's wording on canvas.`,
  }];

  selectedNotes.forEach((note) => {
    const phrase = conflictPhraseByNote.get(note.id);
    if (!phrase) return;
    edits.push({
      type: "addHighlight",
      noteId: note.id,
      text: phrase,
      color: "#f59e0b",
      sourceNoteIds: [note.id],
      rationale: "Semantic merge highlight: marks the source phrase quoted in the reviewer's reconcile note.",
    });
  });

  return edits;
}

/**
 * Picks a substring of `text` that is a likely conflicting phrase / sentence
 * for the semantic merge fallback. Prefers the first substantive body line
 * (skipping author headers like "Alex - May 11"). Result is guaranteed to be
 * a substring of the original text so addHighlight can match it verbatim.
 */
function pickSemanticConflictPhrase(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const body = lines.find((line) =>
    line.length > 4 && !/^[A-Z][a-z]+\s*[-·]\s+/.test(line),
  );
  const chosen = body ?? lines[0] ?? text.trim();
  // Return verbatim from the original text so highlight matching succeeds.
  const trimmedChosen = chosen.slice(0, 140).trim();
  const idx = text.indexOf(trimmedChosen);
  return idx >= 0 ? trimmedChosen : chosen.slice(0, 140);
}

/** Short human-readable topic for the reconcile note title. */
function buildSemanticReconcileTopic(notes: CanvasSnapshot["notes"]): string {
  const authors = [...new Set(notes.map((note) => getSemanticContributorLabel(note)).filter(Boolean))];
  if (authors.length >= 2) {
    return `${authors.slice(0, 2).join(" vs ")} on the open thread`;
  }
  return "the open thread";
}

function isSemanticMergeCandidate(text: string): boolean {
  const firstLine = text.trim().split(/\r?\n/)[0]?.toLowerCase() ?? "";
  return Boolean(
    text.trim() &&
    firstLine !== "shared state" &&
    firstLine !== "semantic merge" &&
    !/\b(context|risks?|next steps?|input)$/.test(firstLine)
  );
}

function chooseSemanticMergeNotes(notes: CanvasSnapshot["notes"]): CanvasSnapshot["notes"] {
  if (notes.length <= 4) return notes;

  const tokenSets = notes.map((note) => getSemanticMergeTokens(note.text));
  let bestPair: [number, number] = [0, 1];
  let bestScore = -1;

  for (let left = 0; left < tokenSets.length; left += 1) {
    for (let right = left + 1; right < tokenSets.length; right += 1) {
      const score = intersectionSize(tokenSets[left], tokenSets[right]);
      if (score > bestScore) {
        bestScore = score;
        bestPair = [left, right];
      }
    }
  }

  const seedTokens = new Set([...tokenSets[bestPair[0]], ...tokenSets[bestPair[1]]]);
  return notes
    .map((note, index) => ({
      note,
      index,
      score: intersectionSize(tokenSets[index], seedTokens) + semanticMergePriorityScore(note.text),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 4)
    .map((item) => item.note);
}

function getSemanticMergeTokens(text: string): Set<string> {
  const stopWords = new Set([
    "about", "after", "again", "because", "before", "being", "board", "brief", "canvas", "could",
    "current", "details", "from", "have", "into", "more", "note", "notes", "project", "should",
    "source", "state", "summary", "that", "their", "there", "these", "this", "with", "work",
  ]);
  return new Set(
    normalizeComparableText(text)
      .split(/\s+/)
      .filter((token) => token.length > 3 && !stopWords.has(token)),
  );
}

function intersectionSize(left: Set<string>, right: Set<string>): number {
  let count = 0;
  left.forEach((token) => {
    if (right.has(token)) count += 1;
  });
  return count;
}

function semanticMergePriorityScore(text: string): number {
  const normalized = text.toLowerCase();
  let score = 0;
  if (/\b(progress|outcome|readout|story|recommendation|stakeholder|insight)\b/.test(normalized)) score += 8;
  if (/\b(production|auth|latency|service|governance|ownership|readiness|sharepoint)\b/.test(normalized)) score += 5;
  if (/\b(ai|agent|copilot|human|review|feedback|semantic|merge)\b/.test(normalized)) score += 4;
  if (/\b(fluid|sharedtree|sharepoint|odsp|pages|office|platform)\b/.test(normalized)) score += 3;
  if (/\b(decision|tradeoff|risk|blocker|need|should|must|but|however)\b/.test(normalized)) score += 2;
  return score;
}

function buildSemanticConflictLine(notes: CanvasSnapshot["notes"], conflictPhraseByNote: Map<string, string>): string {
  if (isProjectReadoutConflict(notes)) {
    return "The readout needs to show the project learning arc and prototype evidence while still making the production-readiness caveat credible.";
  }
  const pairedSignals = notes.slice(0, 2).map((note) => {
    const phrase = conflictPhraseByNote.get(note.id) ?? summarizeNoteForState(getContributorNoteBody(note.text));
    return `${getSemanticContributorCredit(note)} says "${phrase}"`;
  });
  if (pairedSignals.length >= 2) {
    return `${pairedSignals.join(" while ")}. The team needs one reviewable path forward.`;
  }
  return "The team needs to resolve the conflicting interpretation before committing the next shared state.";
}

function buildSemanticNextMoveLine(notes: CanvasSnapshot["notes"]): string {
  if (isProjectReadoutConflict(notes)) {
    return "Lead the next review with a three-part story: learning arc, evidence from the prototype, and recommendation with platform-readiness tradeoffs.";
  }
  const actionCandidates = notes.flatMap((note) =>
    extractActionSentences(getContributorNoteBody(note.text)).map((sentence) => ({ note, sentence }))
  );
  const action = actionCandidates[0];
  if (action) return `${getSemanticContributorLabel(action.note)}: ${compressStateSummary(action.sentence)}`;
  const lead = notes[0];
  return lead
    ? `${getSemanticContributorLabel(lead)}: turn the merged signal into one reviewable next decision.`
    : "Turn the merged signal into one reviewable next decision.";
}

function isProjectReadoutConflict(notes: CanvasSnapshot["notes"]): boolean {
  const text = normalizeComparableText(notes.map((note) => note.text).join(" "));
  return (
    /\b(progress|outcome|readout|story|recommendation)\b/.test(text) &&
    /\b(production|platform|readiness|sharepoint|governance|service|ownership)\b/.test(text) &&
    /\b(ai|human|review|stakeholder|pm|tradeoff|decision)\b/.test(text)
  );
}

function getSemanticContributorLabel(note: CanvasSnapshot["notes"][number]): string {
  const firstLine = note.text.trim().split(/\r?\n/)[0]?.trim() ?? "";
  const summaryMatch = firstLine.match(/^(.+?)\s+summary$/i);
  if (summaryMatch?.[1]) return summaryMatch[1].trim();

  const authoredHeading = firstLine.match(/^([A-Za-z][A-Za-z ]{1,32})\s+-\s+/);
  if (authoredHeading?.[1]) return authoredHeading[1].trim();

  return note.author || "Contributor";
}

function getSemanticContributorCredit(note: CanvasSnapshot["notes"][number]): string {
  const firstLine = note.text.trim().split(/\r?\n/)[0]?.trim() ?? "";
  const authoredHeading = firstLine.match(/^([A-Za-z][A-Za-z ]{1,32})\s*[-·]\s*(.+)$/);
  if (authoredHeading?.[1] && authoredHeading?.[2]) {
    return `${authoredHeading[1].trim()} (${authoredHeading[2].trim()})`;
  }
  return getSemanticContributorLabel(note);
}

function getSemanticMergePosition(notes: CanvasSnapshot["notes"], text: string): { x: number; y: number } {
  const stateBrief = notes.find((note) => note.text.trim().split(/\r?\n/)[0]?.toLowerCase() === "shared state");
  const preferredX = stateBrief ? stateBrief.x + CANVAS_NOTE_WIDTH + GENERATED_NOTE_GAP_X : 408;
  const preferredY = stateBrief ? stateBrief.y : 78;
  return findOpenNotePosition(
    notes.map((note) => noteToLayoutRect(note)),
    preferredX,
    preferredY,
    text,
  );
}

function buildSharedStateEdits(
  notes: CanvasSnapshot["notes"],
  feedback?: ProposalFeedback[],
): AiProposalEdit[] {
  const selectedNotes = selectNotesForFeedback(notes, feedback);
  if (selectedNotes.length === 0) return [];

  const sections = buildStageSections(selectedNotes);
  const contributorLine = buildContributorLine(selectedNotes);
  const feedbackFocusLine = buildFeedbackFocusLine(feedback);
  const lines = ["Shared state"];
  if (feedbackFocusLine) lines.push(feedbackFocusLine);
  if (contributorLine) lines.push(contributorLine);

  getSharedStateSectionOrder(feedback).forEach((key) => {
    const items = sections[key];
    if (items.length === 0) return;
    lines.push("");
    lines.push(stageTitle(key));
    items.slice(0, getSharedStateSectionLimit(key, feedback)).forEach((item) => {
      lines.push(`- ${item}`);
    });
  });

  const text = lines.join("\n");
  const { x, y } = findOpenNotePosition(
    selectedNotes.map((note) => noteToLayoutRect(note)),
    72,
    78,
    text,
  );

  return [{
    type: "addNote",
    text,
    x,
    y,
    color: "green",
    sourceNoteIds: selectedNotes.map((note) => note.id).slice(0, 8),
    rationale: "Adds one shared-state brief so collaborators can separate where the project is now from what must happen next.",
  }];
}

function getSharedStateSectionOrder(feedback?: ProposalFeedback[]): StageKey[] {
  const details = normalizeComparableText(feedback?.[0]?.details ?? "");
  if (/\b(question|questions|blocker|blockers|uncertainty|uncertain|unknown|open)\b/.test(details)) {
    return ["questions", "current", "next", "previous"];
  }
  if (/\b(timeline|past|future|brief)\b/.test(details)) {
    return ["previous", "current", "next", "questions"];
  }
  if (/\b(next|step|steps|action|actions|task|tasks|handoff|decision|decisions|leadership|stakeholder)\b/.test(details)) {
    return ["next", "questions", "current", "previous"];
  }
  if (/\b(progress|current|status|now)\b/.test(details)) {
    return ["current", "next", "questions", "previous"];
  }
  return ["previous", "current", "next", "questions"];
}

function getSharedStateSectionLimit(key: StageKey, feedback?: ProposalFeedback[]): number {
  const latest = feedback?.[0];
  const revisionCount = getFeedbackRevisionCount(feedback);
  if (!latest) return key === "next" ? 3 : 2;
  if (latest.reason === "needsSmallerEdits") return key === "next" ? Math.max(1, 3 - revisionCount) : 1;
  if (latest.reason === "tooBroad") return key === "next" ? 2 : 1;
  return key === "next" ? 3 : 2;
}

function summarizeContributorNoteWithDate(note: CanvasSnapshot["notes"][number]): string {
  const dateLabel = formatNoteDateLabel(note);
  const summary = summarizeContributorNote(note.text);
  return dateLabel ? `${dateLabel}: ${summary}` : summary;
}

function summarizeContributorNote(text: string): string {
  const cleaned = getContributorNoteBody(text).trim().replace(/\s+/g, " ");
  const action = extractActionSentences(cleaned)[0];
  const summary = action || cleaned;
  return compressStateSummary(summary.replace(/^[-*]\s*/, ""));
}

function getContributorNoteBody(text: string): string {
  const lines = text.replace(/\r/g, "").split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length <= 1) return text;
  if (/^[A-Za-z][A-Za-z ]{1,32}\s+-\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\b/i.test(lines[0])) {
    return lines.slice(1).join(" ");
  }
  if (/^[A-Za-z][A-Za-z ]{1,32}\s+-\s+/.test(lines[0])) {
    return lines.slice(1).join(" ");
  }
  if (/\bsummary$/i.test(lines[0])) {
    return /^source notes?\b|\d+\s+source notes?/i.test(lines[1] ?? "") ? lines.slice(2).join(" ") : lines.slice(1).join(" ");
  }
  if (/^[A-Za-z][A-Za-z ]{1,32}\s+-\s+(?:Project|Plan|Progress)\b/i.test(lines[0])) {
    return lines.slice(1).join(" ");
  }
  return text;
}

function isDerivedBoardNote(text: string): boolean {
  const firstLine = text.trim().split(/\r?\n/)[0]?.toLowerCase() ?? "";
  return (
    firstLine === "shared state" ||
    firstLine === "semantic merge" ||
    firstLine === "contributor map" ||
    firstLine === "context" ||
    firstLine === "risks" ||
    firstLine === "next steps" ||
    /\b(input|summary)$/.test(firstLine)
  );
}

type PriorityReason = "overdue" | "blocked" | "due" | "today" | "now" | "tomorrow" | "risk" | "action" | "fallback";

interface PriorityLineCandidate {
  text: string;
  score: number;
  reason: PriorityReason;
  index: number;
}

function buildPriorityHighlightEdit(
  scopedNotes: CanvasSnapshot["notes"],
  allNotes: CanvasSnapshot["notes"],
  targetNote?: CanvasSnapshot["notes"][number],
  options: { excludedNoteIds?: Set<string>; currentDateIso?: string } = {},
): Extract<AiProposalEdit, { type: "addHighlight" }> {
  const excludedNoteIds = options.excludedNoteIds ?? new Set<string>();
  const todayMs = resolveTodayMs(options.currentDateIso);

  const filteredScoped = scopedNotes.filter((note) => !excludedNoteIds.has(note.id));
  const filteredAll = allNotes.filter((note) => !excludedNoteIds.has(note.id));
  const candidatePool = filteredScoped.length > 0 ? filteredScoped : filteredAll;
  const note = targetNote && !excludedNoteIds.has(targetNote.id)
    ? targetNote
    : choosePriorityNote(candidatePool, todayMs);

  if (!note) {
    return {
      type: "addHighlight",
      noteId: "",
      text: "Priority",
      color: "#c83f4f",
      rationale: "Highlights the priority phrase when a source note is available.",
    };
  }

  const candidate = extractPriorityLineCandidate(note.text);
  const phrase = candidate?.text ?? firstNonStructuralPriorityLine(note.text) ?? truncateForNote(note.text, 84);
  const highlightText = phrase || "Priority";
  return {
    type: "addHighlight",
    noteId: note.id,
    text: highlightText,
    color: "#c83f4f",
    sourceNoteIds: [note.id],
    rationale: buildPriorityHighlightRationale(candidate, highlightText, note, todayMs),
  };
}

function choosePriorityNote(
  notes: CanvasSnapshot["notes"],
  todayMs: number,
): CanvasSnapshot["notes"][number] | undefined {
  let bestNote: CanvasSnapshot["notes"][number] | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;

  notes.forEach((note, index) => {
    const baseScore = scorePriorityNote(note.text);
    if (baseScore === Number.NEGATIVE_INFINITY) return;
    const recencyBoost = recencyBoostForNote(note, todayMs);
    const score = baseScore + recencyBoost - index * 0.01;
    if (score > bestScore) {
      bestScore = score;
      bestNote = note;
    }
  });

  return bestNote;
}

function scorePriorityNote(text: string): number {
  return extractPriorityLineCandidate(text)?.score ?? Number.NEGATIVE_INFINITY;
}

/**
 * Returns a recency-aware score adjustment for a note. We parse a calendar
 * date from either the note's authoring metadata (`createdAt`) or the first
 * "Author - Month DD" line. Notes dated today/in the future get a strong
 * positive boost; notes from earlier this week get a moderate boost; notes
 * older than two weeks get a steady penalty. This keeps the spotlight from
 * landing on stale May-11 content when today is May-28.
 */
function recencyBoostForNote(note: CanvasSnapshot["notes"][number], todayMs: number): number {
  const noteMs = resolveNoteDateMs(note, todayMs);
  if (noteMs === null) return 0;
  const oneDayMs = 24 * 60 * 60 * 1000;
  const diffDays = Math.round((noteMs - todayMs) / oneDayMs);
  if (diffDays >= 0) return 140; // today or future-dated work
  if (diffDays >= -3) return 90;
  if (diffDays >= -7) return 40;
  if (diffDays >= -14) return -20;
  return -80;
}

function resolveTodayMs(currentDateIso?: string): number {
  if (currentDateIso) {
    const parsed = Date.parse(currentDateIso);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function resolveNoteDateMs(note: CanvasSnapshot["notes"][number], todayMs: number): number | null {
  const fromHeader = parseAuthorLineDateMs(note.text, todayMs);
  if (fromHeader !== null) return fromHeader;
  if (typeof note.createdAt === "number" && Number.isFinite(note.createdAt)) return note.createdAt;
  return null;
}

const MONTH_NAME_TO_INDEX: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

/**
 * Parses a date from the first line of a note (the "Author - May 14" header
 * convention used across dated demo notes). Returns the millisecond timestamp
 * or null if no date is recognisable. When the year is missing we anchor on
 * the same year as `todayMs` so May 14 stays May 14 of "this year" rather
 * than 1970.
 */
function parseAuthorLineDateMs(text: string, todayMs: number): number | null {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  // ISO-style 2026-05-14 anywhere on the first line.
  const isoMatch = firstLine.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    const dt = new Date(Number(y), Number(m) - 1, Number(d));
    if (Number.isFinite(dt.getTime())) return dt.getTime();
  }
  // Month-name DD[, YYYY]
  const monthMatch = firstLine.match(/([A-Za-z]{3,9})\s+(\d{1,2})(?:,?\s+(\d{4}))?/);
  if (monthMatch) {
    const monthIndex = MONTH_NAME_TO_INDEX[monthMatch[1]?.toLowerCase() ?? ""];
    if (typeof monthIndex === "number") {
      const day = Number(monthMatch[2]);
      const year = monthMatch[3] ? Number(monthMatch[3]) : new Date(todayMs).getFullYear();
      if (day >= 1 && day <= 31) {
        const dt = new Date(year, monthIndex, day);
        if (Number.isFinite(dt.getTime())) return dt.getTime();
      }
    }
  }
  return null;
}

function extractPriorityLineCandidate(text: string): PriorityLineCandidate | null {
  const candidates = splitPriorityUnits(text)
    .map((unit, index) => ({ text: cleanPriorityLine(unit), index }))
    .filter(({ text: line }) => line && !isPriorityStructuralLine(line))
    .map(({ text: line, index }) => ({
      text: truncateForNote(line, 84),
      index,
      ...scorePriorityLine(line),
    }));

  if (candidates.length === 0) return null;

  return candidates.reduce((best, candidate) => {
    const candidateScore = candidate.score - candidate.index * 0.01;
    const bestScore = best.score - best.index * 0.01;
    return candidateScore > bestScore ? candidate : best;
  });
}

function splitPriorityUnits(text: string): string[] {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .flatMap((line) => {
      const trimmed = line.trim();
      if (!trimmed) return [];
      if (/^[-*•]\s+/.test(trimmed) || /^\[[ x]\]\s+/i.test(trimmed)) return [trimmed];
      const sentences = trimmed.split(/(?<=[.!?])\s+/).map((unit) => unit.trim()).filter(Boolean);
      return sentences.length > 1 ? sentences : [trimmed];
    });
}

function cleanPriorityLine(line: string): string {
  return line
    .replace(/^[-*•]\s*/, "")
    .replace(/^\[[ x]\]\s*/i, "")
    .trim()
    .replace(/\s+/g, " ");
}

function isPriorityStructuralLine(line: string): boolean {
  const comparable = normalizeComparableText(line);
  if (!comparable) return true;

  const exactHeaders = new Set([
    "shared state",
    "previous stage",
    "current stage",
    "next stage",
    "open questions",
    "context",
    "risks",
    "next steps",
    "task handoff",
    "proposal brief",
  ]);
  if (exactHeaders.has(comparable)) return true;
  if (/^[a-z0-9]+ (summary|input)$/.test(comparable)) return true;
  if (/^\d+ source notes?\b/.test(comparable)) return true;
  if (/^(previous|current|next) stage(?: \d+)?(?: [a-z]+)?$/.test(comparable)) return true;

  return false;
}

function scorePriorityLine(line: string): { score: number; reason: PriorityReason } {
  const normalized = line.toLowerCase();
  const hasAction =
    /\b(update|complete|send|meet|meeting|talk|call|sync|schedule|email|ping|follow(?:-?up)?|confirm|review|ask|assign|finish|finalize|ship|share|prepare|create|fix|resolve|decide|approve|unblock)\b/.test(
      normalized,
    );
  const hasRisk = /\b(risk|blocker|blocked|issue|problem|decision|decide|gap|depends|waiting)\b/.test(normalized);

  if (/\boverdue\b/.test(normalized)) return { score: 320 + (hasAction ? 30 : 0), reason: "overdue" };
  if (/\b(blocked|blocker)\b/.test(normalized)) return { score: 290 + (hasAction ? 30 : 0), reason: "blocked" };
  if (/\b(due|deadline|urgent|asap|time-critical)\b/.test(normalized)) return { score: 260 + (hasAction ? 30 : 0), reason: "due" };
  if (/\b(today|immediate|immediately)\b/.test(normalized)) return { score: 230 + (hasAction ? 30 : 0), reason: "today" };
  if (/\bnow\b/.test(normalized)) return { score: 220 + (hasAction ? 30 : 0), reason: "now" };
  if (/\btomorrow\b/.test(normalized)) return { score: 160 + (hasAction ? 30 : 0), reason: "tomorrow" };
  if (hasRisk) return { score: 120 + (hasAction ? 30 : 0), reason: "risk" };
  if (hasAction) return { score: 80 + (/\b(latest|next step|next action)\b/.test(normalized) ? 10 : 0), reason: "action" };

  return { score: 0, reason: "fallback" };
}

function firstNonStructuralPriorityLine(text: string): string | null {
  const line = splitPriorityUnits(text)
    .map(cleanPriorityLine)
    .find((unit) => unit && !isPriorityStructuralLine(unit));
  return line ? truncateForNote(line, 84) : null;
}

function buildPriorityHighlightRationale(
  candidate: PriorityLineCandidate | null,
  phrase: string,
  note?: CanvasSnapshot["notes"][number],
  todayMs?: number,
): string {
  const freshness = note && typeof todayMs === "number" ? describeNoteFreshness(note, todayMs) : "";
  const suffix = freshness ? ` ${freshness}` : "";
  switch (candidate?.reason) {
    case "overdue":
      return `Underlines the overdue item because it needs attention before other follow-ups.${suffix}`;
    case "blocked":
      return `Underlines the blocked item so the team can resolve the dependency before more work piles up.${suffix}`;
    case "due":
      return `Underlines the deadline or urgent item so the priority stays attached to the source note.${suffix}`;
    case "today":
    case "now":
      return `Underlines the immediate item before later follow-ups such as tomorrow or next week.${suffix}`;
    case "tomorrow":
      return `Underlines the dated follow-up because no more urgent item was found in the selected scope.${suffix}`;
    case "risk":
      return `Underlines the risk or decision line because it can block the next collaboration step.${suffix}`;
    case "action":
      return `No explicit deadline or blocker was found, so this underlines the most concrete next action instead of a section header.${suffix}`;
    case "fallback":
      return `No explicit priority signal was found, so this underlines the most specific content line: "${truncateForNote(phrase, 60)}".${suffix}`;
    default:
      return `Underlines a concrete source line without changing the note text.${suffix}`;
  }
}

function describeNoteFreshness(note: CanvasSnapshot["notes"][number], todayMs: number): string {
  const noteMs = resolveNoteDateMs(note, todayMs);
  if (noteMs === null) return "";
  const oneDayMs = 24 * 60 * 60 * 1000;
  const diffDays = Math.round((noteMs - todayMs) / oneDayMs);
  if (diffDays === 0) return "Source note is dated today.";
  if (diffDays > 0) return `Source note is dated ${diffDays} day${diffDays === 1 ? "" : "s"} ahead, so it stays the most timely item.`;
  if (diffDays >= -3) return `Source note is from the last few days (${-diffDays}d ago), still the freshest signal.`;
  if (diffDays >= -7) return `Source note is from this week (${-diffDays}d ago).`;
  return `Source note is ${-diffDays} day${diffDays === -1 ? "" : "s"} old, so newer notes (if any) may deserve attention first.`;
}

type StageKey = "previous" | "current" | "next" | "questions";

function groupNotesByAuthor(notes: CanvasSnapshot["notes"]): Array<{ author: string; notes: CanvasSnapshot["notes"] }> {
  const groups = new Map<string, CanvasSnapshot["notes"]>();
  notes.forEach((note) => {
    const author = note.author || "Unknown";
    const group = groups.get(author) ?? [];
    group.push(note);
    groups.set(author, group);
  });
  return [...groups.entries()]
    .map(([author, groupNotes]) => ({
      author,
      notes: [...groupNotes].sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0)),
    }))
    .sort((left, right) => {
      const leftTime = left.notes[0]?.createdAt ?? 0;
      const rightTime = right.notes[0]?.createdAt ?? 0;
      if (leftTime !== rightTime) return leftTime - rightTime;
      return left.author.localeCompare(right.author);
    });
}

function formatNoteTimeRange(notes: CanvasSnapshot["notes"]): string {
  const times = notes
    .map((note) => note.createdAt)
    .filter((time): time is number => typeof time === "number" && Number.isFinite(time))
    .sort((left, right) => left - right);
  if (times.length === 0) {
    const labels = notes.map(formatNoteDateLabel).filter(Boolean);
    const uniqueLabels = [...new Set(labels)];
    if (uniqueLabels.length === 0) return "";
    if (uniqueLabels.length === 1) return uniqueLabels[0];
    return `${uniqueLabels[0]} to ${uniqueLabels[uniqueLabels.length - 1]}`;
  }
  return formatCompactTimeRange(times[0], times[times.length - 1]);
}

function formatNoteDateLabel(note: CanvasSnapshot["notes"][number]): string {
  const sourceDate = extractSourceDateLabel(note.text);
  if (sourceDate) return sourceDate;
  if (typeof note.createdAt !== "number" || !Number.isFinite(note.createdAt)) return "";
  return new Date(note.createdAt).toLocaleDateString([], { month: "short", day: "numeric" });
}

function extractSourceDateLabel(text: string): string {
  const firstLine = text.trim().split(/\r?\n/)[0] ?? "";
  const match = firstLine.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+\d{1,2}\b/i);
  return match?.[0] ?? "";
}

function buildStageSections(notes: CanvasSnapshot["notes"]): Record<StageKey, string[]> {
  const sections: Record<StageKey, string[]> = { previous: [], current: [], next: [], questions: [] };
  notes.forEach((note) => {
    const owner = getStateOwner(note);
    getStateUnits(note.text).forEach((unit) => {
      const key = classifyStage(unit);
      const line = `${owner}: ${summarizeNoteForState(unit)}`;
      if (!sections[key].some((item) => normalizeComparableText(item) === normalizeComparableText(line))) {
        sections[key].push(line);
      }
    });
  });
  return sections;
}

function classifyStage(text: string): StageKey {
  const normalized = text.toLowerCase();
  if (/\b(done|completed|finished|shipped|resolved|previous|last week|yesterday|already)\b/.test(normalized)) return "previous";
  if (/\b(question|unclear|unknown|risk|blocker|blocked|gap|decision|decide|depends|waiting)\b/.test(normalized)) return "questions";
  if (/\b(current|status|in progress|working|draft|now)\b/.test(normalized)) return "current";
  if (/\b(next|todo|task|action|follow(?:-?up)?|ask|schedule|meet|talk|call|sync|send|email|ping|confirm|review|assign|due|today|tomorrow|this week|next week)\b/.test(normalized)) return "next";
  return "current";
}

function stageTitle(key: StageKey): string {
  if (key === "previous") return "Past";
  if (key === "current") return "Now";
  if (key === "next") return "Future";
  return "Open questions";
}

function buildContributorLine(notes: CanvasSnapshot["notes"]): string {
  const summaryOwners = notes
    .filter((note) => getBoardNoteKind(note.text) === "summary")
    .map(getStateOwner)
    .filter(Boolean);
  if (summaryOwners.length > 0) return `Sources: ${[...new Set(summaryOwners)].join(", ")}`;

  return groupNotesByAuthor(notes)
    .map((group) => {
      const timeRange = formatNoteTimeRange(group.notes);
      return `${group.author} ${pluralize(group.notes.length, "note")}${timeRange ? ` (${timeRange})` : ""}`;
    })
    .join(" · ");
}

function summarizeNoteForState(text: string): string {
  const cleaned = text.trim().replace(/\s+/g, " ");
  const action = extractActionSentences(cleaned)[0];
  return compressStateSummary(action || cleaned);
}

function splitStateUnits(text: string): string[] {
  const units = text
    .split(/(?<=[.!?])\s+|\r?\n+/)
    .map((unit) => unit.trim())
    .filter(Boolean);
  return units.length > 0 ? units : [text.trim()].filter(Boolean);
}

function compressStateSummary(text: string): string {
  const cleaned = text
    .replace(/^[-*•]\s*/, "")
    .replace(/^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+\d{1,2}:\s*/i, "")
    .trim();
  const normalized = cleaned.toLowerCase();

  if (normalized.includes("evaluate whether fluid v2") || normalized.includes("sharedtree is the right long-term")) {
    return "Evaluate Fluid v2 / SharedTree for collaborative canvas + AI workflows.";
  }
  if (normalized.includes("use five evidence streams")) {
    return "Use five evidence streams: prototype, comparison, product map, source reading, and stakeholder conversations.";
  }
  if (normalized.includes("act 1 and act 2 are complete")) {
    return "Act 1 and Act 2 are complete: realtime canvas plus human-reviewed AI proposals.";
  }
  if (normalized.includes("sharepoint viability has two hard gates")) {
    return "SharePoint viability depends on multi-client save orchestration and indexing/search/eDiscovery.";
  }
  if (normalized.includes("sharepoint track is probably more valuable")) {
    return "Prioritize SharePoint readiness while continuing Act 2 demo polish.";
  }
  if (normalized.includes("project direction is aligned")) {
    return "Frame Act 2 as governed human-in-the-loop AI collaboration.";
  }
  if (normalized.includes("ai proposals may need to stay private")) {
    return "Keep AI proposals private or transient until a human approves them.";
  }
  if (normalized.includes("sharedtree is not just trying to be a crdt")) {
    return "SharedTree value: service-ordered ops, transactions, branch/rebase, checkpoints, and undo semantics.";
  }
  if (normalized.includes("crdts can be easier to build from scratch")) {
    return "CRDTs are simpler to start, but Fluid is closer to Microsoft production needs.";
  }
  if (normalized.includes("sharepoint file round-trip only proves storage")) {
    return "A SharePoint file round-trip proves storage, not collaboration readiness.";
  }
  if (normalized.includes("external client-side value justifies owning")) {
    return "Decide whether external client-side value justifies a new collaboration service plus ODSP/M365 integration.";
  }
  if (normalized.includes("localhost demo") && normalized.includes("server-side orchestration")) {
    return "Use localhost AI flow for the demo; production agents need server orchestration and auth.";
  }

  if (cleaned.length <= 118) return cleaned;
  const words = cleaned.split(" ");
  const compact = words.slice(0, 18).join(" ").replace(/[,:;]$/, "");
  return /[.!?]$/.test(compact) ? compact : `${compact}.`;
}

function getStateUnits(text: string): string[] {
  if (getBoardNoteKind(text) === "state") return [];
  if (getBoardNoteKind(text) === "summary") {
    const lines = text.replace(/\r/g, "").split("\n").map((line) => line.trim()).filter(Boolean);
    return lines
      .slice(2)
      .map((line) => line.replace(/^[-*•]\s*/, "").trim())
      .filter(Boolean);
  }
  return splitStateUnits(getContributorNoteBody(text));
}

function getStateOwner(note: CanvasSnapshot["notes"][number]): string {
  const firstLine = note.text.trim().split(/\r?\n/)[0] ?? "";
  const summaryMatch = firstLine.match(/^(.+?)\s+summary$/i);
  if (summaryMatch?.[1]) return summaryMatch[1].trim();
  const datedMatch = firstLine.match(/^([A-Za-z][A-Za-z ]{1,32})\s+-\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\b/i);
  if (datedMatch?.[1]) return datedMatch[1].trim();
  const projectMatch = firstLine.match(/^([A-Za-z][A-Za-z ]{1,32})\s+-\s+(?:Project|Plan|Progress)\b/i);
  if (projectMatch?.[1]) return projectMatch[1];
  return note.author || "Unknown";
}

function getBoardNoteKind(text: string): "state" | "summary" | "other" {
  const firstLine = text.trim().split(/\r?\n/)[0]?.toLowerCase() ?? "";
  if (firstLine === "shared state") return "state";
  if (/\bsummary$/.test(firstLine)) return "summary";
  return "other";
}

function formatShortDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  const datePart = `${date.getMonth() + 1}/${date.getDate()}`;
  const timePart = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${datePart} ${timePart}`;
}

function formatCompactTimeRange(startTimestamp: number, endTimestamp: number): string {
  const start = new Date(startTimestamp);
  const end = new Date(endTimestamp);
  const sameDay =
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth() &&
    start.getDate() === end.getDate();
  const datePart = `${start.getMonth() + 1}/${start.getDate()}`;
  const startTime = formatTimeOnly(start);
  const endTime = formatTimeOnly(end);
  if (!sameDay) return `${formatShortDateTime(startTimestamp)} to ${formatShortDateTime(endTimestamp)}`;
  if (startTime === endTime) return `${datePart}, ${startTime}`;
  return `${datePart}, ${compressSameDayTimeRange(startTime, endTime)}`;
}

function formatTimeOnly(date: Date): string {
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function compressSameDayTimeRange(startTime: string, endTime: string): string {
  const startMatch = startTime.match(/^(.+)\s(AM|PM)$/i);
  const endMatch = endTime.match(/^(.+)\s(AM|PM)$/i);
  if (startMatch?.[2] && endMatch?.[2] && startMatch[2].toLowerCase() === endMatch[2].toLowerCase()) {
    return `${startMatch[1]}-${endTime}`;
  }
  return `${startTime}-${endTime}`;
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function buildTaskHandoffEdits(
  notes: CanvasSnapshot["notes"],
  groundingSources: GroundingSource[],
  existingTasks: CanvasSnapshot["tasks"] = [],
  feedback?: ProposalFeedback[],
): AiProposalEdit[] {
  const limit = Math.min(getFeedbackLimit(feedback), 5);
  const existingTaskTitles = new Set(existingTasks.map((task) => normalizeComparableText(task.title)));
  const focusTokens = getFeedbackFocusTokens(feedback);
  const candidates = focusNotesByFeedback(notes, feedback)
    .flatMap((note, noteIndex) => {
      const actions = extractActionSentences(note.text);
      const actionTexts = actions.length > 0 ? actions : [note.text];
      return actionTexts.map((actionText, actionIndex) => ({
        note,
        actionText,
        score: scoreTaskCandidate(actionText) + scoreFeedbackMatch(actionText, focusTokens) - noteIndex * 0.01 - actionIndex * 0.001,
      }));
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score);
  const seenTaskTitles = new Set<string>();
  const edits: AiProposalEdit[] = candidates
    .filter(({ actionText }) => {
      const comparableTitle = normalizeComparableText(buildTaskTitle(actionText));
      if (existingTaskTitles.has(comparableTitle) || seenTaskTitles.has(comparableTitle)) return false;
      seenTaskTitles.add(comparableTitle);
      return true;
    })
    .slice(0, limit)
    .map(({ note, actionText }) => {
      const timing = extractTimePhrase(actionText) ?? extractTimePhrase(note.text) ?? undefined;
      const edit: Extract<AiProposalEdit, { type: "addTask" }> = {
        type: "addTask",
        title: buildTaskTitle(actionText),
        sourceNoteIds: [note.id],
        sourceGroundingIds: groundingSources.map((source) => source.id).slice(0, 3),
        sourceAuthors: [note.author],
        sourceCreatedAt: typeof note.createdAt === "number" ? [note.createdAt] : undefined,
        rationale: `Turns ${note.author}'s loose action into a checkable shared task with source trace.`,
      };
      if (timing) edit.timing = timing.toLowerCase();
      return edit;
    });

  if (edits.length === 0 && groundingSources.length > 0) {
    edits.push({
      type: "addTask",
      title: buildTaskTitle(groundingSources[0].text || groundingSources[0].title),
      sourceGroundingIds: [groundingSources[0].id],
      rationale: "Creates a structured task from the private enterprise grounding source.",
    });
  }

  return edits.length > 0
    ? edits
    : [{
      type: "addTask",
      title: "Confirm the next owner and decision",
      rationale: "Adds one review task because no concrete action note was available.",
    }];
}

function scoreFeedbackMatch(text: string, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const comparable = normalizeComparableText(text);
  return tokens.reduce((score, token) => score + (comparable.includes(token) ? 35 : 0), 0);
}

function enrichTaskEdit(
  edit: Extract<AiProposalEdit, { type: "addTask" }>,
  request: AiProposalRequest,
): Extract<AiProposalEdit, { type: "addTask" }> {
  const sourceNotes = (edit.sourceNoteIds ?? [])
    .map((id) => request.document.notes.find((note) => note.id === id))
    .filter((note): note is CanvasSnapshot["notes"][number] => Boolean(note));
  const sourceAuthors = edit.sourceAuthors?.length
    ? edit.sourceAuthors
    : [...new Set(sourceNotes.map((note) => note.author).filter(Boolean))];
  const sourceCreatedAt = edit.sourceCreatedAt?.length
    ? edit.sourceCreatedAt
    : sourceNotes
      .map((note) => note.createdAt)
      .filter((time): time is number => typeof time === "number" && Number.isFinite(time));
  const timing = edit.timing ?? extractTimePhrase(edit.title) ?? sourceNotes.map((note) => extractTimePhrase(note.text)).find(Boolean) ?? undefined;

  return {
    ...edit,
    timing: timing?.toLowerCase(),
    sourceAuthors: sourceAuthors.length > 0 ? sourceAuthors : undefined,
    sourceCreatedAt: sourceCreatedAt.length > 0 ? sourceCreatedAt : undefined,
    rationale: edit.rationale ?? "Creates a checkable task while preserving who suggested it and when it entered the board.",
  };
}

function buildTaskTitle(text: string): string {
  const cleaned = text
    .replace(/\[[ x]\]/gi, "")
    .replace(/^(next action|action|task|todo|follow-up|follow up|goal|risk):\s*/i, "")
    .trim()
    .replace(/\s+/g, " ");
  const firstLine = cleaned.split(/[.!?\n]/)[0]?.trim() || cleaned;
  const actionTitle = rewriteTaskTitle(firstLine);
  return actionTitle.length > 120 ? `${actionTitle.slice(0, 117)}...` : actionTitle || "Confirm next step";
}

function rewriteTaskTitle(text: string): string {
  const cleaned = text.trim().replace(/\s+/g, " ");
  const timePhrase = extractTimePhrase(cleaned);
  const withoutTime = removeTimePhrase(cleaned);
  const target = withoutTime.replace(/[.,;:]+$/g, "").trim();

  const meetMatch = target.match(/^meet(?:\s+with)?\s+(.+)$/i);
  if (meetMatch?.[1]) return withTime(`Meet with ${capitalizeTaskTarget(meetMatch[1])}`, timePhrase);

  const talkMatch = target.match(/^talk(?:\s+with| to)?\s+(.+)$/i);
  if (talkMatch?.[1]) return withTime(`Talk with ${capitalizeTaskTarget(talkMatch[1])}`, timePhrase);

  const callMatch = target.match(/^call\s+(.+)$/i);
  if (callMatch?.[1]) return withTime(`Call ${capitalizeTaskTarget(callMatch[1])}`, timePhrase);

  const syncMatch = target.match(/^sync(?:\s+with)?\s+(.+)$/i);
  if (syncMatch?.[1]) return withTime(`Sync with ${capitalizeTaskTarget(syncMatch[1])}`, timePhrase);

  const sendMatch = target.match(/^send\s+(.+)$/i);
  if (sendMatch?.[1]) return withTime(`Send ${sendMatch[1]}`, timePhrase);

  const reviewMatch = target.match(/^review\s+(.+)$/i);
  if (reviewMatch?.[1]) return withTime(`Review ${reviewMatch[1]}`, timePhrase);

  const confirmMatch = target.match(/^confirm\s+(.+)$/i);
  if (confirmMatch?.[1]) return withTime(`Confirm ${confirmMatch[1]}`, timePhrase);

  if (/\b(risk|blocker|blocked|issue|problem|decision|decide)\b/i.test(cleaned)) {
    return withTime(`Resolve: ${truncateForNote(cleaned, 96)}`, timePhrase);
  }

  return withTime(`Clarify next step: ${truncateForNote(cleaned, 92)}`, timePhrase);
}

function extractTimePhrase(text: string): string | null {
  const match = text.match(/\b(today|tomorrow|now|asap|this week|next week|due [a-z0-9 /-]+|by [a-z0-9 /-]+)\b/i);
  return match?.[0] ?? null;
}

function removeTimePhrase(text: string): string {
  return text
    .replace(/\b(today|tomorrow|now|asap|this week|next week)\b/gi, "")
    .replace(/\b(due|by)\s+[a-z0-9 /-]+$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function withTime(title: string, timePhrase: string | null): string {
  return timePhrase ? `${title} (${timePhrase.toLowerCase()})` : title;
}

function capitalizeTaskTarget(value: string): string {
  const cleaned = value.trim().replace(/\s+/g, " ");
  return cleaned.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function scoreTaskCandidate(text: string): number {
  const normalized = text.toLowerCase();
  let score = 0;

  if (/\b(today|now|asap|urgent|immediate|immediately|deadline|due|overdue)\b/.test(normalized)) score += 80;
  if (/\b(tomorrow|soon|next)\b/.test(normalized)) score += 45;
  if (/\b(meet|meeting|talk|call|sync|schedule|send|email|ping|follow(?:-?up)?|confirm|review|ask|assign|owner)\b/.test(normalized)) score += 40;
  if (/\b(todo|task|action|next step|follow-up|follow up)\b/.test(normalized)) score += 35;
  if (/\b(risk|blocker|blocked|decision|decide|issue|problem)\b/.test(normalized)) score += 15;
  if (/\b(context|background|summary|note|idea)\b/.test(normalized) && score === 0) score -= 20;

  return score;
}

function normalizeComparableText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function getActiveLaneKeys(notes: CanvasSnapshot["notes"]): Set<LaneKey> {
  return new Set(notes.map((note) => classifyNoteForLane(note.text)));
}

function classifyNoteForLane(text: string): LaneKey {
  const normalized = text.toLowerCase();
  if (/\b(risk|blocker|blocked|auth|permission|unclear|unknown|issue|problem|gap|depend|decision|decide)\b/.test(normalized)) {
    return "risks";
  }
  if (
    /\b(next|todo|task|action|follow(?:-?up)?|ask|schedule|owner|meeting|meet|talk|call|sync|implement|ship|build|send|email|ping|confirm|review|assign|due|today|tomorrow)\b/.test(
      normalized,
    )
  ) {
    return "next";
  }
  return "context";
}

function isLaneKey(value: unknown): value is LaneKey {
  return value === "context" || value === "risks" || value === "next";
}

function stripCodeFence(value: string): string {
  if (!value.startsWith("```")) return value;
  return value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function coerceText(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim().slice(0, 2000) : fallback;
}

function coerceOptionalText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim();
  return cleaned ? cleaned.slice(0, maxLength) : undefined;
}

function coerceIdArray(value: unknown, allowedIds: Set<string>): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value
    .map((item) => coerceText(item, ""))
    .filter((id) => id && allowedIds.has(id));
  return ids.length > 0 ? [...new Set(ids)].slice(0, 8) : undefined;
}

function coerceStringArray(value: unknown, maxItems: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value
    .map((item) => coerceText(item, ""))
    .filter(Boolean)
    .slice(0, maxItems);
  return values.length > 0 ? [...new Set(values)] : undefined;
}

function coerceNumberArray(value: unknown, maxItems: number): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value
    .filter((item): item is number => typeof item === "number" && Number.isFinite(item))
    .slice(0, maxItems);
  return values.length > 0 ? values : undefined;
}

function coerceNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function coerceNoteColor(value: unknown): StickyNote["color"] | undefined {
  if (
    value === "yellow" ||
    value === "blue" ||
    value === "green" ||
    value === "pink" ||
    value === "purple" ||
    value === "orange"
  ) {
    return value;
  }
  return undefined;
}

function coerceShapeType(value: unknown): ShapeType | null {
  if (value === "circle" || value === "square" || value === "triangle" || value === "star") {
    return value;
  }
  return null;
}

function truncateError(value: string): string {
  const cleaned = value.trim().replace(/\s+/g, " ");
  return cleaned.length > 180 ? `${cleaned.slice(0, 177)}...` : cleaned;
}


function extractActionSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) =>
      /\b(today|tomorrow|now|asap|due|meet|talk|call|sync|schedule|send|email|ping|follow(?:-?up)?|confirm|review|ask|assign|owner|decision|decide)\b/i.test(sentence),
    );
}

function truncateForNote(value: string, maxLength: number): string {
  const cleaned = value.trim().replace(/\s+/g, " ");
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 3)}...` : cleaned;
}
