import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useCanvas } from "./useCanvas";
import { usePresence, type CaretPresence } from "./usePresence";
import { CanvasView } from "./CanvasView";
import { LiveTextarea } from "./LiveTextarea";
import { RemoteCarets } from "./RemoteCarets";
import { Act2Panel, type Act2PanelHandle, type AiReviewPhase, type DemoWorkflowId } from "./Act2Panel";
import { createAiRequestSnapshot, OpenAiCompatibleAiProvider, detectSemanticTensions, type AiProposalEdit, type SemanticTension } from "./ai";
import { buildLiveSemanticConflictSuggestion, enrichTensionWithAi, type LiveSemanticConflictSuggestion } from "./liveSemanticConflict";
import type { ShapeType, StickyNote } from "./schema";
import { AI_LIVE_ENABLED, HOSTED_PLAYGROUND_NOTICE } from "./config";
import "./App.css";

type WorkSurface = "canvas" | "text";

const SHAPE_TYPES: { label: string; value: ShapeType }[] = [
  { label: "Circle", value: "circle" },
  { label: "Square", value: "square" },
  { label: "Triangle", value: "triangle" },
  { label: "Star", value: "star" },
];

interface DemoShowcaseStep {
  workflowId: DemoWorkflowId;
  label: string;
  detail: string;
}

interface StoryMoment {
  key: string;
  step: string;
  title: string;
  detail: string;
  status: string;
  active: boolean;
}

const STORY_MOMENT_COPY = [
  {
    key: "live-work",
    step: "01",
    title: "Real-time sharing",
    detail: "Notes, text, and ink converge across collaborators with no overwrites — the shared canvas stays in lockstep.",
  },
  {
    key: "private-revision",
    step: "02",
    title: "Branch + feedback loop",
    detail: "AI branches a private draft from shared state, then refines from your local feedback before anything lands.",
  },
  {
    key: "human-commit",
    step: "03",
    title: "AI-resolved tensions",
    detail: "An LLM judge flags cross-note contradictions and self-evolution; one click drafts a source-traced merge for human review.",
  },
];

const DEMO_SHOWCASE_STEPS: DemoShowcaseStep[] = [
  {
    workflowId: "mapContributions",
    label: "Map the room",
    detail: "Replace scattered source notes with one AI-generated map of contributors and signals.",
  },
  {
    workflowId: "createHandoff",
    label: "Ship the handoff",
    detail: "Convert concrete asks into checkable shared tasks with source context.",
  },
  {
    workflowId: "clarifyState",
    label: "Clarify the signal",
    detail: "Distill the messy board into one shared-state brief: past, now, future, and open questions.",
  },
  {
    workflowId: "highlightPriority",
    label: "Spotlight priority",
    detail: "Underline the priority that matters inside the exact source note people are reading.",
  },
];

// The four chip-driven workflows that live in the canvas chip row. Reconcile
// tensions is intentionally absent here: it is only triggered from the
// always-on Tensions section so the same path the AI judge surfaces is the
// only path that gets demoed.
const CHIP_DEMO_STEPS = DEMO_SHOWCASE_STEPS;

const FEEDBACK_LOOP_SHOWCASE = {
  label: "Feedback remix",
  detail: "Reject a private draft, feed it local direction, then regenerate a visibly sharper move.",
};

const TEXT_STRESS_TARGETS = [
  { label: "Stress 1k words", words: 1000 },
  { label: "Stress 10k words", words: 10000 },
];

const GUIDED_DEMO_BEATS = {
  source: 2600,
  drafting: 900,
  review: 5200,
  accepted: 3000,
  transition: 1400,
  final: 6200,
};

const TEXT_STRESS_SENTENCES = [
  "Fluid Framework documentation describes collaborative apps as clients loading the same shared container through a service.",
  "A Fluid container is the app boundary that holds shared objects for a collaboration session.",
  "Distributed Data Structures keep shared state available to connected clients and let an app choose the right collaboration granularity.",
  "SharedTree is presented as the recommended data structure for most new Fluid applications because it can model hierarchical data with schema.",
  "SharedString remains the text-focused data structure when live collaborative text editing is the core requirement.",
  "Azure Fluid Relay is the hosted service path for real-time collaboration on shared data models.",
  "Fluid apps keep their own user interface while the shared data model converges across connected collaborators.",
  "A text-heavy workspace can combine structured shared state with collaborative text so long drafts and canvas notes stay in one experience.",
];

const USER_NAME_STORAGE_KEY = "fluid-showcase-display-name";
const ROOM_NAME_STORAGE_KEY = "fluid-showcase-room-name";
const DEFAULT_PLAYGROUND_ROOM = "default";
const PLAYGROUND_SEED_ROOM_ID = "showcase-playground-v2";
const MAX_DISPLAY_NAME_LENGTH = 32;
const MAX_ROOM_NAME_LENGTH = 64;

function normalizeDisplayName(value: string | null | undefined): string | null {
  const normalized = value
    ?.split("")
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 32 && code !== 127 && char !== "<" && char !== ">";
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DISPLAY_NAME_LENGTH);
  return normalized || null;
}

function createGuestName(): string {
  const bytes = new Uint16Array(1);
  window.crypto?.getRandomValues?.(bytes);
  const suffix = 10000 + (bytes[0] % 90000);
  return `Guest ${suffix}`;
}

function isPlaygroundDemoRoute(): boolean {
  const demo = new URLSearchParams(window.location.search).get("demo")?.trim().toLowerCase();
  return demo === "playground";
}

function normalizeRoomName(value: string | null | undefined): string {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_ROOM_NAME_LENGTH);
  return normalized || DEFAULT_PLAYGROUND_ROOM;
}

function readInitialEntryRoom(): string {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get("doc");
  if (fromQuery) return normalizeRoomName(fromQuery);
  return DEFAULT_PLAYGROUND_ROOM;
}

function isDefaultPublicRoom(value: string): boolean {
  const normalized = normalizeRoomName(value);
  return normalized === DEFAULT_PLAYGROUND_ROOM || normalized === PLAYGROUND_SEED_ROOM_ID;
}

function shouldPromptForPublicEntry(): boolean {
  if (!isPlaygroundDemoRoute()) return false;
  const params = new URLSearchParams(window.location.search);
  return !normalizeDisplayName(params.get("user"));
}

function readUserNameFromUrl(): string {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = normalizeDisplayName(params.get("user"));
  if (fromQuery) {
    localStorage.setItem(USER_NAME_STORAGE_KEY, fromQuery);
    return fromQuery;
  }
  const stored = normalizeDisplayName(localStorage.getItem(USER_NAME_STORAGE_KEY));
  if (stored) return stored;
  const guestName = createGuestName();
  localStorage.setItem(USER_NAME_STORAGE_KEY, guestName);
  return guestName;
}

function joinPublicRoom(name: string, room: string) {
  const displayName = normalizeDisplayName(name);
  if (!displayName) return;
  const roomName = normalizeRoomName(room);
  localStorage.setItem(USER_NAME_STORAGE_KEY, displayName);
  localStorage.setItem(ROOM_NAME_STORAGE_KEY, roomName);
  const url = new URL(window.location.href);
  url.searchParams.set("demo", "playground");
  url.searchParams.set("user", displayName);
  url.searchParams.set("doc", roomName);
  if (url.hash) url.hash = "";
  window.location.href = url.toString();
}

