import { useState, useRef, useCallback, useMemo, useLayoutEffect } from "react";
import type { StickyNote, Shape, InkStroke, CanvasDoc, CanvasHighlight, CanvasTask } from "./schema";
import type { AiProposalEdit } from "./ai";
import type { UserPresence, CaretPresence } from "./usePresence";
import { LiveTextarea } from "./LiveTextarea";
import { RemoteCarets } from "./RemoteCarets";
import { getCaretCoords } from "./textareaCaret";
import { uuid } from "./uuid";

type DraggedItem = { kind: "note" | "shape"; id: string; baseX: number; baseY: number };
type DragState = {
  kind: "note" | "shape";
  id: string;
  startX: number;
  startY: number;
  items: DraggedItem[];
  lastPositions: DragPreviewPosition[];
  lastSyncAt: number;
  lastSyncSignature: string;
};
type DragPreviewPosition = { kind: "note" | "shape"; id: string; x: number; y: number };
type SelectionRect = { x: number; y: number; width: number; height: number };
type NoteHighlightView = Pick<CanvasHighlight, "id" | "noteId" | "text" | "color" | "author" | "createdAt" | "rationale"> & {
  preview?: boolean;
};
interface NoteHighlightSegment {
  id: string;
  text: string;
  top: number;
  left: number;
  width: number;
  color: string;
  preview?: boolean;
}

interface CanvasViewProps {
  doc: CanvasDoc;
  userName: string;
  onAddNote: (x: number, y: number) => void;
  onUpdateNote: (id: string, patch: Partial<StickyNote>) => void;
  onDeleteNote: (id: string) => void;
  onSetNoteText: (id: string, newText: string) => void;
  onDeleteShape: (id: string) => void;
  onMoveItem: (kind: "note" | "shape", id: string, x: number, y: number) => void;
  onCursorMove: (x: number, y: number) => void;
  onAddStroke: (stroke: InkStroke) => void;
  onDeleteStroke: (id: string) => void;
  onToggleTask: (id: string) => void;
  onCaretChange: (caret: CaretPresence | null) => void;
  selectedNoteIds: string[];
  selectedStrokeIds: string[];
  onSelectNotes: (ids: string[]) => void;
  onSelectStrokes: (ids: string[]) => void;
  aiPreviewEdits?: AiProposalEdit[] | null;
  liveConflictNoteId?: string | null;
  areaSelectMode: boolean;
  inkMode: boolean;
  inkColor: string;
  inkWidth: number;
  deleteMode: boolean;
  otherUsers: UserPresence[];
}

const NOTE_COLORS: Record<string, string> = {
  yellow: "var(--note-yellow)",
  blue: "var(--note-blue)",
  green: "var(--note-green)",
  pink: "var(--note-pink)",
  purple: "var(--note-purple)",
  orange: "var(--note-orange)",
};

const NOTE_WIDTH = 300;
const NOTE_MIN_HEIGHT = 180;
const NOTE_BODY_MIN_HEIGHT = 120;
const STROKE_DELETE_HIT_WIDTH = 22;
const DRAG_SYNC_INTERVAL_MS = 50;
const PREVIEW_NOTE_COLLAPSED_HEIGHT = 132;
const PREVIEW_NOTE_EXPANDED_HEIGHT = 430;
const NOTE_COLLAPSED_BODY_MAX_HEIGHT = 152;
const INLINE_AI_PREVIEW_COLLAPSED_HEIGHT = 96;
const PREVIEW_NOTE_COLLAPSED_LINES = 3;
const SUMMARY_PREVIEW_NOTE_COLLAPSED_LINES = 5;

// Split a preview text into (unchangedPrefix, changedSpan, unchangedSuffix)
// so the canvas preview can visually mark only the substring that was
// touched. When we have the literal `replace` string (i.e., the edit was
// a `replaceSpan`), we slice on that exact substring — this is precise
// and matches what the user will accept. When we do not have the hint
// (e.g., a full `updateNoteText` rewrite) we fall back to a longest
// common prefix + longest common suffix diff against the original text,
// which collapses to "everything is changed" if there is no overlap.
function splitPreviewIntoDiff(
  original: string,
  preview: string,
  replaceHint?: string,
): { prefix: string; changed: string; suffix: string } {
  if (replaceHint && replaceHint.length > 0) {
    const idx = preview.indexOf(replaceHint);
    if (idx >= 0) {
      return {
        prefix: preview.slice(0, idx),
        changed: preview.slice(idx, idx + replaceHint.length),
        suffix: preview.slice(idx + replaceHint.length),
      };
    }
  }
  if (!original) return { prefix: "", changed: preview, suffix: "" };
  let prefixEnd = 0;
  const minLen = Math.min(original.length, preview.length);
  while (prefixEnd < minLen && original[prefixEnd] === preview[prefixEnd]) {
    prefixEnd++;
  }
  let originalSuffixStart = original.length;
  let previewSuffixStart = preview.length;
  while (
    originalSuffixStart > prefixEnd &&
    previewSuffixStart > prefixEnd &&
    original[originalSuffixStart - 1] === preview[previewSuffixStart - 1]
  ) {
    originalSuffixStart--;
    previewSuffixStart--;
  }
  return {
    prefix: preview.slice(0, prefixEnd),
    changed: preview.slice(prefixEnd, previewSuffixStart),
    suffix: preview.slice(previewSuffixStart),
  };
}

// Expand the AI's `find` substring to the boundaries of the sentence that
// contains it, so the original-side highlight covers the entire sentence
// being rewritten (not just the fragment the AI matched against). Walks
// backward to the previous sentence-terminating punctuation or newline
// (or start of text), trims leading whitespace, then walks forward through
// the trailing punctuation. Falls back to the original `find` if it
// isn't present in the note text.
function expandToSentence(noteText: string, find: string): string {
  const idx = noteText.indexOf(find);
  if (idx < 0) return find;
  const TERMINATORS = /[.!?\n\r]/;
  let start = idx;
  while (start > 0 && !TERMINATORS.test(noteText[start - 1])) start--;
  while (start < idx && /\s/.test(noteText[start])) start++;
  let end = idx + find.length;
  while (end < noteText.length && !TERMINATORS.test(noteText[end - 1])) end++;
  while (end < noteText.length && /[.!?)\]"'\u201d]/.test(noteText[end])) end++;
  return noteText.slice(start, end);
}

function ShapeIcon({ type, color, size }: { type: string; color: string; size: number }) {
  const s = size;
  if (type === "circle") return <circle cx={s/2} cy={s/2} r={s/2-2} fill={color} />;
  if (type === "square") return <rect x={2} y={2} width={s-4} height={s-4} fill={color} rx={4} />;
  if (type === "triangle") return <polygon points={`${s/2},2 ${s-2},${s-2} 2,${s-2}`} fill={color} />;
  const pts = Array.from({length:10},(_,i)=>{
    const a=(i*Math.PI)/5-Math.PI/2; const r=i%2===0?s/2-2:s/4;
    return `${s/2+r*Math.cos(a)},${s/2+r*Math.sin(a)}`;
  }).join(" ");
  return <polygon points={pts} fill={color} />;
}

function pointsToPolyline(pts: number[]): string {
  const pairs: string[] = [];
  for (let i = 0; i + 1 < pts.length; i += 2) {
    pairs.push(`${pts[i]},${pts[i + 1]}`);
  }
  return pairs.join(" ");
}

function strokeDeleteHitWidth(width: number): number {
  return Math.max(width + STROKE_DELETE_HIT_WIDTH, STROKE_DELETE_HIT_WIDTH);
}

function dragPreviewKey(kind: "note" | "shape", id: string): string {
  return `${kind}:${id}`;
}

function dragPositionSignature(positions: DragPreviewPosition[]): string {
  return positions
    .map((position) => `${position.kind}:${position.id}:${Math.round(position.x)}:${Math.round(position.y)}`)
    .join("|");
}

function isCanvasClearTarget(target: EventTarget | null, canvas: HTMLDivElement | null): boolean {
  if (!target || !canvas) return false;
  if (target === canvas) return true;
  return target instanceof SVGSVGElement && target.dataset.canvasLayer === "ink";
}

function rectFromPoints(startX: number, startY: number, currentX: number, currentY: number): SelectionRect {
  return {
    x: Math.min(startX, currentX),
    y: Math.min(startY, currentY),
    width: Math.abs(currentX - startX),
    height: Math.abs(currentY - startY),
  };
}