function App() {
  const [userName] = useState(() => readUserNameFromUrl());
  const [entryDialogOpen] = useState(() => shouldPromptForPublicEntry());
  const [entryName, setEntryName] = useState(() => normalizeDisplayName(localStorage.getItem(USER_NAME_STORAGE_KEY)) ?? "");
  const [entryRoom, setEntryRoom] = useState(() => readInitialEntryRoom());
  const publicPlayground = isPlaygroundDemoRoute();

  const act2PanelRef = useRef<Act2PanelHandle>(null);
  const demoMenuRef = useRef<HTMLDivElement>(null);
  const [selectedShapeType, setSelectedShapeType] = useState<ShapeType>("circle");
  const [selectedShapeColor, setSelectedShapeColor] = useState("#64a7dd");
  const [inkMode, setInkMode] = useState(false);
  const [inkColor, setInkColor] = useState("#5c4bb8");
  const [deleteMode, setDeleteMode] = useState(false);
  const [areaSelectMode, setAreaSelectMode] = useState(false);
  const [selectedNoteIds, setSelectedNoteIds] = useState<string[]>([]);
  const [selectedStrokeIds, setSelectedStrokeIds] = useState<string[]>([]);
  const [aiPreviewEdits, setAiPreviewEdits] = useState<AiProposalEdit[] | null>(null);
  const previousPreviewEditsRef = useRef<AiProposalEdit[] | null>(null);
  const [aiReviewPhase, setAiReviewPhase] = useState<AiReviewPhase>("idle");
  const [feedbackMemoryCount, setFeedbackMemoryCount] = useState(0);
  const [aiPanelOpen, setAiPanelOpen] = useState(true);
  const [demoRunning, setDemoRunning] = useState(false);
  const [guidedDemoPaused, setGuidedDemoPausedState] = useState(false);
  const [demoStatus, setDemoStatus] = useState("Ready to play the collaboration demo.");
  const [demoMenuOpen, setDemoMenuOpen] = useState(false);
  const [activeSurface, setActiveSurface] = useState<WorkSurface>("canvas");
  const [localCaret, setLocalCaret] = useState<CaretPresence | null>(null);
  const [liveConflictPreviewId, setLiveConflictPreviewId] = useState<string | null>(null);
  const [liveConflictProposal, setLiveConflictProposal] = useState<{ suggestionId: string; edits: AiProposalEdit[] } | null>(null);
  const [liveConflictGenerating, setLiveConflictGenerating] = useState(false);
  const [pinnedLiveConflictSuggestion, setPinnedLiveConflictSuggestion] = useState<LiveSemanticConflictSuggestion | null>(null);
  const [dismissedLiveConflictId, setDismissedLiveConflictId] = useState<string | null>(null);
  const [tensions, setTensions] = useState<SemanticTension[]>([]);
  const [tensionsLoading, setTensionsLoading] = useState(false);
  const [tensionsError, setTensionsError] = useState<string | null>(null);
  const [tensionsRefreshNonce, setTensionsRefreshNonce] = useState(0);
  const guidedDemoPausedRef = useRef(false);
  const guidedDemoAdvanceRef = useRef<(() => void) | null>(null);
  const guidedDemoCancelledRef = useRef(false);
  const aiProvider = useMemo(() => new OpenAiCompatibleAiProvider(), []);

  const enterInkMode = () => { setInkMode((value) => !value); setDeleteMode(false); setAreaSelectMode(false); };
  const enterDeleteMode = () => { setDeleteMode((value) => !value); setInkMode(false); setAreaSelectMode(false); };
  const enterAreaSelectMode = () => { setAreaSelectMode((value) => !value); setInkMode(false); setDeleteMode(false); };
  const applyPublicEntry = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextName = normalizeDisplayName(entryName);
    if (!nextName) return;
    joinPublicRoom(nextName, entryRoom);
  };
  const updateAiPreview = useCallback((edits: AiProposalEdit[] | null) => {
    const previous = previousPreviewEditsRef.current;
    previousPreviewEditsRef.current = edits;
    if (edits?.length) setLiveConflictPreviewId(null);
    setAiPreviewEdits(edits);
    if (!previous && edits?.length) {
      scheduleCanvasFocus("preview", edits);
    }
  }, []);

  const {
    doc, online, setOnline, ws, docId, isResetRoom,
    addNote, updateNote, deleteNote, setNoteText, setText, clearText,
    addShape, deleteShape, moveItem,
    addStroke, deleteStroke, clearCanvas,
    applyAiProposal,
    toggleTask,
    undo, redo, canUndo, canRedo,
  } = useCanvas(userName);

  const { others, myColor, sendCursor, sendCaret, sendSelection } = usePresence(userName, ws);
  const otherUsers = useMemo(() => [...others.values()], [others]);
  const handleCaretChange = useCallback((caret: CaretPresence | null) => {
    setLocalCaret(caret);
    sendCaret(caret);
  }, [sendCaret]);
  // Broadcast our selected note ids whenever the local selection changes (and
  // whenever the websocket reconnects, so peers that arrive later still see
  // the ring). This is the only \"who-is-looking-at-what\" signal apart from
  // mouse cursors and typing carets.
  useEffect(() => {
    sendSelection(selectedNoteIds);
  }, [selectedNoteIds, sendSelection]);
  // The relay never replays presence to a peer that connects later, so each
  // client must re-announce its current selection + caret the instant its
  // socket (re)opens. Without this, a peer that opens a link after us — or
  // after any reconnect — sees no ring and no remote caret until we happen to
  // move, which reads as \"presence doesn't work.\" Refs keep the listener
  // stable so it only re-binds when the socket itself changes.
  const selectedNoteIdsRef = useRef(selectedNoteIds);
  const localCaretRef = useRef(localCaret);
  // Keep the announce refs in sync AFTER render (not during it). Writing
  // ref.current in the render body trips react-hooks/refs and is unsafe under
  // concurrent rendering; an effect runs after commit and is still well before
  // any async socket "open" event fires announce().
  useEffect(() => {
    selectedNoteIdsRef.current = selectedNoteIds;
    localCaretRef.current = localCaret;
  }, [selectedNoteIds, localCaret]);

  useEffect(() => {
    if (!isResetRoom) return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has("reset")) return;
    url.searchParams.delete("reset");
    window.history.replaceState(null, "", url.toString());
  }, [isResetRoom]);

  useEffect(() => {
    if (!ws) return;
    const announce = () => {
      sendSelection(selectedNoteIdsRef.current);
      sendCaret(localCaretRef.current);
    };
    if (ws.readyState === WebSocket.OPEN) announce();
    ws.addEventListener("open", announce);
    return () => ws.removeEventListener("open", announce);
  }, [ws, sendSelection, sendCaret]);
  const selectedNotes = selectedNoteIds
    .map((id) => doc.notes.find((note) => note.id === id))
    .filter((note): note is StickyNote => Boolean(note));
  const selectedStrokeCount = selectedStrokeIds.filter((id) => doc.strokes?.some((stroke) => stroke.id === id)).length;
  const textStressStats = useMemo(() => getTextStressStats(doc.text ?? ""), [doc.text]);
  const textCarets = useMemo(
    () => otherUsers
      .filter((user) => user.caret?.surface === "text")
      .map((user) => ({
        userName: user.userName,
        color: user.color,
        offset: user.caret?.surface === "text" ? user.caret.offset : 0,
      })),
    [otherUsers],
  );
  const detectedLiveConflictSuggestion = useMemo(() => buildLiveSemanticConflictSuggestion({
    notes: doc.notes,
    userName,
    localCaret,
    others: otherUsers,
    activeNoteId: selectedNoteIds.length === 1 ? selectedNoteIds[0] : null,
  }), [doc.notes, userName, localCaret, otherUsers, selectedNoteIds]);
  const [aiEnrichedTension, setAiEnrichedTension] = useState<{ id: string; tension: string } | null>(null);
  const baseLiveConflictSuggestion = detectedLiveConflictSuggestion ?? pinnedLiveConflictSuggestion;
  const liveConflictSuggestion = useMemo(() => {
    if (!baseLiveConflictSuggestion) return null;
    if (aiEnrichedTension && aiEnrichedTension.id === baseLiveConflictSuggestion.id) {
      return { ...baseLiveConflictSuggestion, tension: aiEnrichedTension.tension };
    }
    return baseLiveConflictSuggestion;
  }, [baseLiveConflictSuggestion, aiEnrichedTension]);
  const liveConflictVisible = Boolean(liveConflictSuggestion && dismissedLiveConflictId !== liveConflictSuggestion.id);
  useEffect(() => {
    if (!AI_LIVE_ENABLED) return;
    if (!liveConflictVisible) return;
    const suggestion = detectedLiveConflictSuggestion;
    if (!suggestion) return;
    if (aiEnrichedTension?.id === suggestion.id) return;
    const note = doc.notes.find((item) => item.id === suggestion.noteId);
    if (!note) return;
    const controller = new AbortController();
    let cancelled = false;
    void (async () => {
      const enriched = await enrichTensionWithAi(note.text, aiProvider, { signal: controller.signal });
      if (cancelled) return;
      if (enriched) setAiEnrichedTension({ id: suggestion.id, tension: enriched });
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [liveConflictVisible, detectedLiveConflictSuggestion, doc.notes, aiProvider, aiEnrichedTension]);
  // Cross-note semantic tension detection. Runs once when the demo board is
  // loaded with at least 2 notes, then on explicit Rescan. Uses the LLM as
  // judge: the model receives all sticky notes and returns the material
  // disagreements (cross-author contradictions and same-author priority drift).
  const tensionInputSignature = useMemo(
    () => doc.notes
      .map((note) => `${note.id}|${(note.text ?? "").length}|${note.author ?? ""}`)
      .join("\n"),
    [doc.notes],
  );
  const tensionScanEligible = AI_LIVE_ENABLED && doc.notes.length >= 2;
  useEffect(() => {
    if (!tensionScanEligible) return;
    const controller = new AbortController();
    let cancelled = false;
    void (async () => {
      setTensionsLoading(true);
      setTensionsError(null);
      try {
        const detected = await detectSemanticTensions(
          doc.notes.map(({ id, text, author, createdAt }) => ({ id, text, author, createdAt })),
          aiProvider,
          { signal: controller.signal },
        );
        if (cancelled) return;
        setTensions(detected);
      } catch (error) {
        if (cancelled) return;
        setTensionsError(error instanceof Error ? error.message : "Tension scan failed.");
      } finally {
        if (!cancelled) setTensionsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
    // `tensionInputSignature` already captures the meaningful change axis on
    // doc.notes; the nonce lets the user trigger a manual rescan without
    // mutating the board. aiProvider is stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tensionInputSignature, tensionsRefreshNonce, aiProvider, tensionScanEligible]);
  const effectiveTensions = tensionScanEligible ? tensions : [];
  const refreshTensions = useCallback(() => {
    setTensionsRefreshNonce((value) => value + 1);
  }, []);
  const liveConflictProposalEdits = liveConflictProposal && liveConflictProposal.suggestionId === liveConflictSuggestion?.id
    ? liveConflictProposal.edits
    : null;
  const liveConflictPreviewActive = Boolean(
    liveConflictSuggestion &&
    liveConflictPreviewId === liveConflictSuggestion.id &&
    liveConflictProposalEdits,
  );
  const canvasPreviewEdits = aiPreviewEdits ?? (liveConflictPreviewActive ? liveConflictProposalEdits : null);
  const storyMoments = getStoryMoments({
    userCount: 1 + others.size,
    online,
    surface: activeSurface,
    textWords: textStressStats.words,
    aiReviewPhase,
    feedbackMemoryCount,
    liveConflictVisible,
    liveConflictPreviewActive,
  });
  const selectNotesAndClearStrokes = useCallback((ids: string[]) => {
    setSelectedNoteIds(ids);
    if (ids.length > 0) setSelectedStrokeIds([]);
  }, []);

  const selectStrokesAndClearNotes = useCallback((ids: string[]) => {
    setSelectedStrokeIds(ids);
    if (ids.length > 0) setSelectedNoteIds([]);
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedNoteIds([]);
    setSelectedStrokeIds([]);
  }, []);

  const switchSurface = useCallback((surface: WorkSurface) => {
    setActiveSurface(surface);
    setInkMode(false);
    setDeleteMode(false);
    setAreaSelectMode(false);
    if (surface === "text") {
      clearSelection();
      setLiveConflictPreviewId(null);
      setLiveConflictProposal(null);
      setPinnedLiveConflictSuggestion(null);
    }
  }, [clearSelection]);

  const addToolbarNote = () => {
    setInkMode(false);
    setDeleteMode(false);
    setAreaSelectMode(false);
    setSelectedStrokeIds([]);
    addNote(120 + Math.random() * 360, 120 + Math.random() * 260);
  };

  const deleteNoteAndClearSelection = (id: string) => {
    deleteNote(id);
    setSelectedNoteIds((current) => current.filter((selectedId) => selectedId !== id));
  };

  const deleteStrokeAndClearSelection = useCallback((id: string) => {
    deleteStroke(id);
    setSelectedStrokeIds((current) => current.filter((selectedId) => selectedId !== id));
  }, [deleteStroke]);

  const clearCanvasAndSelection = () => {
    clearCanvas();
    clearSelection();
    setLiveConflictPreviewId(null);
    setLiveConflictProposal(null);
    setPinnedLiveConflictSuggestion(null);
    setDismissedLiveConflictId(null);
  };

  const resetCurrentPublicRoom = useCallback(() => {
    const isDefaultRoom = isDefaultPublicRoom(docId);
    const normalizedRoom = isDefaultRoom ? DEFAULT_PLAYGROUND_ROOM : normalizeRoomName(docId);
    const confirmed = window.confirm(
      isDefaultRoom
        ? "Reset this shared room to the starter notes? Everyone in this room will see the reset."
        : "Reset this shared room to a blank canvas? Everyone in this room will see the reset.",
    );
    if (!confirmed) return;

    const url = new URL(window.location.href);
    url.searchParams.set("demo", "playground");
    url.searchParams.set("user", userName);
    url.searchParams.set("doc", normalizedRoom);
    url.searchParams.set("reset", "1");
    window.location.assign(url.toString());
  }, [docId, userName]);

  const acceptAiProposalAndFocus = useCallback((edits: AiProposalEdit[]) => {
    const applied = applyAiProposal(edits);
    if (applied) scheduleCanvasFocus("accepted", edits);
    return applied;
  }, [applyAiProposal]);

  const prepareDemoRun = useCallback(() => {
    setDemoMenuOpen(false);
    setInkMode(false);
    setDeleteMode(false);
    setAreaSelectMode(false);
    setLiveConflictPreviewId(null);
    setLiveConflictProposal(null);
    setPinnedLiveConflictSuggestion(null);
    setDismissedLiveConflictId(null);
    clearSelection();
  }, [clearSelection]);

  const setGuidedDemoPaused = useCallback((paused: boolean) => {
    guidedDemoPausedRef.current = paused;
    setGuidedDemoPausedState(paused);
    if (!paused) {
      guidedDemoAdvanceRef.current?.();
      guidedDemoAdvanceRef.current = null;
    }
  }, []);

  const advanceGuidedDemo = useCallback(() => {
    setGuidedDemoPaused(false);
    guidedDemoAdvanceRef.current?.();
    guidedDemoAdvanceRef.current = null;
  }, [setGuidedDemoPaused]);

  const stopGuidedDemo = useCallback(() => {
    guidedDemoCancelledRef.current = true;
    setGuidedDemoPaused(false);
    guidedDemoAdvanceRef.current?.();
    guidedDemoAdvanceRef.current = null;
    setDemoRunning(false);
    setDemoStatus("Guided demo stopped. The board state was left as-is for inspection.");
  }, [setGuidedDemoPaused]);

  const loadTextStressSample = useCallback((targetWords: number) => {
    prepareDemoRun();
    setText(buildTextStressSample(targetWords));
    setActiveSurface("text");
    setDemoStatus(`Loaded ${targetWords.toLocaleString()}-word shared text stress sample.`);
  }, [prepareDemoRun, setText]);

  const clearTextStressSample = useCallback(() => {
    clearText();
    setActiveSurface("text");
    setDemoStatus("Cleared the shared text stress sample.");
  }, [clearText]);

  const runDemoStep = useCallback(async (step: DemoShowcaseStep, autoAccept: boolean) => {
    if (demoRunning) return;
    if (!AI_LIVE_ENABLED) {
      setDemoStatus(HOSTED_PLAYGROUND_NOTICE);
      return;
    }
    prepareDemoRun();
    setActiveSurface("canvas");
    setDemoRunning(true);
    setDemoStatus(`${autoAccept ? "Running" : "Previewing"} ${step.label}...`);

    try {
      const ok = await act2PanelRef.current?.runWorkflowDemo({
        workflowId: step.workflowId,
        label: step.label,
        autoAccept,
        forceWholeCanvas: true,
        previewMs: autoAccept ? 1200 : 0,
      });
      setDemoStatus(
        ok
          ? `${step.label} ${autoAccept ? "accepted into the board" : "preview is ready"}.`
          : `Could not run ${step.label}. Try resetting the co-creation arc.`,
      );
    } catch {
      setDemoStatus(`Could not run ${step.label}. Try resetting the co-creation arc.`);
    } finally {
      setDemoRunning(false);
    }
  }, [demoRunning, prepareDemoRun]);

  const runDemoFeedbackLoop = useCallback(async (autoAccept: boolean) => {
    if (demoRunning) return;
    if (!AI_LIVE_ENABLED) {
      setDemoStatus(HOSTED_PLAYGROUND_NOTICE);
      return;
    }
    prepareDemoRun();
    setActiveSurface("canvas");
    setDemoRunning(true);
    setDemoStatus(`${autoAccept ? "Running" : "Previewing"} ${FEEDBACK_LOOP_SHOWCASE.label}...`);

    try {
      const ok = await act2PanelRef.current?.runFeedbackLoopDemo({
        autoAccept,
        forceWholeCanvas: true,
        previewMs: autoAccept ? 1000 : 900,
      });
      setDemoStatus(
        ok
          ? `${FEEDBACK_LOOP_SHOWCASE.label} ${autoAccept ? "accepted into the board" : "revised preview is ready"}.`
          : "Could not run Feedback remix. Try resetting the co-creation arc.",
      );
    } catch {
      setDemoStatus("Could not run Feedback remix. Try resetting the co-creation arc.");
    } finally {
      setDemoRunning(false);
    }
  }, [demoRunning, prepareDemoRun]);

  const previewLiveConflictMerge = useCallback(async (suggestion: LiveSemanticConflictSuggestion) => {
    if (!AI_LIVE_ENABLED) {
      setDemoStatus(HOSTED_PLAYGROUND_NOTICE);
      return;
    }
    if (aiPreviewEdits?.length || liveConflictGenerating) return;
    setLiveConflictGenerating(true);
    setPinnedLiveConflictSuggestion(suggestion);
    setLiveConflictPreviewId(null);
    setLiveConflictProposal(null);
    setDismissedLiveConflictId(null);
    setDemoStatus("Asking real AI to merge the live conflict...");

    try {
      const response = await aiProvider.propose({
        instruction: buildLiveConflictMergeInstruction(suggestion),
        document: createAiRequestSnapshot(doc, {
          surfaceMode: "canvas",
          targetNoteIds: [suggestion.noteId],
          includeTasks: false,
        }),
        target: { kind: "note", id: suggestion.noteId },
      });
      const edits = normalizeLiveConflictEdits(response.edits, suggestion, response.summary);
      setLiveConflictProposal({ suggestionId: suggestion.id, edits });
      setLiveConflictPreviewId(suggestion.id);
      setDemoStatus("Real AI live merge preview is private until Accept.");
      scheduleCanvasFocus("preview", edits);
    } catch (error) {
      setDemoStatus(error instanceof Error ? `Live merge failed: ${error.message}` : "Live merge failed. Check the AI proxy.");
    } finally {
      setLiveConflictGenerating(false);
    }
  }, [aiPreviewEdits, aiProvider, doc, liveConflictGenerating]);

  const acceptLiveConflictMerge = useCallback((suggestion: LiveSemanticConflictSuggestion) => {
    const edits = liveConflictProposal?.suggestionId === suggestion.id ? liveConflictProposal.edits : null;
    if (!edits?.length) {
      setDemoStatus("Generate the real AI merge preview before accepting.");
      return;
    }
    const accepted = acceptAiProposalAndFocus(edits);
    if (!accepted) {
      setDemoStatus("The merge preview no longer matches the shared note. Preview the merge again, then accept.");
      return;
    }
    setLiveConflictPreviewId(null);
    setLiveConflictProposal(null);
    setPinnedLiveConflictSuggestion(null);
    setDismissedLiveConflictId(suggestion.id);
    setAiReviewPhase("accepted");
    setDemoStatus("Live edit conflict merged into the shared note.");
  }, [acceptAiProposalAndFocus, liveConflictProposal]);

  const dismissLiveConflictMerge = useCallback((suggestion: LiveSemanticConflictSuggestion) => {
    setDismissedLiveConflictId(suggestion.id);
    if (liveConflictPreviewId === suggestion.id) setLiveConflictPreviewId(null);
    if (liveConflictProposal?.suggestionId === suggestion.id) setLiveConflictProposal(null);
    setPinnedLiveConflictSuggestion(null);
    setDemoStatus("Live edit conflict suggestion dismissed.");
  }, [liveConflictPreviewId, liveConflictProposal]);

  const runGuidedDemo = useCallback(async () => {
    if (demoRunning) return;
    if (!AI_LIVE_ENABLED) {
      setDemoMenuOpen(false);
      setDemoStatus(HOSTED_PLAYGROUND_NOTICE);
      return;
    }
    prepareDemoRun();
    setActiveSurface("canvas");
    setDemoRunning(true);
    guidedDemoCancelledRef.current = false;
    setGuidedDemoPaused(false);

    const presenterBeat = async (
      message: string,
      region: "story" | "canvas" | "review" | "text" | "liveConflict",
      durationMs: number,
    ): Promise<boolean> => {
      if (guidedDemoCancelledRef.current) return false;
      setDemoStatus(message);
      window.setTimeout(() => focusDemoRegion(region), 80);
      return waitForGuidedBeat(
        durationMs,
        guidedDemoPausedRef,
        guidedDemoAdvanceRef,
        guidedDemoCancelledRef,
      );
    };

    const runGuidedWorkflow = async (
      step: DemoShowcaseStep,
      index: number,
      total: number,
      acceptAfterReview: boolean,
      finalPreview = false,
    ): Promise<boolean> => {
      const sourceReady = await presenterBeat(
        `Step ${index}/${total}: reading the shared board before ${step.label}.`,
        "canvas",
        GUIDED_DEMO_BEATS.source,
      );
      if (!sourceReady) return false;

      setDemoStatus(`Step ${index}/${total}: calling the live model for ${step.label}.`);
      focusDemoRegion("review");
      const ok = await act2PanelRef.current?.runWorkflowDemo({
        workflowId: step.workflowId,
        label: step.label,
        autoAccept: false,
        forceWholeCanvas: true,
        previewMs: 0,
      });
      if (!ok || guidedDemoCancelledRef.current) return false;

      const reviewed = await presenterBeat(
        finalPreview
          ? `Step ${index}/${total}: ${step.label} is private. Stop here to show the human review gate.`
          : `Step ${index}/${total}: review the private ${step.label} proposal before sharing it.`,
        "review",
        finalPreview ? GUIDED_DEMO_BEATS.final : GUIDED_DEMO_BEATS.review,
      );
      if (!reviewed || finalPreview) return reviewed;

      if (acceptAfterReview) {
        const accepted = act2PanelRef.current?.acceptCurrentProposal();
        if (!accepted) return false;
        const acceptedBeat = await presenterBeat(
          `Step ${index}/${total}: ${step.label} is now committed into shared state.`,
          "canvas",
          GUIDED_DEMO_BEATS.accepted,
        );
        if (!acceptedBeat) return false;
      }

      return presenterBeat(
        `Step ${index}/${total}: moving to the next user-visible moment.`,
        "story",
        GUIDED_DEMO_BEATS.transition,
      );
    };

    try {
      const autoplaySteps = [
        DEMO_SHOWCASE_STEPS.find((step) => step.workflowId === "mapContributions"),
        DEMO_SHOWCASE_STEPS.find((step) => step.workflowId === "createHandoff"),
      ].filter((step): step is DemoShowcaseStep => Boolean(step));
      const priorityStep = DEMO_SHOWCASE_STEPS.find((step) => step.workflowId === "highlightPriority");
      const totalSteps = autoplaySteps.length + 3;

      for (const [index, step] of autoplaySteps.entries()) {
        const ok = await runGuidedWorkflow(step, index + 1, totalSteps, true);
        if (!ok) {
          setDemoStatus(`Stopped at ${step.label}. Try resetting the co-creation arc.`);
          return;
        }
      }

      const feedbackIntro = await presenterBeat(
        `Step ${autoplaySteps.length + 1}/${totalSteps}: now reject a broad draft and regenerate with local feedback.`,
        "review",
        GUIDED_DEMO_BEATS.source,
      );
      if (!feedbackIntro) return;
      const feedbackOk = await act2PanelRef.current?.runFeedbackLoopDemo({
        autoAccept: false,
        forceWholeCanvas: true,
        previewMs: GUIDED_DEMO_BEATS.transition,
      });
      if (!feedbackOk) {
        setDemoStatus("Stopped at Feedback remix. Try resetting the co-creation arc.");
        return;
      }
      const feedbackReviewed = await presenterBeat(
        `Step ${autoplaySteps.length + 1}/${totalSteps}: the regenerated draft reflects local feedback, still private until Accept.`,
        "review",
        GUIDED_DEMO_BEATS.review,
      );
      if (!feedbackReviewed) return;
      const feedbackAccepted = act2PanelRef.current?.acceptCurrentProposal();
      if (!feedbackAccepted) return;
      const feedbackCommitted = await presenterBeat(
        `Step ${autoplaySteps.length + 1}/${totalSteps}: the refined shared-state brief is committed.`,
        "canvas",
        GUIDED_DEMO_BEATS.accepted,
      );
      if (!feedbackCommitted) return;

      // Step N: AI-judged tension reconcile. Uses the LLM judge's flagged
      // tensions (top one) instead of a generic whole-canvas semantic merge,
      // so the guided demo stays consistent with the Tensions section users
      // see in the panel.
      const tensionStepIndex = autoplaySteps.length + 2;
      const tensionIntroBeat = await presenterBeat(
        `Step ${tensionStepIndex}/${totalSteps}: the AI judge already flagged cross-note tensions in AI Review. Reconciling the top one with source-traced notes.`,
        "review",
        GUIDED_DEMO_BEATS.source,
      );
      if (!tensionIntroBeat) return;
      const tensionReady = await act2PanelRef.current?.runTensionReconcileDemo({
        autoAccept: false,
        previewMs: GUIDED_DEMO_BEATS.transition,
      });
      if (!tensionReady) {
        const skipBeat = await presenterBeat(
          `Step ${tensionStepIndex}/${totalSteps}: no cross-note tensions surfaced this run. Skipping reconcile.`,
          "review",
          GUIDED_DEMO_BEATS.transition,
        );
        if (!skipBeat) return;
      } else {
        const tensionReviewed = await presenterBeat(
          `Step ${tensionStepIndex}/${totalSteps}: source-traced reconcile is private. Reviewer can accept or discard.`,
          "review",
          GUIDED_DEMO_BEATS.review,
        );
        if (!tensionReviewed) return;
        const tensionAccepted = act2PanelRef.current?.acceptCurrentProposal();
        if (tensionAccepted) {
          const tensionCommitted = await presenterBeat(
            `Step ${tensionStepIndex}/${totalSteps}: the reconciled brief is now shared, with source notes still on the board.`,
            "canvas",
            GUIDED_DEMO_BEATS.accepted,
          );
          if (!tensionCommitted) return;
        }
      }

      if (!priorityStep) {
        setDemoStatus("Full demo complete: shared board now contains mapped voices, tasks, revised state, and the reconciled brief.");
        return;
      }

      const ok = await runGuidedWorkflow(priorityStep, totalSteps, totalSteps, false, true);
      setDemoStatus(
        ok
          ? "Guided demo ready: summaries, tasks, revised state, and the reconciled brief are shared; priority preview waits for final human review."
          : `Stopped at ${priorityStep.label}. Try resetting the co-creation arc.`,
      );
    } catch {
      setDemoStatus("Demo run stopped. Try resetting the co-creation arc.");
    } finally {
      guidedDemoCancelledRef.current = false;
      setGuidedDemoPaused(false);
      setDemoRunning(false);
    }
  }, [demoRunning, prepareDemoRun, setGuidedDemoPaused]);

  const resetDemo = useCallback(() => {
    setDemoMenuOpen(false);
    setDemoStatus("Reloading the co-creation arc...");
    const url = new URL(window.location.href);
    url.searchParams.set("demo", "playground");
    url.searchParams.set("reset", "1");
    url.searchParams.delete("doc");
    window.location.assign(url.toString());
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape" && demoMenuOpen) {
        event.preventDefault();
        setDemoMenuOpen(false);
        return;
      }

      if (event.key === "Escape" && (selectedNoteIds.length > 0 || selectedStrokeIds.length > 0)) {
        event.preventDefault();
        clearSelection();
        return;
      }

      const target = event.target as HTMLElement | null;
      if (
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "INPUT" ||
        target?.isContentEditable
      ) {
        return;
      }

      if (selectedStrokeIds.length === 0) return;
      if (event.key !== "Delete" && event.key !== "Backspace") return;

      event.preventDefault();
      selectedStrokeIds.forEach((id) => deleteStroke(id));
      clearSelection();
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [clearSelection, deleteStroke, demoMenuOpen, selectedNoteIds.length, selectedStrokeIds]);

  useEffect(() => {
    if (!demoMenuOpen) return;

    const handler = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target || demoMenuRef.current?.contains(target)) return;
      setDemoMenuOpen(false);
    };

    window.addEventListener("pointerdown", handler);
    return () => window.removeEventListener("pointerdown", handler);
  }, [demoMenuOpen]);

  return (
    <div className="app-shell">
      {entryDialogOpen && (
        <div className="entry-dialog" role="presentation">
          <form
            className="entry-dialog__panel"
            onSubmit={applyPublicEntry}
            role="dialog"
            aria-modal="true"
            aria-labelledby="entry-dialog-title"
          >
            <div className="entry-dialog__header">
              <span className="entry-dialog__eyebrow">Public showcase</span>
              <h1 id="entry-dialog-title">Please enter your name</h1>
              <p>Use default for the open room, or type a room name and share it with others.</p>
            </div>

            <label className="entry-dialog__field" htmlFor="entry-display-name">
              <span>Name</span>
              <input
                id="entry-display-name"
                type="text"
                value={entryName}
                maxLength={MAX_DISPLAY_NAME_LENGTH}
                placeholder="Your display name"
                autoFocus
                onChange={(event) => setEntryName(event.target.value)}
              />
            </label>

            <label className="entry-dialog__field" htmlFor="entry-room-name">
              <span>Room name</span>
              <input
                id="entry-room-name"
                type="text"
                value={entryRoom}
                maxLength={MAX_ROOM_NAME_LENGTH}
                placeholder={DEFAULT_PLAYGROUND_ROOM}
                onChange={(event) => setEntryRoom(event.target.value)}
              />
            </label>

            <p className="entry-dialog__hint">
              Matching room names open the same shared canvas.
            </p>
            <p className="entry-dialog__room-preview">
              Room to join: <strong>{normalizeRoomName(entryRoom)}</strong>
            </p>

            <button
              className="entry-dialog__submit"
              type="submit"
              disabled={!normalizeDisplayName(entryName)}
            >
              {normalizeRoomName(entryRoom) === DEFAULT_PLAYGROUND_ROOM
                ? "Join default room"
                : "Create or join room"}
            </button>
          </form>
        </div>
      )}
      <header className="topbar">
        <div className="brand-block">
          <strong className="brand">Shared-state Canvas</strong>
          <span className="brand-subtitle">Edit live. Branch privately. Merge semantically.</span>
        </div>

        <div className="toolbar-spacer" />

        <div className="room-pill" title={`Current shared room: ${docId}. People only sync when they use the same room name.`}>
          <span>Room</span>
          <strong>{docId}</strong>
        </div>

        {publicPlayground && (
          <button
            type="button"
            className="toolbar-button toolbar-button--muted reset-room-button"
            onClick={resetCurrentPublicRoom}
            title={isDefaultPublicRoom(docId)
              ? "Reset default room to the starter notes"
              : "Reset this room to a blank canvas"}
          >
            Reset room
          </button>
        )}

        <div className="presence-row" aria-label="Presence">
          <div className="current-user-pill" title={`You entered as ${userName}`}>
            <span className="presence-dot current-user-pill__avatar" style={{ background: myColor }}>
              {userName[0]}
            </span>
            <span className="current-user-pill__name">{userName}</span>
          </div>
          {[...others.values()].map((user) => (
            <div
              key={user.userName}
              className="presence-dot presence-dot--other"
              style={{ background: user.color }}
              title={user.userName}
            >
              {user.userName[0]}
            </div>
          ))}
        </div>

        {!publicPlayground && (
          <div
            className={demoMenuOpen ? "demo-menu demo-menu--open" : "demo-menu"}
            ref={demoMenuRef}
          >
            <button
              type="button"
              className={demoRunning ? "toolbar-button toolbar-button--ai toolbar-button--active demo-menu__trigger" : "toolbar-button toolbar-button--ai demo-menu__trigger"}
              aria-label="Open demo story controls"
              aria-expanded={demoMenuOpen}
              aria-controls="demo-menu-panel"
              onClick={() => setDemoMenuOpen((open) => !open)}
            >
              Demo
            </button>
            {demoMenuOpen && (
              <div className="demo-menu__panel" id="demo-menu-panel" aria-label="Demo controls">
              <div className="demo-menu__header">
                <span>Demo menu</span>
                <strong>Choose the demo path</strong>
              </div>
              <button
                type="button"
                className="demo-menu__primary"
                  onClick={() => { void runGuidedDemo(); }}
                disabled={demoRunning || !AI_LIVE_ENABLED}
                title={AI_LIVE_ENABLED ? "Presenter-paced walkthrough: source content → AI Review → private preview → accepted shared state." : HOSTED_PLAYGROUND_NOTICE}
              >
                {AI_LIVE_ENABLED ? "Start guided demo" : "AI demo backend required"}
              </button>
              {!AI_LIVE_ENABLED && (
                <p className="demo-menu__note">{HOSTED_PLAYGROUND_NOTICE}</p>
              )}
              <div className="demo-menu__section">
                <span>Live collaboration baseline</span>
              </div>
              <div className="demo-menu__grid">
                {TEXT_STRESS_TARGETS.map((target) => (
                  <button
                    key={target.words}
                    type="button"
                    onClick={() => loadTextStressSample(target.words)}
                    disabled={demoRunning}
                    title={`Load a ${target.words.toLocaleString()}-word shared text sample into the CRDT text field.`}
                  >
                    {target.label}
                  </button>
                ))}
              </div>
              <div className="demo-menu__section">
                <span>Chip-driven workflows</span>
              </div>
              <div className="demo-menu__grid">
                {CHIP_DEMO_STEPS.map((step) => (
                  <button
                    key={step.workflowId}
                    type="button"
                    onClick={() => { void runDemoStep(step, false); }}
                    disabled={demoRunning || !AI_LIVE_ENABLED}
                    title={AI_LIVE_ENABLED ? step.detail : HOSTED_PLAYGROUND_NOTICE}
                  >
                    Preview {step.label}
                  </button>
                ))}
              </div>
              <div className="demo-menu__section">
                <span>Feedback remix</span>
              </div>
              <div className="demo-menu__grid">
                <button
                  type="button"
                  onClick={() => { void runDemoFeedbackLoop(false); }}
                  disabled={demoRunning || !AI_LIVE_ENABLED}
                  title={AI_LIVE_ENABLED ? FEEDBACK_LOOP_SHOWCASE.detail : HOSTED_PLAYGROUND_NOTICE}
                >
                  Preview feedback remix
                </button>
              </div>
              <div className="demo-menu__section">
                <span>AI-judged tensions</span>
                <p>{AI_LIVE_ENABLED ? "Use the Tensions section in AI Review -> click a reconcile action on a card." : "AI-judged tension detection turns on when a demo AI backend is configured."}</p>
              </div>
              <button
                type="button"
                className="demo-menu__reset"
                  onClick={resetDemo}
                disabled={demoRunning}
              >
                Reset the arc
              </button>
              <p className="demo-menu__status" aria-live="polite">{demoStatus}</p>
              </div>
            )}
          </div>
        )}

        <button
          type="button"
          className="toolbar-button toolbar-button--muted"
          onClick={undo}
          disabled={!canUndo}
          title="Undo (Ctrl+Z)"
        >
          Undo
        </button>
        <button
          type="button"
          className="toolbar-button toolbar-button--muted"
          onClick={redo}
          disabled={!canRedo}
          title="Redo (Ctrl+Y)"
        >
          Redo
        </button>

        <div className="toolbar-group toolbar-group--status">
          <span className="toolbar-eyebrow">Sync</span>
          <button
            type="button"
            className={online ? "toolbar-button toolbar-button--online" : "toolbar-button toolbar-button--offline"}
            onClick={() => setOnline((value) => !value)}
            aria-label={online ? "Turn sync offline" : "Turn sync online"}
          >
            <span className={online ? "state-dot state-dot--online" : "state-dot state-dot--offline"} />
            {online ? "Online" : "Offline"}
          </button>
        </div>
      </header>

      <main className={aiPanelOpen ? "workbench" : "workbench workbench--ai-collapsed"}>
        <section className="stage" aria-label="Shared document">
          <header className="stage-header">
            <div>
              <h1>AI proposes. People commit. The canvas stays live.</h1>
            </div>
          </header>

          <DemoStoryRail moments={storyMoments} />

          {(demoRunning || !demoStatus.startsWith("Ready to play")) && (
            <div className={demoRunning ? "demo-live-status demo-live-status--running" : "demo-live-status"} aria-live="polite">
              <span>{demoRunning ? "Demo running" : "Demo status"}</span>
              <strong>{demoStatus}</strong>
              {demoRunning && (
                <div className="demo-live-status__actions" aria-label="Guided demo controls">
                  <button type="button" onClick={() => setGuidedDemoPaused(!guidedDemoPaused)}>
                    {guidedDemoPaused ? "Resume" : "Pause"}
                  </button>
                  <button type="button" onClick={advanceGuidedDemo}>
                    Next
                  </button>
                  <button type="button" onClick={stopGuidedDemo}>
                    Stop
                  </button>
                </div>
              )}
            </div>
          )}

          {!AI_LIVE_ENABLED && (
            <div className="mode-banner mode-banner--hosted">
              <span><strong>Public showcase.</strong> Live collaboration is enabled; AI generation turns on when a demo AI backend is configured.</span>
            </div>
          )}

          {AI_LIVE_ENABLED && liveConflictSuggestion && liveConflictVisible && (
            <LiveConflictPanel
              suggestion={liveConflictSuggestion}
              previewActive={liveConflictPreviewActive}
              previewBlocked={Boolean(aiPreviewEdits?.length) || liveConflictGenerating}
              generating={liveConflictGenerating}
              onPreview={previewLiveConflictMerge}
              onAccept={acceptLiveConflictMerge}
              onDismiss={dismissLiveConflictMerge}
            />
          )}

          <div className="workspace-strip" aria-label="Workspace tools and AI focus">
            <div className="surface-switch" aria-label="Workspace surface">
              <span>Surface</span>
              <button
                type="button"
                className={activeSurface === "canvas" ? "surface-switch__button surface-switch__button--active" : "surface-switch__button"}
                onClick={() => switchSurface("canvas")}
              >
                Canvas
              </button>
              <button
                type="button"
                className={activeSurface === "text" ? "surface-switch__button surface-switch__button--active" : "surface-switch__button"}
                onClick={() => switchSurface("text")}
              >
                Text
              </button>
            </div>

            {activeSurface === "canvas" ? (
              <div className="canvas-actions" aria-label="Canvas tools">
                <button
                  type="button"
                  className="toolbar-button toolbar-button--primary"
                  onClick={addToolbarNote}
                  title="Add a sticky note"
                >
                  + Note
                </button>

                <button
                  type="button"
                  className={areaSelectMode ? "toolbar-button toolbar-button--info toolbar-button--active" : "toolbar-button toolbar-button--info"}
                  onClick={enterAreaSelectMode}
                  title="Drag on the canvas to select a group of notes for AI"
                >
                  {areaSelectMode ? "Selecting" : "Select Area"}
                </button>

                <div className="canvas-actions__shape">
                  <select
                    className="toolbar-select"
                    value={selectedShapeType}
                    onChange={(event) => setSelectedShapeType(event.target.value as ShapeType)}
                    aria-label="Shape type"
                  >
                    {SHAPE_TYPES.map((shape) => (
                      <option key={shape.value} value={shape.value}>{shape.label}</option>
                    ))}
                  </select>
                  <input
                    className="color-input"
                    type="color"
                    value={selectedShapeColor}
                    onChange={(event) => setSelectedShapeColor(event.target.value)}
                    title="Shape color"
                    aria-label="Shape color"
                  />
                  <button
                    type="button"
                    className="toolbar-button toolbar-button--info"
                    onClick={() => addShape(120 + Math.random() * 400, 120 + Math.random() * 300, selectedShapeType, selectedShapeColor)}
                  >
                    + Shape
                  </button>
                </div>

                <div className="canvas-actions__shape">
                  <input
                    className="color-input"
                    type="color"
                    value={inkColor}
                    onChange={(event) => setInkColor(event.target.value)}
                    title="Ink color"
                    aria-label="Ink color"
                  />
                  <button
                    type="button"
                    className={inkMode ? "toolbar-button toolbar-button--lavender toolbar-button--active" : "toolbar-button"}
                    onClick={enterInkMode}
                    title={inkMode ? "Turn off draw mode to select existing items" : "Draw freehand ink on the canvas"}
                  >
                    {inkMode ? "Drawing" : "Draw"}
                  </button>
                </div>

                <button
                  type="button"
                  className={deleteMode ? "toolbar-button toolbar-button--danger toolbar-button--active" : "toolbar-button toolbar-button--danger"}
                  onClick={enterDeleteMode}
                  title="Click any note, shape, or stroke to delete it"
                >
                  {deleteMode ? "Deleting" : "Delete"}
                </button>

                <button
                  type="button"
                  className="toolbar-button toolbar-button--muted"
                  onClick={clearCanvasAndSelection}
                  title="Clear everything"
                >
                  Clear All
                </button>
              </div>
            ) : (
              <div className="text-actions" aria-label="Text tools">
                {TEXT_STRESS_TARGETS.map((target) => (
                  <button
                    key={target.words}
                    type="button"
                    className="toolbar-button toolbar-button--info"
                    onClick={() => loadTextStressSample(target.words)}
                    disabled={demoRunning}
                  >
                    {target.label}
                  </button>
                ))}
                <button
                  type="button"
                  className="toolbar-button toolbar-button--muted"
                  onClick={clearTextStressSample}
                  disabled={textStressStats.words === 0}
                >
                  Clear text
                </button>
              </div>
            )}

            <div className={activeSurface === "canvas" && (selectedNotes.length > 0 || selectedStrokeCount > 0) ? "target-chip target-chip--selected" : "target-chip"}>
              {activeSurface === "canvas" && (selectedNotes.length > 0 || selectedStrokeCount > 0) ? (
                <>
                  <strong>{getSelectedSummary(selectedNotes.length, selectedStrokeCount)}</strong>
                  <button
                    type="button"
                    className="target-chip__clear"
                    onClick={clearSelection}
                    title="Clear selection"
                    aria-label="Clear selection"
                  >
                    Clear all
                  </button>
                </>
              ) : (
                <>
                  <span>AI focus</span>
                  <strong>{getTargetLabel(selectedNotes, selectedStrokeCount, activeSurface)}</strong>
                  <em>{getTargetPreview(selectedNotes, selectedStrokeCount, activeSurface, textStressStats)}</em>
                </>
              )}
            </div>
          </div>

          {!online && (
            <div className="mode-banner mode-banner--offline">
              <span><strong>Relay disconnected.</strong> Edit in both tabs, then go online to watch Automerge merge.</span>
            </div>
          )}

          {activeSurface === "canvas" && inkMode && (
            <div className="mode-banner mode-banner--draw">
              Draw mode active. Drag to ink; click Drawing again to select existing items.
            </div>
          )}

          {activeSurface === "canvas" && areaSelectMode && (
            <div className="mode-banner mode-banner--select">
              Area selection active. Drag over notes to scope the next AI proposal.
            </div>
          )}

          {activeSurface === "canvas" && deleteMode && (
            <div className="mode-banner mode-banner--delete">
              Delete mode active. Click any note, shape, or stroke to remove it.
            </div>
          )}

          <div className="stage-surface">
            {activeSurface === "canvas" ? (
              <CanvasView
                doc={doc}
                userName={userName}
                onAddNote={addNote}
                onUpdateNote={updateNote}
                onDeleteNote={deleteNoteAndClearSelection}
                onSetNoteText={setNoteText}
                onDeleteShape={deleteShape}
                onMoveItem={moveItem}
                onCursorMove={sendCursor}
                onAddStroke={addStroke}
                onDeleteStroke={deleteStrokeAndClearSelection}
                onToggleTask={toggleTask}
                onCaretChange={handleCaretChange}
                selectedNoteIds={selectedNoteIds}
                selectedStrokeIds={selectedStrokeIds}
                onSelectNotes={selectNotesAndClearStrokes}
                onSelectStrokes={selectStrokesAndClearNotes}
                aiPreviewEdits={canvasPreviewEdits}
                liveConflictNoteId={liveConflictVisible ? liveConflictSuggestion?.noteId ?? null : null}
                areaSelectMode={areaSelectMode}
                inkMode={inkMode}
                inkColor={inkColor}
                inkWidth={3}
                deleteMode={deleteMode}
                otherUsers={otherUsers}
              />
            ) : (
              <SharedTextSurface
                text={doc.text ?? ""}
                stats={textStressStats}
                carets={textCarets}
                onTextChange={setText}
                onCaretChange={(offset) => handleCaretChange(offset === null ? null : { surface: "text", offset })}
                onLoadSample={loadTextStressSample}
                onClear={clearTextStressSample}
                demoRunning={demoRunning}
              />
            )}
          </div>
        </section>

        <aside className={aiPanelOpen ? "review-column" : "review-column review-column--collapsed"} aria-label="AI proposal review">
          <button
            type="button"
            className="review-column__toggle"
            onClick={() => setAiPanelOpen((open) => !open)}
            aria-label={aiPanelOpen ? "Collapse AI review panel" : "Expand AI review panel"}
            title={aiPanelOpen ? "Collapse AI review panel" : "Expand AI review panel"}
          >
            <span aria-hidden="true">{aiPanelOpen ? "\u203A" : "\u2039"}</span>
          </button>
          {!aiPanelOpen && <div className="review-column__label">AI review</div>}
          <div className="review-column__content">
            <Act2Panel
              ref={act2PanelRef}
              doc={doc}
              provider={aiProvider}
              aiEnabled={AI_LIVE_ENABLED}
              selectedNotes={activeSurface === "canvas" ? selectedNotes : []}
              surfaceMode={activeSurface}
              userName={userName}
              onAccept={acceptAiProposalAndFocus}
              onPreviewChange={updateAiPreview}
              onReviewPhaseChange={setAiReviewPhase}
              onFeedbackMemoryChange={setFeedbackMemoryCount}
              tensions={effectiveTensions}
              tensionsLoading={tensionsLoading}
              tensionsError={tensionsError}
              onRefreshTensions={refreshTensions}
            />
          </div>
        </aside>
      </main>

      <footer className="statusbar">
        <span>Notes: {doc.notes.length}</span>
        <span>Text words: {textStressStats.words.toLocaleString()}</span>
        <span>Selected: {getSelectionLabel(selectedNotes.length, selectedStrokeCount)}</span>
        <span>Online: {1 + others.size}</span>
        <span
          className="statusbar__room"
          title={`Relay room: ${docId}. Tabs only see each other when this room matches. Reset room pushes a clean state to peers in this room.`}
        >
          Room: {docId}{isResetRoom ? " reset" : ""}
        </span>
        <span
          className="statusbar__more"
          title={`Shapes: ${doc.shapes.length} · Strokes: ${doc.strokes?.length ?? 0} · Tasks: ${doc.tasks?.length ?? 0} · Highlights: ${doc.highlights?.length ?? 0}`}
        >
          +{(doc.shapes.length) + (doc.strokes?.length ?? 0) + (doc.tasks?.length ?? 0) + (doc.highlights?.length ?? 0)} more
        </span>
        {others.size === 0 && (
          <span className="statusbar__hint">
            Open a second tab for another collaborator
          </span>
        )}
      </footer>
    </div>
  );
}

function DemoStoryRail({ moments }: { moments: StoryMoment[] }) {
  return (
    <section className="story-rail" aria-label="Demo story">
      <ol className="storyline">
        {moments.map((item) => (
          <li
            key={item.key}
            className={item.active ? "story-moment story-moment--active" : "story-moment"}
            data-story-moment={item.key}
          >
            <span className="story-moment__step">{item.step}</span>
            <div>
              <strong>{item.title}</strong>
              <p>{item.detail}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function LiveConflictPanel({
  suggestion,
  previewActive,
  previewBlocked,
  generating,
  onPreview,
  onAccept,
  onDismiss,
}: {
  suggestion: LiveSemanticConflictSuggestion;
  previewActive: boolean;
  previewBlocked: boolean;
  generating: boolean;
  onPreview: (suggestion: LiveSemanticConflictSuggestion) => void;
  onAccept: (suggestion: LiveSemanticConflictSuggestion) => void;
  onDismiss: (suggestion: LiveSemanticConflictSuggestion) => void;
}) {
  return (
    <section className="live-conflict-panel" data-live-conflict-panel="true" aria-live="polite">
      <div className="live-conflict-panel__signal">
        <span>Live edit conflict</span>
        <strong>{suggestion.reason}</strong>
        <em>{suggestion.participants.join(" + ")}</em>
      </div>
      <div className="live-conflict-panel__merge">
        <span>Proposed resolution</span>
        <p>{suggestion.tension}</p>
      </div>
      <div className="live-conflict-panel__trail">
        {suggestion.sourceTrail.slice(0, 3).map((line) => (
          <span key={line}>{line}</span>
        ))}
      </div>
      <div className="live-conflict-panel__actions">
        <button
          type="button"
          onClick={() => onPreview(suggestion)}
          disabled={previewBlocked}
          data-live-conflict-preview="true"
          title={previewBlocked ? "Finish the current AI review before previewing this live merge." : "Ask the real AI provider to merge the conflict without changing shared state."}
        >
          {generating ? "Generating" : previewActive ? "Previewing" : "Preview merge"}
        </button>
        <button
          type="button"
          className="live-conflict-panel__accept"
          onClick={() => onAccept(suggestion)}
          disabled={!previewActive || generating}
          data-live-conflict-accept="true"
          title={previewActive ? "Accept the real AI merge into shared state." : "Generate a real AI preview before accepting."}
        >
          Accept live merge
        </button>
        <button
          type="button"
          className="live-conflict-panel__dismiss"
          onClick={() => onDismiss(suggestion)}
        >
          Dismiss
        </button>
      </div>
    </section>
  );
}

function SharedTextSurface({
  text,
  stats,
  carets,
  onTextChange,
  onCaretChange,
  onLoadSample,
  onClear,
  demoRunning,
}: {
  text: string;
  stats: { words: number; characters: number };
  carets: Array<{ userName: string; color: string; offset: number }>;
  onTextChange: (next: string) => void;
  onCaretChange: (offset: number | null) => void;
  onLoadSample: (words: number) => void;
  onClear: () => void;
  demoRunning: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  return (
    <section className="shared-text-surface" data-shared-text-surface="true" aria-label="Shared text editing surface">
      <header className="shared-text-surface__header">
        <div>
          <span>Long-form collaboration</span>
          <strong>Shared text stream</strong>
          <p>Real character-level typing, remote carets, and stress samples in the same co-creation workspace.</p>
        </div>
        <div className="shared-text-surface__stats" aria-label="Shared text stats">
          <span><strong>{stats.words.toLocaleString()}</strong> words</span>
          <span><strong>{stats.characters.toLocaleString()}</strong> chars</span>
          <span><strong>{carets.length}</strong> remote caret{carets.length === 1 ? "" : "s"}</span>
        </div>
        <div className="shared-text-surface__actions">
          {TEXT_STRESS_TARGETS.map((target) => (
            <button
              key={target.words}
              type="button"
              onClick={() => onLoadSample(target.words)}
              disabled={demoRunning}
            >
              {target.label}
            </button>
          ))}
          <button type="button" onClick={onClear} disabled={stats.words === 0}>
            Clear text
          </button>
        </div>
      </header>
      <div className="shared-text-editor-wrap">
        <LiveTextarea
          ref={textareaRef}
          className="shared-text-editor"
          value={text}
          onTextChange={onTextChange}
          onCaretChange={onCaretChange}
          placeholder="Start a long shared draft here. Open a second tab to watch real-time text collaboration."
          spellCheck
        />
        <RemoteCarets textareaRef={textareaRef} text={text} carets={carets} />
      </div>
    </section>
  );
}

function buildTextStressSample(targetWords: number): string {
  const words: string[] = [];
  let sentenceIndex = 0;

  while (words.length < targetWords) {
    words.push(...TEXT_STRESS_SENTENCES[sentenceIndex % TEXT_STRESS_SENTENCES.length].split(/\s+/));
    sentenceIndex += 1;
  }

  const trimmedWords = words.slice(0, targetWords);
  const paragraphs: string[] = [];
  for (let index = 0; index < trimmedWords.length; index += 120) {
    paragraphs.push(trimmedWords.slice(index, index + 120).join(" "));
  }

  const text = paragraphs.join("\n\n");
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function getTextStressStats(text: string): { words: number; characters: number } {
  const trimmed = text.trim();
  return {
    words: trimmed ? trimmed.split(/\s+/).length : 0,
    characters: text.length,
  };
}

function getStoryMoments({
  userCount,
  online,
  surface,
  textWords,
  aiReviewPhase,
  feedbackMemoryCount,
  liveConflictVisible,
  liveConflictPreviewActive,
}: {
  userCount: number;
  online: boolean;
  surface: WorkSurface;
  textWords: number;
  aiReviewPhase: AiReviewPhase;
  feedbackMemoryCount: number;
  liveConflictVisible: boolean;
  liveConflictPreviewActive: boolean;
}): StoryMoment[] {
  const proposalActive = aiReviewPhase === "loading" || aiReviewPhase === "proposal";
  const feedbackActive = feedbackMemoryCount > 0;
  const acceptedActive = aiReviewPhase === "accepted";
  const liveStatus = userCount > 1
    ? `${userCount} people live`
    : online
      ? surface === "text" && textWords > 0
        ? `${textWords.toLocaleString()} words live`
        : "Workspace ready"
      : "Offline merge lab";
  const revisionStatus = feedbackActive
    ? `${feedbackMemoryCount}/5 local feedback`
    : proposalActive
      ? "Private draft ready"
      : "AI review ready";
  const commitStatus = liveConflictPreviewActive
    ? "Merge preview"
    : liveConflictVisible
      ? "Conflict detected"
      : acceptedActive
        ? "Shared update accepted"
        : "Human review gate";

  return [
    {
      ...STORY_MOMENT_COPY[0],
      status: liveStatus,
      active: true,
    },
    {
      ...STORY_MOMENT_COPY[1],
      status: revisionStatus,
      active: feedbackActive,
    },
    {
      ...STORY_MOMENT_COPY[2],
      status: commitStatus,
      active: acceptedActive || liveConflictVisible || liveConflictPreviewActive,
    },
  ];
}

function getTargetLabel(selectedNotes: StickyNote[], selectedStrokeCount = 0, surfaceMode: WorkSurface = "canvas"): string {
  if (surfaceMode === "text") return "Shared text";
  if (selectedStrokeCount > 0 && selectedNotes.length === 0) return `${selectedStrokeCount} ink stroke${selectedStrokeCount === 1 ? "" : "s"} selected`;
  if (selectedNotes.length === 0) return "Whole canvas";
  if (selectedNotes.length === 1) return "Selected note";
  return `${selectedNotes.length} selected notes`;
}

function getTargetPreview(
  selectedNotes: StickyNote[],
  selectedStrokeCount = 0,
  surfaceMode: WorkSurface = "canvas",
  textStats: { words: number; characters: number } = { words: 0, characters: 0 },
): string {
  if (surfaceMode === "text") {
    if (textStats.words === 0) return "Start typing or load a stress sample; AI Review stays ready on the right";
    return `${textStats.words.toLocaleString()} words · AI uses the long-form document as context`;
  }
  if (selectedStrokeCount > 0 && selectedNotes.length === 0) return "Ink is selected. Select notes to scope AI changes.";
  if (selectedNotes.length === 0) return "Select a note or area for focused changes";
  if (selectedNotes.length === 1) return selectedNotes[0].text.slice(0, 72) || "Empty note";
  return selectedNotes
    .slice(0, 3)
    .map((note) => note.text.trim().split("\n")[0] || "Empty note")
    .join(" · ");
}

function getSelectionLabel(noteCount: number, strokeCount: number): string {
  const parts: string[] = [];
  if (noteCount > 0) parts.push(`${noteCount} note${noteCount === 1 ? "" : "s"}`);
  if (strokeCount > 0) parts.push(`${strokeCount} stroke${strokeCount === 1 ? "" : "s"}`);
  return parts.length > 0 ? parts.join(", ") : "none";
}

function getSelectedSummary(noteCount: number, strokeCount: number): string {
  const total = noteCount + strokeCount;
  if (total === 0) return "Nothing selected";
  if (noteCount > 0 && strokeCount > 0) {
    return `${total} item${total === 1 ? "" : "s"} selected`;
  }
  if (noteCount > 0) return `${noteCount} note${noteCount === 1 ? "" : "s"} selected`;
  return `${strokeCount} stroke${strokeCount === 1 ? "" : "s"} selected`;
}

function buildLiveConflictMergeInstruction(suggestion: LiveSemanticConflictSuggestion): string {
  return [
    "Live semantic conflict: generate a real AI merge for the existing target note.",
    "Update only the target note. Do not add, delete, move, or highlight anything.",
    "Use this exact content shape:",
    "Live semantic merge",
    `${suggestion.participants.join(" + ")} editing together`,
    "",
    "Merged decision",
    "- One concise decision that preserves both collaborator intents.",
    "",
    "Source trail",
    "- Contributor: source intent",
    "",
    "Review boundary",
    "- State that a human accepts the merge before the shared note changes.",
    "",
    `Detected tension: ${suggestion.tension}`,
    "Source trail to preserve:",
    ...suggestion.sourceTrail.map((line) => `- ${line}`),
  ].join("\n");
}

function normalizeLiveConflictEdits(
  edits: AiProposalEdit[],
  suggestion: LiveSemanticConflictSuggestion,
  summary: string,
): AiProposalEdit[] {
  const update = edits.find((edit): edit is Extract<AiProposalEdit, { type: "updateNoteText" }> =>
    edit.type === "updateNoteText" && edit.id === suggestion.noteId
  );
  const addNote = edits.find((edit): edit is Extract<AiProposalEdit, { type: "addNote" }> =>
    edit.type === "addNote" && edit.text.trim().length > 0
  );
  const text = ensureLiveConflictText(update?.text ?? addNote?.text ?? summary, suggestion);

  if (!text?.trim()) {
    throw new Error("AI returned no usable live merge edit.");
  }

  return [{
    type: "updateNoteText",
    id: suggestion.noteId,
    text,
    sourceNoteIds: [suggestion.noteId],
    rationale: appendLiveConflictRationale(update?.rationale ?? addNote?.rationale),
  }];
}

function ensureLiveConflictText(text: string, suggestion: LiveSemanticConflictSuggestion): string {
  const cleaned = text.trim();
  if (!cleaned) return "";

  if (!/^live semantic merge\b/i.test(cleaned)) {
    return [
      "Live semantic merge",
      `${suggestion.participants.join(" + ")} editing together`,
      "",
      "Merged decision",
      `- ${cleaned.replace(/\s+/g, " ")}`,
      "",
      "Source trail",
      ...suggestion.sourceTrail.map((line) => `- ${line}`),
      "",
      "Review boundary",
      "- A human accepts the merge before the shared note changes.",
    ].join("\n");
  }

  const sections = [cleaned];
  if (!/\bsource trail\b/i.test(cleaned)) {
    sections.push("", "Source trail", ...suggestion.sourceTrail.map((line) => `- ${line}`));
  }
  if (!/\breview boundary\b/i.test(cleaned)) {
    sections.push("", "Review boundary", "- A human accepts the merge before the shared note changes.");
  }
  return sections.join("\n");
}

function appendLiveConflictRationale(rationale: string | undefined): string {
  const liveRationale = "Live semantic conflict detected: real AI merged parallel collaborator intent into one reviewable decision.";
  if (!rationale) return liveRationale;
  if (/live semantic conflict/i.test(rationale)) return rationale;
  return `${rationale} ${liveRationale}`;
}

function scheduleCanvasFocus(kind: "preview" | "accepted", edits: AiProposalEdit[]) {
  if (typeof window === "undefined" || edits.length === 0) return;
  window.setTimeout(() => {
    window.requestAnimationFrame(() => {
      const target = findCanvasFocusTarget(kind, edits);
      focusCanvasElement(target, kind);
    });
  }, 120);
}

function findCanvasFocusTarget(kind: "preview" | "accepted", edits: AiProposalEdit[]): HTMLElement | null {
  if (kind === "preview") {
    const highlight = edits.find((edit): edit is Extract<AiProposalEdit, { type: "addHighlight" }> => edit.type === "addHighlight");
    if (highlight) return noteElementById(highlight.noteId);

    if (edits.some((edit) => edit.type === "addTask")) {
      const taskPreview = document.querySelector<HTMLElement>("[data-task-board-preview='true']");
      if (taskPreview) return taskPreview;
    }

    const notePreview = document.querySelector<HTMLElement>("[data-ai-preview-note='true']");
    if (notePreview) return notePreview;

    const changedNoteRibbon = document.querySelector<HTMLElement>(".note-ai-change-ribbon");
    if (changedNoteRibbon) return changedNoteRibbon.closest<HTMLElement>("[data-note-id]");

    const shapePreview = document.querySelector<HTMLElement>(".ai-preview-shape");
    if (shapePreview) return shapePreview;

    return document.querySelector<HTMLElement>("[data-ai-preview-status='true']");
  }

  const addedNoteTexts = edits
    .filter((edit): edit is Extract<AiProposalEdit, { type: "addNote" }> => edit.type === "addNote")
    .map((edit) => edit.text);
  const addedNote = noteElementByText(addedNoteTexts);
  if (addedNote) return addedNote;

  const highlight = edits.find((edit): edit is Extract<AiProposalEdit, { type: "addHighlight" }> => edit.type === "addHighlight");
  if (highlight) return noteElementById(highlight.noteId);

  if (edits.some((edit) => edit.type === "addTask")) {
    const taskBoard = document.querySelector<HTMLElement>("[data-task-board='true']");
    if (taskBoard) return taskBoard;
  }

  const changedNote = edits
    .map((edit) => {
      if (edit.type === "moveNote" || edit.type === "updateNoteText") return noteElementById(edit.id);
      return null;
    })
    .find((element): element is HTMLElement => Boolean(element));
  if (changedNote) return changedNote;

  const sourceNote = edits
    .flatMap((edit) => edit.sourceNoteIds ?? [])
    .map(noteElementById)
    .find((element): element is HTMLElement => Boolean(element));
  return sourceNote ?? document.querySelector<HTMLElement>("[data-canvas-root='true']");
}

function focusCanvasElement(target: HTMLElement | null, kind: "preview" | "accepted") {
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
  target.classList.remove("canvas-focus-pulse");
  target.removeAttribute("data-canvas-focus");
  target.removeAttribute("data-canvas-focus-kind");
  window.requestAnimationFrame(() => {
    target.setAttribute("data-canvas-focus", "true");
    target.setAttribute("data-canvas-focus-kind", kind);
    target.classList.add("canvas-focus-pulse");
    window.setTimeout(() => {
      target.classList.remove("canvas-focus-pulse");
      target.removeAttribute("data-canvas-focus");
      target.removeAttribute("data-canvas-focus-kind");
    }, 1800);
  });
}

function noteElementById(id: string | undefined): HTMLElement | null {
  if (!id) return null;
  return document.querySelector<HTMLElement>(`[data-note-id='${cssEscape(id)}']`);
}

function noteElementByText(texts: string[]): HTMLElement | null {
  if (texts.length === 0) return null;
  const normalizedTexts = texts.map(normalizeFocusText).filter(Boolean);
  if (normalizedTexts.length === 0) return null;

  return Array.from(document.querySelectorAll<HTMLElement>("[data-note-id]")).find((note) => {
    const value = note.querySelector("textarea")?.value ?? "";
    const normalizedValue = normalizeFocusText(value);
    return normalizedTexts.some((text) => normalizedValue === text || normalizedValue.includes(text.slice(0, 96)));
  }) ?? null;
}

function normalizeFocusText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(value);
  return value.replace(/['"\\]/g, "\\$&");
}

async function waitForGuidedBeat(
  durationMs: number,
  pausedRef: { current: boolean },
  advanceRef: { current: (() => void) | null },
  cancelledRef: { current: boolean },
): Promise<boolean> {
  let remaining = durationMs;

  while (remaining > 0) {
    if (cancelledRef.current) return false;

    if (pausedRef.current) {
      await new Promise<void>((resolve) => {
        advanceRef.current = resolve;
      });
      advanceRef.current = null;
      continue;
    }

    const chunk = Math.min(remaining, 160);
    let advanced = false;
    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(resolve, chunk);
      advanceRef.current = () => {
        advanced = true;
        window.clearTimeout(timer);
        resolve();
      };
    });
    advanceRef.current = null;

    if (cancelledRef.current) return false;
    if (advanced) return true;
    remaining -= chunk;
  }

  return true;
}

function focusDemoRegion(region: "story" | "canvas" | "review" | "text" | "liveConflict") {
  const selectorByRegion = {
    story: ".story-rail",
    canvas: "[data-canvas-root='true']",
    review: ".review-column",
    text: "[data-shared-text-surface='true']",
    liveConflict: "[data-live-conflict-panel='true']",
  } as const;
  const target = document.querySelector<HTMLElement>(selectorByRegion[region]);
  if (!target) return;

  if (region === "canvas") {
    document.querySelector<HTMLElement>(".stage-surface")?.scrollTo({ top: 0, left: 0, behavior: "smooth" });
  }
  if (region === "review") {
    document.querySelector<HTMLElement>(".act2-panel")?.scrollTo({ top: 0, behavior: "smooth" });
  }

  target.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
  target.classList.remove("presenter-focus-pulse");
  window.requestAnimationFrame(() => {
    target.classList.add("presenter-focus-pulse");
    window.setTimeout(() => target.classList.remove("presenter-focus-pulse"), 1800);
  });
}

export default App;