function rectIntersects(a: SelectionRect, b: SelectionRect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function shapeIsInsideNote(shape: Shape, note: StickyNote): boolean {
  const centerX = shape.x + shape.size / 2;
  const centerY = shape.y + shape.size / 2;
  const noteHeight = estimateNoteHeight(note.text);
  return (
    centerX >= note.x &&
    centerX <= note.x + NOTE_WIDTH &&
    centerY >= note.y &&
    centerY <= note.y + noteHeight
  );
}

function estimateWrappedLineCount(text: string, charsPerLine: number): number {
  const lines = text.replace(/\r/g, "").split("\n");
  return lines.reduce((total, line) => {
    const trimmed = line.trim();
    return total + Math.max(1, Math.ceil(trimmed.length / charsPerLine));
  }, 0);
}

function estimateNoteHeight(text: string): number {
  const isBoardHeader = Boolean(getBoardHeaderLabel(text));
  const base = isBoardHeader ? 76 : 86;
  const lineHeight = isBoardHeader ? 20 : 22;
  const wrappedLines = estimateWrappedLineCount(text, isBoardHeader ? 35 : 34);
  return Math.min(Math.max(isBoardHeader ? 126 : NOTE_MIN_HEIGHT, base + wrappedLines * lineHeight), isBoardHeader ? 920 : 720);
}

function estimatePreviewNoteHeight(text: string): number {
  if (!shouldShowPreviewExpand(text, isContributorSummary(text) || isSemanticMergePreview(text))) return PREVIEW_NOTE_COLLAPSED_HEIGHT;
  return PREVIEW_NOTE_EXPANDED_HEIGHT;
}

function shouldShowPreviewExpand(text: string, isSummaryPreview: boolean): boolean {
  const clampLines = isSummaryPreview ? 5 : 3;
  const lineCount = text.replace(/\r/g, "").split("\n").length;
  const wrappedLineCount = estimateWrappedLineCount(text, isSummaryPreview ? 35 : 34);
  return text.length > (isSummaryPreview ? 140 : 96) || lineCount > clampLines || wrappedLineCount > clampLines;
}

function measureUnclampedTextHeight(element: HTMLElement): number {
  const parent = element.parentElement;
  if (!parent) return element.scrollHeight;

  const clone = element.cloneNode(true) as HTMLElement;
  const width = element.getBoundingClientRect().width;
  clone.style.position = "absolute";
  clone.style.visibility = "hidden";
  clone.style.pointerEvents = "none";
  clone.style.left = "-10000px";
  clone.style.top = "0";
  clone.style.width = `${width}px`;
  clone.style.height = "auto";
  clone.style.maxHeight = "none";
  clone.style.overflow = "visible";
  clone.style.display = "block";
  clone.style.setProperty("-webkit-line-clamp", "unset");
  clone.style.setProperty("-webkit-box-orient", "initial");

  parent.appendChild(clone);
  const height = clone.scrollHeight;
  clone.remove();
  return height;
}

function normalizeHighlightMatch(text: string): string {
  return text.toLowerCase().replace(/(?:\.\.\.|…)$/, "").replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
}

function findHighlightRange(text: string, highlightText: string): { start: number; end: number } | null {
  const probe = cleanHighlightProbe(highlightText);
  if (!probe) return null;

  const directIndex = text.toLowerCase().indexOf(probe.toLowerCase());
  if (directIndex >= 0) return { start: directIndex, end: directIndex + probe.length };

  const comparableProbe = normalizeHighlightMatch(probe);
  if (!comparableProbe) return null;
  const fallbackProbe = comparableProbe.length > 36 ? comparableProbe.slice(0, 36) : comparableProbe;
  let offset = 0;

  for (const rawLine of text.replace(/\r/g, "").split("\n")) {
    const lineStart = offset;
    const lineEnd = offset + rawLine.length;
    const comparableLine = normalizeHighlightMatch(rawLine);
    if (comparableLine.includes(comparableProbe) || comparableLine.includes(fallbackProbe)) {
      return { start: lineStart, end: Math.max(lineStart + 1, lineEnd) };
    }
    offset = lineEnd + 1;
  }

  return null;
}

function cleanHighlightProbe(highlightText: string): string {
  return highlightText
    .replace(/^[-*•]\s*/, "")
    .replace(/^\[[ x]\]\s*/i, "")
    .replace(/(?:\.\.\.|…)$/, "")
    .trim();
}

function buildHighlightSegments(
  textarea: HTMLTextAreaElement | null,
  text: string,
  highlights: NoteHighlightView[],
): NoteHighlightSegment[] {
  if (!textarea || highlights.length === 0) return [];
  const contentWidth = Math.max(48, textarea.clientWidth - 4);
  const segments: NoteHighlightSegment[] = [];
  const seen = new Set<string>();

  highlights.forEach((highlight) => {
    const range = findHighlightRange(text, highlight.text);
    if (!range) return;

    const start = getCaretCoords(textarea, range.start);
    const end = getCaretCoords(textarea, range.end);
    const lineHeight = Math.max(16, start.height || end.height || Number.parseFloat(getComputedStyle(textarea).lineHeight) || 22);
    const firstLine = Math.round(start.top / lineHeight);
    const lastLine = Math.max(firstLine, Math.round(end.top / lineHeight));

    for (let line = firstLine; line <= lastLine; line += 1) {
      const isFirst = line === firstLine;
      const isLast = line === lastLine;
      const left = clamp(isFirst ? start.left : 0, 0, contentWidth - 24);
      const rawRight = isLast ? end.left : contentWidth;
      const right = clamp(rawRight <= left + 8 ? contentWidth : rawRight, left + 24, contentWidth);
      const key = `${highlight.id}-${line}-${Math.round(left)}-${Math.round(right)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      segments.push({
        id: key,
        text: highlight.text,
        // Sit the underline one pixel BELOW the bottom of the line box so it
        // never crosses descenders (g, p, y) on the highlighted line and
        // never collides with the line of text below. The +1 puts it cleanly
        // in the line-gap area while still reading as "belongs to this line."
        top: Math.max(0, line * lineHeight + lineHeight + 1),
        left,
        width: right - left,
        color: highlight.color,
        preview: highlight.preview,
      });
    }
  });

  return segments;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function sameHighlightSegments(left: NoteHighlightSegment[], right: NoteHighlightSegment[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (
      a.id !== b.id ||
      a.text !== b.text ||
      Math.round(a.top) !== Math.round(b.top) ||
      Math.round(a.left) !== Math.round(b.left) ||
      Math.round(a.width) !== Math.round(b.width) ||
      a.color !== b.color ||
      a.preview !== b.preview
    ) {
      return false;
    }
  }
  return true;
}

function NoteInlineHighlights({
  text,
  highlights,
  textareaRef,
  aiFindHighlight,
}: {
  text: string;
  highlights: NoteHighlightView[];
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  /**
   * When the live AI proposal is a `replaceSpan` against this note, the
   * substring that will be removed (`find`) is rendered as a tinted
   * overlay on top of the original textarea so the user can see at a
   * glance "this is the only sentence the AI is touching".
   */
  aiFindHighlight?: { text: string } | undefined;
}) {
  const [segments, setSegments] = useState<NoteHighlightSegment[]>([]);
  const [aiFindSegments, setAiFindSegments] = useState<NoteHighlightSegment[]>([]);

  const aiFindAsHighlights = useMemo<NoteHighlightView[]>(() => {
    if (!aiFindHighlight || !aiFindHighlight.text) return [];
    return [{
      id: "__ai-find__",
      noteId: "__ai-find__",
      text: aiFindHighlight.text,
      color: "var(--color-ai)",
      author: "AI",
      createdAt: 0,
      rationale: "AI target span",
      preview: true,
    }];
  }, [aiFindHighlight]);

  useLayoutEffect(() => {
    const updateSegments = () => {
      const nextSegments = buildHighlightSegments(textareaRef.current, text, highlights);
      setSegments((current) => sameHighlightSegments(current, nextSegments) ? current : nextSegments);
      const nextAiFind = buildHighlightSegments(textareaRef.current, text, aiFindAsHighlights);
      setAiFindSegments((current) => sameHighlightSegments(current, nextAiFind) ? current : nextAiFind);
    };

    updateSegments();
    const textarea = textareaRef.current;
    const resizeObserver = textarea && typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(updateSegments)
      : null;
    if (textarea && resizeObserver) resizeObserver.observe(textarea);
    window.addEventListener("resize", updateSegments);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updateSegments);
    };
  }, [highlights, text, textareaRef, aiFindAsHighlights]);

  if (highlights.length === 0 && aiFindSegments.length === 0) return null;
  if (segments.length === 0 && aiFindSegments.length === 0) return null;

  return (
    <div className="note-inline-highlight-layer" aria-hidden="true" data-priority-highlight-layer="true">
      {aiFindSegments.map((segment) => (
        <span
          key={`ai-find-${segment.id}`}
          className="note-inline-highlight note-inline-highlight--ai-find"
          data-ai-find-segment="true"
          data-priority-highlight-text={segment.text}
          style={{
            top: segment.top,
            left: segment.left,
            width: segment.width,
          }}
        />
      ))}
      {segments.map((segment) => (
        <span
          key={segment.id}
          className={segment.preview ? "note-inline-highlight note-inline-highlight--preview" : "note-inline-highlight"}
          data-priority-highlight-preview={segment.preview ? "true" : "false"}
          data-priority-highlight-text={segment.text}
          style={{
            top: segment.top,
            left: segment.left,
            width: segment.width,
            borderBottomColor: segment.color,
          }}
        />
      ))}
    </div>
  );
}

function selectedNoteLabel(boardHeaderLabel: string | null): string {
  if (boardHeaderLabel === "Contributor map") return "Selected map";
  if (boardHeaderLabel === "Map summary") return "Selected map summary";
  if (boardHeaderLabel === "State brief") return "Selected brief";
  if (boardHeaderLabel === "Semantic merge") return "Selected merge";
  if (boardHeaderLabel) return `Selected ${boardHeaderLabel.toLowerCase()}`;
  return "Selected note";
}

function formatNoteDate(timestamp?: number): string | null {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return null;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(timestamp));
}

function textStartsWithAuthorDate(note: StickyNote): boolean {
  const firstLine = note.text.trim().split("\n")[0] ?? "";
  if (!note.author) return false;
  return new RegExp(`^${escapeRegExp(note.author)}\\s+-\\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\s+\\d{1,2}\\b`, "i").test(firstLine);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface StickyNoteViewProps {
  note: StickyNote;
  inkMode: boolean;
  deleteMode: boolean;
  onSetText: (next: string) => void;
  onDelete: () => void;
  onStartDrag: (e: React.MouseEvent) => void;
  onClickToDelete: (e: React.MouseEvent) => void;
  onCaretChange: (offset: number | null) => void;
  selected: boolean;
  areaSelectMode: boolean;
  onSelect: (event: React.MouseEvent) => void;
  aiPreviewText?: string;
  aiPreviewChange?: { rewrite: boolean; move: boolean; merge: boolean; replace: boolean };
  /**
   * When the live AI proposal is a `replaceSpan` against this note we plumb
   * through both the original substring (`find`) and the new substring
   * (`replace`) so the original text can highlight "what is being touched"
   * and the preview can highlight "what it becomes".
   */
  aiPreviewSpan?: { find: string; replace: string };
  mappedSource?: boolean;
  liveConflict?: boolean;
  highlights: NoteHighlightView[];
  remoteCarets: { userName: string; color: string; offset: number }[];
  previewPosition?: { x: number; y: number };
  /**
   * Other participants who currently have this note selected. Drives a
   * colored outline ring + tiny user chip so everyone can see "who is
   * looking at this note right now" without anyone having to type yet.
   */
  remoteSelections?: { userName: string; color: string }[];
}

// One sticky note. Owns its own textarea ref so RemoteCarets can position
// caret bars precisely against the right note instance.
function StickyNoteView({
  note, inkMode, deleteMode, onSetText, onDelete, onStartDrag, onClickToDelete,
  onCaretChange, selected, areaSelectMode, onSelect, aiPreviewText, aiPreviewChange, aiPreviewSpan, mappedSource, liveConflict, highlights, remoteCarets, previewPosition, remoteSelections,
}: StickyNoteViewProps) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const boardHeaderLabel = getBoardHeaderLabel(note.text);
  const isBoardHeader = Boolean(boardHeaderLabel);
  const contributorMapNote = isContributorMapNote(note.text);
  const shouldAutoExpand =
    boardHeaderLabel === "State brief" ||
    boardHeaderLabel === "Contributor map" ||
    boardHeaderLabel === "Map summary" ||
    boardHeaderLabel === "Semantic merge" ||
    highlights.length > 0;
  const [userExpanded, setUserExpanded] = useState(false);
  const [userCollapsed, setUserCollapsed] = useState(false);
  const [measuredNeedsExpand, setMeasuredNeedsExpand] = useState(false);
  const [aiPreviewExpanded, setAiPreviewExpanded] = useState(false);
  const [aiPreviewNeedsExpand, setAiPreviewNeedsExpand] = useState(false);
  const aiPreviewTextRef = useRef<HTMLParagraphElement>(null);
  const previousAiPreviewTextRef = useRef(aiPreviewText);
  const expanded = userCollapsed ? false : (shouldAutoExpand && measuredNeedsExpand) || userExpanded;
  const canExpand = measuredNeedsExpand;
  const canExpandAiPreview = aiPreviewNeedsExpand;
  const noteMinHeight = isBoardHeader ? 126 : NOTE_MIN_HEIGHT;
  const noteBodyMinHeight = isBoardHeader ? 58 : NOTE_BODY_MIN_HEIGHT;
  const previewLabels = [
    mappedSource ? "Mapped source" : null,
    liveConflict ? "Live conflict" : null,
    aiPreviewChange?.move ? "Will move" : null,
    aiPreviewChange?.rewrite ? "Will rewrite" : null,
    aiPreviewChange?.replace ? "Will replace" : null,
    aiPreviewChange?.merge ? "Will merge" : null,
    highlights.some((highlight) => highlight.preview) ? "Will underline" : null,
  ].filter(Boolean);

  useLayoutEffect(() => {
    const textarea = taRef.current;
    if (!textarea) return;

    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;

    const nextNeedsExpand = textarea.scrollHeight > NOTE_COLLAPSED_BODY_MAX_HEIGHT + 8;
    setMeasuredNeedsExpand(nextNeedsExpand);
  }, [boardHeaderLabel, note.text]);

  useLayoutEffect(() => {
    if (previousAiPreviewTextRef.current === aiPreviewText) return;
    previousAiPreviewTextRef.current = aiPreviewText;
    setAiPreviewExpanded(false);
  }, [aiPreviewText]);

  useLayoutEffect(() => {
    const textElement = aiPreviewTextRef.current;
    if (!aiPreviewText || !textElement) {
      setAiPreviewNeedsExpand(false);
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const fullHeight = measureUnclampedTextHeight(textElement);
      setAiPreviewNeedsExpand(fullHeight > INLINE_AI_PREVIEW_COLLAPSED_HEIGHT + 2);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [aiPreviewExpanded, aiPreviewText]);

  return (
    <div
      data-note-id={note.id}
      data-note-author={note.author}
      data-note-color={note.color}
      data-selected={selected ? "true" : "false"}
      data-live-conflict-note={liveConflict ? "true" : undefined}
      className={[
        "sticky-note",
        deleteMode ? "sticky-note--delete-mode" : null,
        isBoardHeader ? "sticky-note--board-header" : null,
        contributorMapNote ? "sticky-note--contributor-map" : null,
        mappedSource ? "sticky-note--mapped-source" : null,
        liveConflict ? "sticky-note--live-conflict" : null,
        canExpand && !expanded ? "sticky-note--collapsed" : null,
        expanded ? "sticky-note--expanded" : null,
      ].filter(Boolean).join(" ")}
      style={{
        position: "absolute", left: previewPosition?.x ?? note.x, top: previewPosition?.y ?? note.y, width: NOTE_WIDTH, minHeight: noteMinHeight,
        background: NOTE_COLORS[note.color] ?? NOTE_COLORS.yellow,
        borderRadius: "var(--note-radius, 8px)",
        boxShadow: deleteMode
          ? "0 0 0 2px var(--color-danger), 0 10px 26px rgba(74,63,111,0.13)"
          : liveConflict
            ? "0 0 0 3px color-mix(in oklch, var(--color-danger) 72%, var(--color-ai)), 0 18px 40px rgba(137, 66, 119, 0.22)"
          : selected
            ? "0 0 0 3px var(--color-ai), 0 16px 34px rgba(74,63,111,0.16)"
          : contributorMapNote
            ? "0 0 0 2px color-mix(in oklch, var(--color-info) 54%, transparent), 0 16px 34px rgba(67, 92, 138, 0.16)"
          : mappedSource
            ? "0 0 0 2px color-mix(in oklch, var(--color-info) 34%, transparent), 0 12px 30px rgba(74,63,111,0.12)"
          : isBoardHeader
            ? "0 10px 22px rgba(74,63,111,0.08)"
            : "var(--note-shadow, 0 12px 30px rgba(74,63,111,0.11))",
        border: contributorMapNote
          ? "1px solid color-mix(in oklch, var(--color-info) 42%, var(--color-border))"
          : isBoardHeader
            ? "1px solid color-mix(in oklch, var(--color-ai) 20%, var(--color-border))"
            : "1px solid transparent",
        padding: isBoardHeader ? 10 : "var(--note-padding, 12px)", cursor: inkMode ? "crosshair" : deleteMode ? "pointer" : "grab",
        userSelect: "none",
        display: "flex", flexDirection: "column", gap: isBoardHeader ? 6 : 8,
        pointerEvents: inkMode || areaSelectMode ? "none" : "auto",
        zIndex: expanded ? 24 : selected ? 5 : 1,
      }}
      onMouseDownCapture={(e) => {
        if (!deleteMode && !inkMode) onSelect(e);
      }}
      onMouseDown={(e) => { if (!deleteMode) onStartDrag(e); }}
      onClick={deleteMode ? onClickToDelete : undefined}
    >
      {/* Remote selection overlay: when other participants have this note   */}
      {/* selected, render a colored outline ring in each of their presence  */}
      {/* colors plus a tiny user chip at the top-right. Local selection     */}
      {/* still uses the parent's box-shadow chain.                           */}
      {remoteSelections && remoteSelections.length > 0 && (
        <>
          {remoteSelections.slice(0, 3).map((peer, index) => (
            <div
              key={`ring-${peer.userName}`}
              aria-hidden="true"
              style={{
                position: "absolute",
                inset: -(2 + index * 3),
                borderRadius: "calc(var(--note-radius, 8px) + 2px)",
                border: `2px solid ${peer.color}`,
                pointerEvents: "none",
                zIndex: 2,
                opacity: 0.85,
              }}
            />
          ))}
          <div
            aria-hidden="true"
            style={{
              position: "absolute",
              top: -10,
              right: 8,
              display: "flex",
              gap: 4,
              pointerEvents: "none",
              zIndex: 3,
            }}
          >
            {remoteSelections.map((peer) => (
              <span
                key={`chip-${peer.userName}`}
                style={{
                  background: peer.color,
                  color: "oklch(99% 0.004 275)",
                  fontSize: 10.5,
                  padding: "1px 6px",
                  borderRadius: 4,
                  fontWeight: 700,
                  whiteSpace: "nowrap",
                  boxShadow: "0 1px 4px rgba(74,63,111,0.18)",
                  textTransform: "none",
                }}
              >
                {peer.userName} viewing
              </span>
            ))}
          </div>
        </>
      )}
      <div className="sticky-note__header">
        <div className="sticky-note__identity">
          <span>
            {selected ? selectedNoteLabel(boardHeaderLabel) : boardHeaderLabel ?? note.author}
          </span>
          {!isBoardHeader && !textStartsWithAuthorDate(note) && (
            <small>{formatNoteDate(note.createdAt)}</small>
          )}
        </div>
        <div className="sticky-note__actions">
          <button
            className="sticky-note__delete"
            aria-label="Delete note"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
          >
            ✕
          </button>
        </div>
      </div>
      {previewLabels.length > 0 && (
        <div className="note-ai-change-ribbon" onMouseDown={(e) => e.stopPropagation()}>
          {previewLabels.map((label) => <span key={label}>{label}</span>)}
        </div>
      )}
      <div style={{ position: "relative", flex: "0 0 auto", display: "flex", minHeight: noteBodyMinHeight }}>
        <LiveTextarea
          ref={taRef}
          value={note.text}
          onTextChange={onSetText}
          autoGrow
          onCaretChange={onCaretChange}
          spellCheck={false}
          placeholder="Type here. Two users can edit at once."
          style={{
            background: "transparent", border: "none", outline: "none", resize: "none",
            fontFamily: "inherit", fontSize: isBoardHeader ? 14 : 15, lineHeight: 1.45, flex: 1, padding: 0,
            color: "var(--color-text-strong)", width: "100%", minHeight: noteBodyMinHeight,
            maxHeight: canExpand && !expanded ? NOTE_COLLAPSED_BODY_MAX_HEIGHT : undefined,
            overflow: canExpand && !expanded ? "hidden" : "hidden",
            fontWeight: isBoardHeader ? 650 : 400,
          }}
          onMouseDown={(e) => e.stopPropagation()}
        />
        <RemoteCarets
          textareaRef={taRef}
          text={note.text}
          carets={remoteCarets}
          showLabels={false}
        />
        <NoteInlineHighlights
          text={note.text}
          highlights={highlights}
          textareaRef={taRef}
          aiFindHighlight={aiPreviewSpan && note.text.includes(aiPreviewSpan.find) ? { text: expandToSentence(note.text, aiPreviewSpan.find) } : undefined}
        />
      </div>
      {canExpand && (
        <button
          type="button"
          className="note-expand-button"
          aria-expanded={expanded}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            if (expanded) {
              setUserCollapsed(true);
              setUserExpanded(false);
              return;
            }
            setUserCollapsed(false);
            setUserExpanded(true);
          }}
        >
          {expanded ? "Collapse" : "Expand"}
        </button>
      )}
      {aiPreviewText && aiPreviewText !== note.text && (
        <div
          className={aiPreviewExpanded ? "note-ai-preview note-ai-preview--expanded" : "note-ai-preview"}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="note-ai-preview__header">
            <span>Private coauthor preview</span>
          </div>
          {aiPreviewSpan ? (
            // Surgical replaceSpan: render ONLY the new sentence as plain
            // text (no diff highlight, no background tint, no underline).
            // The original sentence above already has the AI-tinted overlay
            // marking what is being replaced, so the preview just needs to
            // show the clean replacement copy.
            <>
              <p ref={aiPreviewTextRef} className="note-ai-preview__sentence">
                {aiPreviewSpan.replace}
              </p>
              <p className="note-ai-preview__scope">
                Replaces only the highlighted sentence — rest of the note is unchanged.
              </p>
            </>
          ) : (
            // Full rewrite (updateNoteText): no per-sentence target, so
            // render the entire post-rewrite text with the diff overlay
            // so the user can still see what changed.
            <p ref={aiPreviewTextRef}>
              {(() => {
                const { prefix, changed, suffix } = splitPreviewIntoDiff(
                  note.text,
                  aiPreviewText,
                  undefined,
                );
                return (
                  <>
                    {prefix && <span className="note-ai-preview__unchanged">{prefix}</span>}
                    {changed && <span className="note-ai-preview__changed">{changed}</span>}
                    {suffix && <span className="note-ai-preview__unchanged">{suffix}</span>}
                  </>
                );
              })()}
            </p>
          )}
          {canExpandAiPreview && !aiPreviewSpan && (
            <button
              type="button"
              className="note-expand-button"
              aria-expanded={aiPreviewExpanded}
              onClick={(event) => {
                event.stopPropagation();
                setAiPreviewExpanded((value) => !value);
              }}
            >
              {aiPreviewExpanded ? "Collapse" : "Expand"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function AiPreviewNoteCard({
  text,
  label,
  className,
  style,
}: {
  text: string;
  label: string;
  className: string;
  style: { left: number; top: number };
}) {
  const [expanded, setExpanded] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);
  const summaryPreview = isContributorSummary(text) || isContributorMapHeader(text);
  const [measuredNeedsExpand, setMeasuredNeedsExpand] = useState(false);
  const previousTextRef = useRef(text);
  const canExpand = measuredNeedsExpand;
  const cardClassName = expanded ? `${className} ai-preview-note--expanded` : className;

  useLayoutEffect(() => {
    if (previousTextRef.current === text) return;
    previousTextRef.current = text;
    setExpanded(false);
  }, [text]);

  useLayoutEffect(() => {
    const textElement = textRef.current;
    if (!textElement) {
      setMeasuredNeedsExpand(false);
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const lineHeight = Number.parseFloat(window.getComputedStyle(textElement).lineHeight) || 17;
      const collapsedLines = summaryPreview ? SUMMARY_PREVIEW_NOTE_COLLAPSED_LINES : PREVIEW_NOTE_COLLAPSED_LINES;
      const collapsedTextHeight = lineHeight * collapsedLines + 2;
      const fullHeight = measureUnclampedTextHeight(textElement);
      setMeasuredNeedsExpand(fullHeight > collapsedTextHeight);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [expanded, summaryPreview, text]);

  return (
    <div className={cardClassName} style={style} data-ai-preview-note="true">
      <div className="ai-preview-note__header">
        <span>{label}</span>
      </div>
      <p ref={textRef}>{text}</p>
      {canExpand && (
        <button
          type="button"
          className="ai-preview-note__toggle"
          aria-expanded={expanded}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            setExpanded((value) => !value);
          }}
        >
          {expanded ? "Collapse" : "Expand"}
        </button>
      )}
    </div>
  );
}

function getBoardHeaderLabel(text: string): string | null {
  const firstLine = text.trim().split(/\r?\n/)[0]?.toLowerCase() ?? "";
  if (!firstLine) return null;
  if (firstLine === "contributor map") return "Contributor map";
  if (firstLine === "shared state") return "State brief";
  if (firstLine === "semantic merge") return "Semantic merge";
  if (isContributorSummary(text)) return "Map summary";
  if (/\binput$/.test(firstLine)) return "Contributor group";
  if (/\b(context|risks?|next steps?)\b/.test(firstLine)) return "Board lane";
  return null;
}

function isContributorMapNote(text: string): boolean {
  const firstLine = text.trim().split(/\r?\n/)[0]?.toLowerCase() ?? "";
  return firstLine === "contributor map" || isContributorSummary(text);
}

function isContributorMapHeader(text: string): boolean {
  const firstLine = text.trim().split(/\r?\n/)[0]?.toLowerCase() ?? "";
  return firstLine === "contributor map";
}

function isContributorSummary(text: string): boolean {
  const firstLine = text.trim().split(/\r?\n/)[0]?.toLowerCase() ?? "";
  return /\bsummary$/.test(firstLine) || /^contributor\s*:/.test(firstLine);
}

function isSemanticMergePreview(text: string): boolean {
  const firstLine = text.trim().split(/\r?\n/)[0]?.toLowerCase() ?? "";
  // Matches both the AI-structured "semantic merge" header and the
  // fallback reconcile note whose first line is "{reviewer}'s reconcile — {topic}".
  return firstLine === "semantic merge" || /\breconcile\s*[—–-]/.test(firstLine);
}

function getTaskBoardX(notes: StickyNote[]): number {
  if (notes.length === 0) return 72;
  return notes.reduce((max, note) => Math.max(max, note.x), 72) + NOTE_WIDTH + 48;
}

function getTaskBoardY(notes: StickyNote[]): number {
  if (notes.length === 0) return 120;
  return Math.max(78, notes.reduce((min, note) => Math.min(min, note.y), 120));
}

export function CanvasView({
  doc, userName, onAddNote, onUpdateNote, onDeleteNote, onSetNoteText, onDeleteShape,
  onMoveItem, onCursorMove, onAddStroke, onDeleteStroke,
  onToggleTask,
  onCaretChange,
  selectedNoteIds,
  selectedStrokeIds,
  onSelectNotes,
  onSelectStrokes,
  aiPreviewEdits,
  liveConflictNoteId,
  areaSelectMode,
  inkMode, inkColor, inkWidth, deleteMode, otherUsers,
}: CanvasViewProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const dragPreviewFrameRef = useRef<number | null>(null);
  const dragPreviewPositionsRef = useRef<Map<string, DragPreviewPosition>>(new Map());
  const inkRef = useRef<{ id: string; points: number[] } | null>(null);
  const selectionRef = useRef<{ startX: number; startY: number; currentX: number; currentY: number } | null>(null);
  const [dragPreviewPositions, setDragPreviewPositions] = useState<Map<string, DragPreviewPosition>>(() => new Map());
  const [livePoints, setLivePoints] = useState<number[]>([]);
  const [selectionRect, setSelectionRect] = useState<SelectionRect | null>(null);

  // onUpdateNote retained on the public API for future color/metadata edits;
  // note text now goes through onSetNoteText (Automerge splice) so two users
  // can type into the same sticky and merge character-by-character.
  void onUpdateNote;
  void userName;

  useLayoutEffect(() => () => {
    if (dragPreviewFrameRef.current !== null) {
      window.cancelAnimationFrame(dragPreviewFrameRef.current);
      dragPreviewFrameRef.current = null;
    }
  }, []);

  const scheduleDragPreview = useCallback((positions: DragPreviewPosition[]) => {
    const next = new Map(dragPreviewPositionsRef.current);
    positions.forEach((position) => {
      next.set(dragPreviewKey(position.kind, position.id), position);
    });
    dragPreviewPositionsRef.current = next;

    if (dragPreviewFrameRef.current !== null) return;
    dragPreviewFrameRef.current = window.requestAnimationFrame(() => {
      dragPreviewFrameRef.current = null;
      setDragPreviewPositions(new Map(dragPreviewPositionsRef.current));
    });
  }, []);

  const clearDragPreview = useCallback(() => {
    if (dragPreviewFrameRef.current !== null) {
      window.cancelAnimationFrame(dragPreviewFrameRef.current);
      dragPreviewFrameRef.current = null;
    }
    dragPreviewPositionsRef.current = new Map();
    setDragPreviewPositions(new Map());
  }, []);

  const syncDragPositions = useCallback((positions: DragPreviewPosition[]) => {
    positions.forEach((position) => {
      onMoveItem(position.kind, position.id, position.x, position.y);
    });
  }, [onMoveItem]);

  const getDragPreviewPosition = useCallback(
    (kind: "note" | "shape", id: string) => dragPreviewPositions.get(dragPreviewKey(kind, id)),
    [dragPreviewPositions],
  );

  const aiPreview = useMemo(() => {
    const noteUpdates = new Map<string, string>();
    /**
     * Per-note record of the literal `find` / `replace` strings carried by
     * a `replaceSpan` edit. We keep only the first replaceSpan we see per
     * note so the preview UI can point at "the one sentence being touched";
     * if multiple replaceSpans land on the same note the others still get
     * applied to `noteUpdates`, they just do not drive the highlight.
     */
    const noteSpans = new Map<string, { find: string; replace: string }>();
    const noteMoves: Array<Extract<AiProposalEdit, { type: "moveNote" }> & { previewId: string }> = [];
    const noteDeletes: Array<Extract<AiProposalEdit, { type: "deleteNote" }> & { previewId: string }> = [];
    const noteAdds: Array<Extract<AiProposalEdit, { type: "addNote" }> & { previewId: string }> = [];
    const shapeAdds: Array<Extract<AiProposalEdit, { type: "addShape" }> & { previewId: string }> = [];
    const taskAdds: Array<Extract<AiProposalEdit, { type: "addTask" }> & { previewId: string }> = [];
    const highlightAdds: Array<Extract<AiProposalEdit, { type: "addHighlight" }> & { previewId: string }> = [];

    (aiPreviewEdits ?? []).forEach((edit, index) => {
      if (edit.type === "updateNoteText") {
        noteUpdates.set(edit.id, edit.text);
        return;
      }

      if (edit.type === "moveNote") {
        noteMoves.push({ ...edit, previewId: `move-${index}` });
        return;
      }

      if (edit.type === "deleteNote") {
        noteDeletes.push({ ...edit, previewId: `delete-${index}` });
        return;
      }

      if (edit.type === "addNote") {
        noteAdds.push({ ...edit, previewId: `note-${index}` });
        return;
      }

      if (edit.type === "addTask") {
        taskAdds.push({ ...edit, previewId: `task-${index}` });
        return;
      }

      if (edit.type === "addHighlight") {
        highlightAdds.push({ ...edit, previewId: `highlight-${index}` });
        return;
      }

      if (edit.type === "replaceSpan") {
        // For canvas preview we synthesize a noteUpdates entry by applying
        // the find/replace against the current note text. The accept path in
        // useCanvas does the real apply; this is only for the live preview.
        const sourceNote = doc.notes.find((note) => note.id === edit.noteId);
        if (sourceNote && sourceNote.text.includes(edit.find)) {
          const previewText = (noteUpdates.get(edit.noteId) ?? sourceNote.text).replace(edit.find, edit.replace);
          noteUpdates.set(edit.noteId, previewText);
          if (!noteSpans.has(edit.noteId)) {
            noteSpans.set(edit.noteId, { find: edit.find, replace: edit.replace });
          }
        }
        return;
      }

      if (edit.type === "addShape") {
        shapeAdds.push({ ...edit, previewId: `shape-${index}` });
        return;
      }
    });

    return { noteUpdates, noteSpans, noteMoves, noteDeletes, noteAdds, shapeAdds, taskAdds, highlightAdds };
  }, [aiPreviewEdits, doc.notes]);
  const previewSummary = formatPreviewSummary(aiPreview, aiPreviewEdits?.length ?? 0);
  const movedNoteIds = useMemo(
    () => new Set(aiPreview.noteMoves.map((move) => move.id)),
    [aiPreview.noteMoves],
  );
  const mergedNoteIds = useMemo(
    () => new Set(aiPreview.noteDeletes
      .filter((merge) => merge.rationale?.toLowerCase().includes("semantic"))
      .map((merge) => merge.id)),
    [aiPreview.noteDeletes],
  );
  const replaceNoteIds = useMemo(
    () => new Set(aiPreview.noteDeletes
      .filter((replacement) => !replacement.rationale?.toLowerCase().includes("semantic"))
      .map((replacement) => replacement.id)),
    [aiPreview.noteDeletes],
  );
  const liveMergeUpdateIds = useMemo(
    () => new Set(
      (aiPreviewEdits ?? [])
        .filter((edit): edit is Extract<AiProposalEdit, { type: "updateNoteText" }> =>
          edit.type === "updateNoteText" && /live semantic conflict/i.test(edit.rationale ?? "")
        )
        .map((edit) => edit.id)
    ),
    [aiPreviewEdits],
  );
  const canvasSize = useMemo(() => {
    let maxX = 0;
    let maxY = 0;
    const includeRect = (x: number, y: number, width: number, height: number) => {
      maxX = Math.max(maxX, x + width);
      maxY = Math.max(maxY, y + height);
    };

    doc.notes.forEach((note) => {
      const preview = dragPreviewPositions.get(dragPreviewKey("note", note.id));
      includeRect(preview?.x ?? note.x, preview?.y ?? note.y, NOTE_WIDTH, estimateNoteHeight(note.text));
    });
    doc.shapes.forEach((shape) => {
      const preview = dragPreviewPositions.get(dragPreviewKey("shape", shape.id));
      includeRect(preview?.x ?? shape.x, preview?.y ?? shape.y, shape.size, shape.size);
    });
    (doc.strokes ?? []).forEach((stroke) => {
      for (let i = 0; i + 1 < stroke.points.length; i += 2) {
        includeRect(stroke.points[i], stroke.points[i + 1], stroke.width, stroke.width);
      }
    });
    aiPreview.noteAdds.forEach((note) => includeRect(note.x, note.y, NOTE_WIDTH, estimatePreviewNoteHeight(note.text)));
    aiPreview.noteMoves.forEach((move) => {
      const sourceNote = doc.notes.find((note) => note.id === move.id);
      includeRect(move.x, move.y, NOTE_WIDTH, estimatePreviewNoteHeight(aiPreview.noteUpdates.get(move.id) ?? sourceNote?.text ?? ""));
    });
    aiPreview.shapeAdds.forEach((shape) => {
      const size = shape.size ?? 60;
      includeRect(shape.x, shape.y, size, size);
    });
    if ((doc.tasks?.length ?? 0) > 0 || aiPreview.taskAdds.length > 0) {
      includeRect(getTaskBoardX(doc.notes), getTaskBoardY(doc.notes), 360, 240);
    }

    return {
      width: Math.max(900, maxX + 120),
      height: Math.max(600, maxY + 220),
    };
  }, [aiPreview.noteAdds, aiPreview.noteMoves, aiPreview.noteUpdates, aiPreview.shapeAdds, aiPreview.taskAdds.length, doc.notes, doc.shapes, doc.strokes, doc.tasks, dragPreviewPositions]);

  // Group remote carets by note id so each StickyNoteView gets only its own.
  const caretsByNote = new Map<string, { userName: string; color: string; offset: number }[]>();
  for (const u of otherUsers) {
    if (u.caret?.surface === "note") {
      const list = caretsByNote.get(u.caret.noteId) ?? [];
      list.push({ userName: u.userName, color: u.color, offset: u.caret.offset });
      caretsByNote.set(u.caret.noteId, list);
    }
  }

  // Group remote selections by note id. This is the "who is looking at this
  // note" signal — it powers the colored outline ring + tiny user chip we
  // render on each StickyNoteView when another participant has it selected.
  const selectionsByNote = new Map<string, { userName: string; color: string }[]>();
  for (const u of otherUsers) {
    for (const id of u.selectedNoteIds ?? []) {
      const list = selectionsByNote.get(id) ?? [];
      list.push({ userName: u.userName, color: u.color });
      selectionsByNote.set(id, list);
    }
  }

  const highlightsByNote = new Map<string, NoteHighlightView[]>();
  (doc.highlights ?? []).forEach((highlight) => {
    const list = highlightsByNote.get(highlight.noteId) ?? [];
    list.push(highlight);
    highlightsByNote.set(highlight.noteId, list);
  });
  aiPreview.highlightAdds.forEach((highlight) => {
    const list = highlightsByNote.get(highlight.noteId) ?? [];
    list.push({
      id: highlight.previewId,
      noteId: highlight.noteId,
      text: highlight.text,
      color: highlight.color ?? "#c83f4f",
      author: "AI preview",
      createdAt: 0,
      rationale: highlight.rationale,
      preview: true,
    });
    highlightsByNote.set(highlight.noteId, list);
  });

  const getPos = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    if (inkMode || areaSelectMode) return;
    if (e.target !== canvasRef.current) return;
    const { x, y } = getPos(e);
    onAddNote(x, y);
  };

  const deleteStrokeFromLayer = useCallback((strokeId: string, e: React.MouseEvent<SVGPolylineElement>) => {
    if (!deleteMode) return;
    e.stopPropagation();
    onDeleteStroke(strokeId);
    onSelectStrokes([]);
  }, [deleteMode, onDeleteStroke, onSelectStrokes]);

  const selectStrokeFromLayer = useCallback((strokeId: string, e: React.MouseEvent<SVGPolylineElement>) => {
    if (deleteMode) {
      deleteStrokeFromLayer(strokeId, e);
      return;
    }

    e.stopPropagation();
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      const next = selectedStrokeIds.includes(strokeId)
        ? selectedStrokeIds.filter((id) => id !== strokeId)
        : [...selectedStrokeIds, strokeId];
      onSelectStrokes(next);
      return;
    }
    onSelectNotes([]);
    onSelectStrokes([strokeId]);
  }, [deleteMode, deleteStrokeFromLayer, onSelectNotes, onSelectStrokes, selectedStrokeIds]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (areaSelectMode) {
      if (e.target !== canvasRef.current) return;
      e.stopPropagation();
      const { x, y } = getPos(e);
      selectionRef.current = { startX: x, startY: y, currentX: x, currentY: y };
      setSelectionRect({ x, y, width: 0, height: 0 });
      onSelectNotes([]);
      onSelectStrokes([]);
      return;
    }

    if (!inkMode) {
      if (isCanvasClearTarget(e.target, canvasRef.current)) {
        onSelectNotes([]);
        onSelectStrokes([]);
      }
      return;
    }
    e.stopPropagation();
    const { x, y } = getPos(e);
    const id = uuid();
    inkRef.current = { id, points: [x, y] };
    setLivePoints([x, y]);
  }, [areaSelectMode, inkMode, onSelectNotes, onSelectStrokes]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const { x, y } = getPos(e);
    onCursorMove(x, y);
    if (selectionRef.current) {
      selectionRef.current.currentX = x;
      selectionRef.current.currentY = y;
      setSelectionRect(rectFromPoints(
        selectionRef.current.startX,
        selectionRef.current.startY,
        selectionRef.current.currentX,
        selectionRef.current.currentY,
      ));
      return;
    }

    if (inkMode) {
      if (inkRef.current && e.buttons === 1) {
        inkRef.current.points.push(x, y);
        setLivePoints([...inkRef.current.points]);
      }
      return;
    }
    if (!dragRef.current) return;
    const drag = dragRef.current;
    const { startX, startY, items } = drag;
    const dx = x - startX;
    const dy = y - startY;
    const positions = items.map((it) => ({
      kind: it.kind,
      id: it.id,
      x: it.baseX + dx,
      y: it.baseY + dy,
    }));
    scheduleDragPreview(positions);
    drag.lastPositions = positions;

    const now = performance.now();
    const signature = dragPositionSignature(positions);
    if (now - drag.lastSyncAt >= DRAG_SYNC_INTERVAL_MS && signature !== drag.lastSyncSignature) {
      drag.lastSyncAt = now;
      drag.lastSyncSignature = signature;
      syncDragPositions(positions);
    }
  }, [inkMode, onCursorMove, scheduleDragPreview, syncDragPositions]);

  const handleMouseUp = useCallback(() => {
    if (selectionRef.current) {
      const rect = rectFromPoints(
        selectionRef.current.startX,
        selectionRef.current.startY,
        selectionRef.current.currentX,
        selectionRef.current.currentY,
      );
      const selectedIds = doc.notes
        .filter((note) => rectIntersects(rect, {
          x: note.x,
          y: note.y,
          width: NOTE_WIDTH,
              height: estimateNoteHeight(note.text),
        }))
        .map((note) => note.id);
      onSelectNotes(selectedIds);
      onSelectStrokes([]);
      selectionRef.current = null;
      setSelectionRect(null);
      return;
    }

    if (inkMode && inkRef.current && inkRef.current.points.length >= 4) {
      onAddStroke({
        id: inkRef.current.id,
        points: inkRef.current.points,
        color: inkColor,
        width: inkWidth,
        author: userName,
      });
      onSelectNotes([]);
      onSelectStrokes([inkRef.current.id]);
    }
    const activeDrag = dragRef.current;
    if (activeDrag && activeDrag.lastPositions.length > 0) {
      const signature = dragPositionSignature(activeDrag.lastPositions);
      if (signature !== activeDrag.lastSyncSignature) {
        syncDragPositions(activeDrag.lastPositions);
      }
      clearDragPreview();
    }
    inkRef.current = null;
    setLivePoints([]);
    dragRef.current = null;
  }, [doc.notes, inkMode, inkColor, inkWidth, userName, onAddStroke, onSelectNotes, onSelectStrokes, clearDragPreview, syncDragPositions]);

  const startDrag = (kind: "note" | "shape", id: string, itemX: number, itemY: number, e: React.MouseEvent) => {
    if (inkMode || areaSelectMode) return;
    e.stopPropagation();
    const { x, y } = getPos(e);
    let items: DraggedItem[];
    if (kind === "note" && selectedNoteIds.includes(id) && selectedNoteIds.length > 1) {
      const selectedSet = new Set(selectedNoteIds);
      items = doc.notes
        .filter((n) => selectedSet.has(n.id))
        .map((n) => ({ kind: "note" as const, id: n.id, baseX: n.x, baseY: n.y }));
      if (!items.find((it) => it.id === id)) {
        items.push({ kind: "note", id, baseX: itemX, baseY: itemY });
      }
    } else {
      items = [{ kind, id, baseX: itemX, baseY: itemY }];
    }
    const initialPositions = items.map((item) => ({
      kind: item.kind,
      id: item.id,
      x: item.baseX,
      y: item.baseY,
    }));
    dragRef.current = {
      kind,
      id,
      startX: x,
      startY: y,
      items,
      lastPositions: initialPositions,
      lastSyncAt: 0,
      lastSyncSignature: dragPositionSignature(initialPositions),
    };
  };

  const isEmpty = doc.notes.length === 0 && doc.shapes.length === 0 && (doc.strokes?.length ?? 0) === 0 && (doc.tasks?.length ?? 0) === 0;
  const taskBoardX = getTaskBoardX(doc.notes);
  const taskBoardY = getTaskBoardY(doc.notes);
  const noteMarkerShapeIds = new Set(
    doc.shapes
      .filter((shape) => doc.notes.some((note) => shapeIsInsideNote(shape, note)))
      .map((shape) => shape.id),
  );
  const canvasShapes = doc.shapes.filter((shape) => !noteMarkerShapeIds.has(shape.id));
  const noteMarkerShapes = doc.shapes.filter((shape) => noteMarkerShapeIds.has(shape.id));
  const renderShape = (shape: Shape, elevated: boolean) => {
    const preview = getDragPreviewPosition("shape", shape.id);
    const x = preview?.x ?? shape.x;
    const y = preview?.y ?? shape.y;
    return (
      <div key={shape.id}
        data-note-marker={elevated ? "true" : "false"}
        style={{
          position: "absolute", left: x, top: y,
          width: shape.size, height: shape.size,
          cursor: areaSelectMode ? "crosshair" : inkMode ? "crosshair" : deleteMode ? "pointer" : "grab",
          userSelect: "none",
          outline: deleteMode ? "2px dashed var(--color-danger)" : "none",
          borderRadius: 4,
          pointerEvents: areaSelectMode ? "none" : "auto",
          zIndex: elevated ? 12 : undefined,
          filter: elevated ? "drop-shadow(0 6px 10px rgba(74, 63, 111, 0.16))" : undefined,
        }}
        onMouseDown={(e) => { if (!deleteMode) startDrag("shape", shape.id, x, y, e); }}
        onClick={deleteMode ? (e) => { e.stopPropagation(); onDeleteShape(shape.id); } : undefined}
        onContextMenu={(e) => { if (!inkMode && !deleteMode) { e.preventDefault(); onDeleteShape(shape.id); } }}
      >
        <svg width={shape.size} height={shape.size} style={{ pointerEvents: "none" }}>
          <ShapeIcon type={shape.type} color={shape.color} size={shape.size} />
        </svg>
      </div>
    );
  };

  return (
    <div
      data-canvas-root="true"
      ref={canvasRef}
      onDoubleClick={handleDoubleClick}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      style={{
        position: "relative", width: canvasSize.width, height: canvasSize.height, minWidth: "100%", minHeight: "100%", overflow: "hidden",
        cursor: areaSelectMode ? "crosshair" : inkMode ? "crosshair" : deleteMode ? "pointer" : "default",
      }}
    >
      {/* SVG layer: all committed strokes + live in-progress stroke */}
      <svg
        data-canvas-layer="ink"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: inkMode || areaSelectMode ? "none" : "auto" }}
      >
        {(doc.strokes ?? []).map((s: InkStroke) => {
          const points = pointsToPolyline(s.points);
          const selected = selectedStrokeIds.includes(s.id);
          return (
            <g key={s.id}>
              {selected && (
                <polyline
                  points={points}
                  fill="none"
                  stroke="var(--color-ai)"
                  strokeWidth={strokeDeleteHitWidth(s.width)}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity={0.24}
                  style={{ pointerEvents: "none" }}
                />
              )}
              <polyline
                points={points}
                fill="none"
                stroke={s.color}
                strokeWidth={s.width}
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ pointerEvents: "none", opacity: deleteMode ? 0.62 : 1 }}
              />
              <polyline
                data-stroke-hit-target="true"
                data-selected={selected ? "true" : "false"}
                points={points}
                fill="none"
                stroke="transparent"
                strokeWidth={strokeDeleteHitWidth(s.width)}
                strokeLinecap="round"
                strokeLinejoin="round"
                pointerEvents="stroke"
                style={{ cursor: "pointer" }}
                onClick={(e) => selectStrokeFromLayer(s.id, e)}
              />
            </g>
          );
        })}
        {livePoints.length >= 4 && (
          <polyline
            points={pointsToPolyline(livePoints)}
            fill="none"
            stroke={inkColor}
            strokeWidth={inkWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.7}
          />
        )}
      </svg>

      {/* Shapes */}
      {canvasShapes.map((shape) => renderShape(shape, false))}

      {previewSummary && (
        <div className="ai-preview-status" data-ai-preview-status="true" aria-live="polite">
          <span>Private coauthor preview</span>
          <strong>{previewSummary}</strong>
          <em>Accept to share</em>
        </div>
      )}

      {/* Sticky notes */}
      {doc.notes.map((note: StickyNote) => (
        <StickyNoteView
          key={note.id}
          note={note}
          inkMode={inkMode}
          deleteMode={deleteMode}
          onSetText={(next) => onSetNoteText(note.id, next)}
          onDelete={() => onDeleteNote(note.id)}
          onStartDrag={(e) => startDrag("note", note.id, note.x, note.y, e)}
          onClickToDelete={(e) => { e.stopPropagation(); onDeleteNote(note.id); }}
          onCaretChange={(offset) =>
            onCaretChange(offset === null ? null : { surface: "note", noteId: note.id, offset })
          }
          selected={selectedNoteIds.includes(note.id)}
          areaSelectMode={areaSelectMode}
          onSelect={(e) => {
            if (e.shiftKey || e.metaKey || e.ctrlKey) {
              const next = selectedNoteIds.includes(note.id)
                ? selectedNoteIds.filter((id) => id !== note.id)
                : [...selectedNoteIds, note.id];
              onSelectNotes(next);
            } else {
              onSelectNotes([note.id]);
            }
          }}
          aiPreviewText={aiPreview.noteUpdates.get(note.id)}
          aiPreviewChange={{
            rewrite: aiPreview.noteUpdates.has(note.id) && !liveMergeUpdateIds.has(note.id),
            move: movedNoteIds.has(note.id),
            merge: mergedNoteIds.has(note.id) || liveMergeUpdateIds.has(note.id),
            replace: replaceNoteIds.has(note.id),
          }}
          aiPreviewSpan={aiPreview.noteSpans.get(note.id)}
          mappedSource={false}
          liveConflict={liveConflictNoteId === note.id}
          highlights={highlightsByNote.get(note.id) ?? []}
          remoteCarets={caretsByNote.get(note.id) ?? []}
          previewPosition={getDragPreviewPosition("note", note.id)}
          remoteSelections={selectionsByNote.get(note.id) ?? []}
        />
      ))}

      {/* Note-attached visual markers render above sticky notes. */}
      {noteMarkerShapes.map((shape) => renderShape(shape, true))}

      {selectionRect && (
        <div
          className="area-selection-box"
          style={{
            left: selectionRect.x,
            top: selectionRect.y,
            width: selectionRect.width,
            height: selectionRect.height,
          }}
        />
      )}

      {aiPreview.noteMoves.length > 0 && (
        <svg className="ai-preview-connectors" aria-hidden="true">
          <defs>
            <marker id="ai-preview-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
            </marker>
          </defs>
          {aiPreview.noteMoves.map((move) => {
            const sourceNote = doc.notes.find((note) => note.id === move.id);
            if (!sourceNote) return null;
            return (
              <line
            key={`connector-${move.previewId}`}
            x1={sourceNote.x + NOTE_WIDTH / 2}
                y1={sourceNote.y + estimateNoteHeight(sourceNote.text) / 2}
                x2={move.x + NOTE_WIDTH / 2}
                y2={move.y + estimatePreviewNoteHeight(aiPreview.noteUpdates.get(move.id) ?? sourceNote.text) / 2}
                markerEnd="url(#ai-preview-arrow)"
              />
            );
          })}
        </svg>
      )}

      {aiPreview.noteMoves.map((move) => {
        const sourceNote = doc.notes.find((note) => note.id === move.id);
        if (!sourceNote) return null;
        return (
          <AiPreviewNoteCard
            key={move.previewId}
            className="ai-preview-note ai-preview-note--move"
            style={{ left: move.x, top: move.y }}
            label="Move preview"
            text={aiPreview.noteUpdates.get(move.id) ?? sourceNote.text}
          />
        );
      })}

      {aiPreview.noteAdds.map((note) => {
        const summaryLikePreview = isContributorSummary(note.text) || isSemanticMergePreview(note.text);
        const contributorMapHeader = isContributorMapHeader(note.text);
        return (
          <AiPreviewNoteCard
            key={note.previewId}
            className={summaryLikePreview || contributorMapHeader ? "ai-preview-note ai-preview-note--add ai-preview-note--summary" : "ai-preview-note ai-preview-note--add"}
            style={{ left: note.x, top: note.y }}
            label={contributorMapHeader ? "Contributor map" : isContributorSummary(note.text) ? "Map summary" : isSemanticMergePreview(note.text) ? "Merge spark" : "New-note spark"}
            text={note.text}
          />
        );
      })}

      {aiPreview.shapeAdds.map((shape) => (
        <div
          key={shape.previewId}
          className="ai-preview-shape"
          style={{
            left: shape.x,
            top: shape.y,
            width: shape.size ?? 60,
            height: shape.size ?? 60,
          }}
        >
          <svg width={shape.size ?? 60} height={shape.size ?? 60}>
            <ShapeIcon type={shape.shape} color={shape.color ?? "#7b61ff"} size={shape.size ?? 60} />
          </svg>
          <span>Shape spark</span>
        </div>
      ))}

      {(doc.tasks?.length ?? 0) > 0 && (
        <TaskBoard
          tasks={doc.tasks}
          notes={doc.notes}
          x={taskBoardX}
          y={taskBoardY}
          onToggleTask={onToggleTask}
        />
      )}

      {aiPreview.taskAdds.length > 0 && (
        <TaskBoardPreview tasks={aiPreview.taskAdds} notes={doc.notes} x={taskBoardX} y={taskBoardY} />
      )}

      {/* Other users' cursors */}
      {otherUsers.map((u) => (
        <div key={u.userName} style={{
          position: "absolute", left: u.cursorX, top: u.cursorY,
          pointerEvents: "none", zIndex: 1000,
          display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 3,
        }}>
          <svg width={24} height={24} style={{ filter: "drop-shadow(0 2px 5px rgba(74,63,111,0.18))" }}>
            <polygon points="2,2 2,20 7,15 11,22 14,21 10,14 18,14" fill={u.color} stroke="oklch(99% 0.004 275)" strokeWidth="1.5" strokeLinejoin="round" />
          </svg>
          <span style={{
            background: u.color, color: "oklch(99% 0.004 275)", fontSize: 12,
            padding: "2px 7px", borderRadius: 5, fontWeight: 700,
            whiteSpace: "nowrap", boxShadow: "0 2px 6px rgba(74,63,111,0.14)",
          }}>
            {u.userName}
          </span>
        </div>
      ))}

      {/* Empty hint */}
      {isEmpty && (
        <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", color: "var(--color-text-faint)", fontSize: 14, fontWeight: 650, textAlign: "center", lineHeight: 1.55, pointerEvents: "none" }}>
          Double-click canvas to add a note<br />Use "+ Shape" to add shapes<br />Use Draw to ink freehand<br />Use Delete mode to remove notes, shapes, or ink
        </div>
      )}
    </div>
  );
}

function TaskBoard({
  tasks,
  notes,
  x,
  y,
  onToggleTask,
}: {
  tasks: CanvasTask[];
  notes: StickyNote[];
  x: number;
  y: number;
  onToggleTask: (id: string) => void;
}) {
  const openCount = tasks.filter((task) => task.status !== "done").length;
  return (
    <section className="canvas-task-board" data-task-board="true" style={{ left: x, top: y }} aria-label="Handoff launchpad">
      <div className="canvas-task-board__header">
        <span>Handoff launchpad</span>
        <strong>{openCount} open</strong>
      </div>
      <div className="canvas-task-board__items">
        {tasks.map((task) => (
          <label key={task.id} className={task.status === "done" ? "canvas-task canvas-task--done" : "canvas-task"}>
            <input
              type="checkbox"
              checked={task.status === "done"}
              onChange={() => onToggleTask(task.id)}
            />
            <span>
              <strong>{task.title}</strong>
              <em>{formatTaskSource(task, notes)}</em>
            </span>
          </label>
        ))}
      </div>
    </section>
  );
}

function TaskBoardPreview({
  tasks,
  notes,
  x,
  y,
}: {
  tasks: Array<Extract<AiProposalEdit, { type: "addTask" }> & { previewId: string }>;
  notes: StickyNote[];
  x: number;
  y: number;
}) {
  return (
    <section className="canvas-task-board canvas-task-board--preview" data-task-board-preview="true" style={{ left: x, top: y }} aria-label="Handoff preview">
      <div className="canvas-task-board__header">
        <span>Handoff preview</span>
        <strong>Accept to share</strong>
      </div>
      <div className="canvas-task-board__items">
        {tasks.map((task) => (
          <label key={task.previewId} className="canvas-task canvas-task--preview">
            <input type="checkbox" checked={false} readOnly />
            <span>
              <strong>{task.title}</strong>
              <em>{formatTaskSource(task, notes)}</em>
            </span>
          </label>
        ))}
      </div>
    </section>
  );
}

function formatTaskSource(task: {
  sourceAuthors?: string[];
  sourceCreatedAt?: number[];
  sourceNoteIds?: string[];
  sourceGroundingIds?: string[];
  timing?: string;
  createdAt?: number;
  status?: CanvasTask["status"];
  completedBy?: string;
  completedAt?: number;
}, notes: StickyNote[]): string {
  const sourceNotes = (task.sourceNoteIds ?? [])
    .map((id) => notes.find((note) => note.id === id))
    .filter((note): note is StickyNote => Boolean(note));
  const authors = task.sourceAuthors?.length
    ? task.sourceAuthors
    : [...new Set(sourceNotes.map((note) => note.author).filter(Boolean))];
  const sourceTimes = task.sourceCreatedAt?.length
    ? task.sourceCreatedAt
    : sourceNotes.map((note) => note.createdAt).filter((time): time is number => typeof time === "number");
  const parts: string[] = [];

  if (authors.length > 0) parts.push(`From ${authors.join(", ")}`);
  if (sourceTimes.length > 0) parts.push(`Added ${formatTaskTime(Math.min(...sourceTimes))}`);
  else if (task.createdAt) parts.push(`Created ${formatTaskTime(task.createdAt)}`);
  if (task.timing) parts.push(task.timing);
  if (task.status === "done" && task.completedBy && task.completedAt) {
    parts.push(`Done by ${task.completedBy} ${formatTaskTime(task.completedAt)}`);
  }
  if (parts.length === 0) {
    const sourceCount = (task.sourceNoteIds?.length ?? 0) + (task.sourceGroundingIds?.length ?? 0);
    if (sourceCount > 0) return `${sourceCount} source${sourceCount === 1 ? "" : "s"}`;
  }
  return parts.join(" · ") || "No source trace";
}

function formatTaskTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatPreviewSummary(
  preview: {
    noteUpdates: Map<string, string>;
    noteMoves: unknown[];
    noteDeletes: unknown[];
    noteAdds: unknown[];
    shapeAdds: unknown[];
    taskAdds: unknown[];
    highlightAdds: unknown[];
  },
  totalCount: number,
): string | null {
  if (totalCount === 0) return null;
  const parts: string[] = [];
  const noteCount = preview.noteUpdates.size + preview.noteMoves.length + preview.noteDeletes.length + preview.noteAdds.length;
  if (noteCount > 0) parts.push(`${noteCount} note change${noteCount === 1 ? "" : "s"}`);
  if (preview.shapeAdds.length > 0) {
    parts.push(`${preview.shapeAdds.length} marker${preview.shapeAdds.length === 1 ? "" : "s"}`);
  }
  if (preview.taskAdds.length > 0) {
    parts.push(`${preview.taskAdds.length} task${preview.taskAdds.length === 1 ? "" : "s"}`);
  }
  if (preview.highlightAdds.length > 0) {
    parts.push(`${preview.highlightAdds.length} highlight${preview.highlightAdds.length === 1 ? "" : "s"}`);
  }
  return parts.length > 0 ? parts.join(" · ") : `${totalCount} change${totalCount === 1 ? "" : "s"}`;
}
