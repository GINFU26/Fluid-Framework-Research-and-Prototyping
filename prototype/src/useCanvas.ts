import { useEffect, useRef, useState, useCallback } from "react";
import * as Automerge from "@automerge/automerge";
import type { CanvasDoc, StickyNote, Shape, InkStroke, CanvasTask, CanvasHighlight, NoteColor } from "./schema";
import type { AiProposalEdit } from "./ai";
import { uuid } from "./uuid";

const RELAY_URL = getRelayUrl();
type DemoSeed = "playground" | null;

const INITIAL_SEARCH_PARAMS = new URLSearchParams(window.location.search);
const RESET_DOC = INITIAL_SEARCH_PARAMS.get("reset") === "1";
const DEMO_SEED = getInitialDemoSeed(INITIAL_SEARCH_PARAMS);
const PLAYGROUND_DEMO_DOC_ID = "showcase-playground-v2";
const DEFAULT_PLAYGROUND_ROOM_ID = "default";
const DOC_ID = getInitialDocId(DEMO_SEED, RESET_DOC, INITIAL_SEARCH_PARAMS);
const MAX_UNDO = 50;
const STORAGE_KEY = `automerge-doc-${DOC_ID}`;

const PLAYGROUND_SEED_TEXT_BY_ID: Record<string, string> = {
  "playground-human-gate": "Keep a human review gate before AI changes become shared. It makes the demo feel trustworthy when visitors inspect a private proposal first.",
  "playground-ai-speed": "Counterpoint: for a short public demo, AI should auto-apply the room map after generation so people immediately see momentum.",
  "playground-room-entry": "Show collaboration first. Each visitor enters a name, chooses a room, edits the same sticky, and watches cursor plus caret presence sync.",
  "playground-tension-review": "Plan for Jun 5: run a two-person review and check that Tensions in the room catches the AI auto-apply vs human review tradeoff.",
  "playground-shareout": "Plan for Jun 10: ask each reviewer to add one note before using AI Review, so the model has enough source material to summarize.",
  "playground-persistence": "Plan for Jun 12: if visitors ask about persistence, explain that this is a no-auth showcase with browser-local state, not durable cloud storage.",
};

const PLAYGROUND_SEED_CREATED_AT_BY_ID: Record<string, string> = {
  "playground-human-gate": "2026-05-29T09:00:00-07:00",
  "playground-ai-speed": "2026-05-30T10:00:00-07:00",
  "playground-room-entry": "2026-06-02T11:00:00-07:00",
  "playground-tension-review": "2026-06-03T09:00:00-07:00",
  "playground-shareout": "2026-06-03T09:30:00-07:00",
  "playground-persistence": "2026-06-03T10:00:00-07:00",
};

function getRelayUrl(): string {
  const configured = import.meta.env.VITE_RELAY_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  if (import.meta.env.DEV) return `${protocol}//${window.location.hostname}:3030`;
  return `${protocol}//${window.location.host}`;
}

function getInitialDemoSeed(searchParams: URLSearchParams): DemoSeed {
  const requested = searchParams.get("demo")?.trim().toLowerCase();
  if (requested === "playground") return "playground";
  return null;
}

function getInitialDocId(demoSeed: DemoSeed, resetDoc: boolean, searchParams: URLSearchParams): string {
  const requested = searchParams.get("doc")?.trim();
  if (requested && /^[a-zA-Z0-9_-]{1,64}$/.test(requested)) return requested;
  // reset goes into a DEDICATED relay room (and, via STORAGE_KEY, a dedicated
  // localStorage entry). Relay rooms are keyed by docId, so any stale/zombie
  // tab still holding the post-"Map the room" doc lives in the base room and
  // physically cannot reach the reset room — which is what was re-polluting the
  // board ~6s after reset (once the authority window expired). Two tabs opened
  // with &reset=1 both land here and converge on the clean deterministic seed.
  if (demoSeed === "playground" && resetDoc) return `${PLAYGROUND_DEMO_DOC_ID}-reset`;
  if (demoSeed === "playground") return PLAYGROUND_DEMO_DOC_ID;
  return "canvas-demo";
}

function isDefaultPlaygroundDocId(docId: string): boolean {
  return docId === DEFAULT_PLAYGROUND_ROOM_ID || docId === PLAYGROUND_DEMO_DOC_ID;
}

function clearPersistedDemoStorage(storageKey: string) {
  localStorage.removeItem(storageKey);
  if (DEMO_SEED !== "playground") return;
  const prefix = "automerge-doc-showcase-playground";
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const key = localStorage.key(index);
    if (key?.startsWith(prefix)) localStorage.removeItem(key);
  }
}

// localStorage persistence: Automerge byte array <-> base64 (chunk-safe).
function encodeBytes(bytes: Uint8Array): string {
  let result = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    result += String.fromCharCode(...Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(result);
}

function decodeBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function initDoc(): Automerge.Doc<CanvasDoc> {
  try {
    if (RESET_DOC) clearPersistedDemoStorage(STORAGE_KEY);
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      let d = Automerge.load(decodeBytes(saved)) as Automerge.Doc<CanvasDoc>;
      // Migrate old docs that pre-date the strokes field
      if (!d.strokes) {
        d = Automerge.change(d, (draft) => { (draft as CanvasDoc).strokes = []; });
      }
      // Migrate old docs that pre-date the shared text field
      if (typeof d.text !== "string") {
        d = Automerge.change(d, (draft) => { (draft as CanvasDoc).text = ""; });
      }
      if (!d.tasks) {
        d = Automerge.change(d, (draft) => { (draft as CanvasDoc).tasks = []; });
      }
      if (!d.highlights) {
        d = Automerge.change(d, (draft) => { (draft as CanvasDoc).highlights = []; });
      }
      if (d.notes?.some((note) => typeof note.createdAt !== "number")) {
        const migratedAt = Date.now();
        d = Automerge.change(d, (draft) => {
          draft.notes.forEach((note) => {
            if (typeof note.createdAt !== "number") note.createdAt = migratedAt;
          });
        });
      }
      const normalized = normalizePlaygroundDocIfNeeded(d);
      if (normalized !== d) {
        d = normalized;
        localStorage.setItem(STORAGE_KEY, encodeBytes(Automerge.save(d)));
      }
      return d;
    }
  } catch (e) {
    console.warn("[useCanvas] failed to load persisted doc:", e);
  }
  if (DEMO_SEED === "playground" && isDefaultPlaygroundDocId(DOC_ID)) return createShowcasePlaygroundDoc();
  return createEmptyCanvasDoc();
}

function createEmptyCanvasDoc(): Automerge.Doc<CanvasDoc> {
  return Automerge.from({
    notes: [] as StickyNote[],
    shapes: [] as Shape[],
    strokes: [] as InkStroke[],
    tasks: [] as CanvasTask[],
    highlights: [] as CanvasHighlight[],
    text: "",
  }) as Automerge.Doc<CanvasDoc>;
}

function getNormalizedPersistedPlaygroundText(note: StickyNote): string | null {
  const seedText = PLAYGROUND_SEED_TEXT_BY_ID[note.id];
  if (!seedText || note.text === seedText) return null;
  const startsWithAuthorDate = new RegExp(`^${escapeRegExp(note.author)}\\s+-\\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\s+\\d{1,2}\\b`, "i")
    .test(note.text.trimStart());
  const includesSeedIsoDate = /\b2026-\d{2}-\d{2}\b/.test(note.text);
  return startsWithAuthorDate || includesSeedIsoDate ? seedText : null;
}

function normalizePlaygroundDocIfNeeded(d: Automerge.Doc<CanvasDoc>): Automerge.Doc<CanvasDoc> {
  if (
    DEMO_SEED !== "playground" ||
    !d.notes?.some((note) => getNormalizedPersistedPlaygroundText(note) || getNormalizedPlaygroundCreatedAt(note) !== null)
  ) {
    return d;
  }
  return Automerge.change(d, (draft) => {
    draft.notes.forEach((note) => {
      const normalizedText = getNormalizedPersistedPlaygroundText(note);
      if (normalizedText) note.text = normalizedText;
      const normalizedCreatedAt = getNormalizedPlaygroundCreatedAt(note);
      if (normalizedCreatedAt !== null) note.createdAt = normalizedCreatedAt;
    });
  });
}

function getNormalizedPlaygroundCreatedAt(note: StickyNote): number | null {
  const isoDate = PLAYGROUND_SEED_CREATED_AT_BY_ID[note.id];
  if (!isoDate) return null;
  const expected = new Date(isoDate).getTime();
  return note.createdAt === expected ? null : expected;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createShowcasePlaygroundDoc(): Automerge.Doc<CanvasDoc> {
  const time = (isoDate: string, offsetMinutes: number) => new Date(isoDate).getTime() + offsetMinutes * 60_000;
  const notes: StickyNote[] = [
    {
      id: "playground-human-gate",
      text: PLAYGROUND_SEED_TEXT_BY_ID["playground-human-gate"],
      x: 84,
      y: 84,
      color: "pink",
      author: "Alex",
      createdAt: time(PLAYGROUND_SEED_CREATED_AT_BY_ID["playground-human-gate"], 0),
    },
    {
      id: "playground-ai-speed",
      text: PLAYGROUND_SEED_TEXT_BY_ID["playground-ai-speed"],
      x: 446,
      y: 122,
      color: "blue",
      author: "Blair",
      createdAt: time(PLAYGROUND_SEED_CREATED_AT_BY_ID["playground-ai-speed"], 0),
    },
    {
      id: "playground-room-entry",
      text: PLAYGROUND_SEED_TEXT_BY_ID["playground-room-entry"],
      x: 808,
      y: 84,
      color: "purple",
      author: "Casey",
      createdAt: time(PLAYGROUND_SEED_CREATED_AT_BY_ID["playground-room-entry"], 0),
    },
    {
      id: "playground-tension-review",
      text: PLAYGROUND_SEED_TEXT_BY_ID["playground-tension-review"],
      x: 1168,
      y: 132,
      color: "green",
      author: "Drew",
      createdAt: time(PLAYGROUND_SEED_CREATED_AT_BY_ID["playground-tension-review"], 0),
    },
    {
      id: "playground-shareout",
      text: PLAYGROUND_SEED_TEXT_BY_ID["playground-shareout"],
      x: 252,
      y: 402,
      color: "yellow",
      author: "Evan",
      createdAt: time(PLAYGROUND_SEED_CREATED_AT_BY_ID["playground-shareout"], 0),
    },
    {
      id: "playground-persistence",
      text: PLAYGROUND_SEED_TEXT_BY_ID["playground-persistence"],
      x: 760,
      y: 404,
      color: "orange",
      author: "Fatima",
      createdAt: time(PLAYGROUND_SEED_CREATED_AT_BY_ID["playground-persistence"], 0),
    },
  ];

  let seed = Automerge.init<CanvasDoc>("51afe51afe51afe5");
  seed = Automerge.change(seed, { time: 0 }, (d) => {
    d.notes = notes;
    d.shapes = [];
    d.strokes = [];
    d.tasks = [];
    d.highlights = [];
    d.text = "";
  });
  return Automerge.load<CanvasDoc>(Automerge.save(seed));
}

function persistDoc(d: Automerge.Doc<CanvasDoc>) {
  try {
    localStorage.setItem(STORAGE_KEY, encodeBytes(Automerge.save(d)));
  } catch (e) {
    console.warn("[useCanvas] failed to persist doc:", e);
  }
}

// Inverse-op undo: each user action carries its own do/undo functions so undo
// only reverses YOUR change. Bob's concurrent edits during your offline period
// are preserved on undo. Replaces the previous (incorrect) snapshot-based undo
// which would have rolled back remote edits on reconnect.
type CanvasOp = {
  do: (d: CanvasDoc) => void;
  undo: (d: CanvasDoc) => void;
};

export function useCanvas(userName: string) {
  const [doc, setDoc] = useState<Automerge.Doc<CanvasDoc>>(initDoc);
  const docRef = useRef(doc);
  const wsRef = useRef<WebSocket | null>(null);
  const [ws, setWs] = useState<WebSocket | null>(null);
  const [online, setOnline] = useState(true);
  // Reconnect machinery. The relay force-closes a room (close code 4000) when
  // any client connects with ?reset=1, so a peer that is already connected
  // gets kicked the moment a second tab loads a reset link. Without auto-
  // reconnect that kicked tab stays dead forever (doc sync AND presence ride
  // this one socket), which is why selection/presence "disappear after reset".
  const onlineRef = useRef(online);
  // Mirror `online` into a ref AFTER render so the socket onclose handler can
  // read the latest value without re-subscribing. Writing during render trips
  // react-hooks/refs and is unsafe under concurrent rendering.
  useEffect(() => {
    onlineRef.current = online;
  }, [online]);
  // reset=1 must be consumed exactly once. If a reconnect re-sent reset=1,
  // two tabs would kick each other forever. Only the first connect carries reset.
  const resetConsumedRef = useRef(false);
  // Distinguishes an intentional close (going offline / effect cleanup) from a
  // server kick or network drop, so we only auto-reconnect on the latter.
  const intentionalCloseRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const [reconnectNonce, setReconnectNonce] = useState(0);
  // reset is AUTHORITATIVE. The tab that loads ?reset=1 becomes the source of
  // truth for a short window and pushes a clean seed to every (re)connecting
  // peer. Without this, reset only resets the LOCAL doc — the first peer doc
  // that arrives merges its stale notes back in (Automerge merge only unions,
  // it can never delete), which is why a reset board flashes clean for ~1s and
  // then "becomes the mapped board" the instant the socket connects.
  const resetSignalSentRef = useRef(false);
  const resetAuthorityUntilRef = useRef(0);

  const undoStack = useRef<CanvasOp[]>([]);
  const redoStack = useRef<CanvasOp[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const updateDoc = (next: Automerge.Doc<CanvasDoc>) => {
    const normalized = normalizePlaygroundDocIfNeeded(next);
    docRef.current = normalized;
    setDoc(normalized);
    persistDoc(normalized);
  };

  // Broadcast the full doc state. Simpler and more robust than the incremental
  // sync protocol for a small canvas document — the sync protocol via a
  // broadcast relay gets stuck in "waiting for ack" states because the same
  // syncState is shared across all peers. Full-state broadcast converges in
  // one round per change and is trivially correct.
  const broadcastDoc = (d: Automerge.Doc<CanvasDoc>) => {
    const sock = wsRef.current;
    if (!sock || sock.readyState !== WebSocket.OPEN) return;
    // Automerge.save returns a Uint8Array that may be backed by the WASM
    // module's SharedArrayBuffer (when COOP/COEP enables threads). Browser
    // WebSocket.send cannot transmit SharedArrayBuffer-backed views, so we
    // copy into a fresh ArrayBuffer first.
    const saved = Automerge.save(d);
    const buf = new ArrayBuffer(saved.byteLength);
    new Uint8Array(buf).set(saved);
    sock.send(buf);
  };

  // Tell every peer to REPLACE (not merge) their doc with this exact seed.
  // Sent as a text frame so it rides the same socket as presence; usePresence
  // ignores it (type !== "presence") and useCanvas ignores presence frames.
  const broadcastResetSignal = () => {
    const sock = wsRef.current;
    if (!sock || sock.readyState !== WebSocket.OPEN) return;
    sock.send(JSON.stringify({ type: "canvas-reset", seed: encodeBytes(Automerge.save(docRef.current)) }));
  };

  // Replace the local doc with an authoritative seed (no merge). Used when a
  // peer that holds ?reset=1 authority pushes us a clean board.
  const replaceDocFromSeed = (b64: string) => {
    try {
      const fresh = Automerge.load(decodeBytes(b64)) as Automerge.Doc<CanvasDoc>;
      undoStack.current = [];
      redoStack.current = [];
      setCanUndo(false);
      setCanRedo(false);
      updateDoc(fresh);
    } catch (err) {
      console.error("[sync] failed to apply reset seed:", err);
    }
  };

  const applyOp = useCallback((op: CanvasOp) => {
    const next = Automerge.change(docRef.current, op.do);
    undoStack.current = [...undoStack.current.slice(-MAX_UNDO), op];
    redoStack.current = [];
    setCanUndo(true);
    setCanRedo(false);
    updateDoc(next);
    broadcastDoc(next);
  }, []);

  const undo = useCallback(() => {
    const op = undoStack.current.pop();
    if (!op) return;
    const next = Automerge.change(docRef.current, op.undo);
    redoStack.current.push(op);
    setCanUndo(undoStack.current.length > 0);
    setCanRedo(true);
    updateDoc(next);
    broadcastDoc(next);
  }, []);

  const redo = useCallback(() => {
    const op = redoStack.current.pop();
    if (!op) return;
    const next = Automerge.change(docRef.current, op.do);
    undoStack.current.push(op);
    setCanUndo(true);
    setCanRedo(redoStack.current.length > 0);
    updateDoc(next);
    broadcastDoc(next);
  }, []);

  // Keyboard shortcuts. Skip when typing in a text field so native browser
  // undo/redo works inside the shared textarea (text-CRDT merge handles its
  // own history at the character level).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT" || t?.isContentEditable) return;
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [undo, redo]);

  // WebSocket connect/disconnect based on online flag
  useEffect(() => {
    if (!online) {
      intentionalCloseRef.current = true;
      if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
      wsRef.current?.close();
      wsRef.current = null;
      window.queueMicrotask(() => setWs(null));
      return;
    }

    intentionalCloseRef.current = false;
    if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }

    const relayParams = new URLSearchParams({ docId: DOC_ID });
    // Only the first-ever connect carries reset=1; reconnects must not, or the
    // tabs would kick each other in an endless loop (see resetConsumedRef).
    if (RESET_DOC && !resetConsumedRef.current) relayParams.set("reset", "1");
    resetConsumedRef.current = true;
    const socket = new WebSocket(`${RELAY_URL}?${relayParams.toString()}`);
    socket.binaryType = "arraybuffer";
    wsRef.current = socket;
    window.queueMicrotask(() => {
      if (wsRef.current === socket) setWs(socket);
    });

    socket.onopen = () => {
      // A clean open means we're healthy again: reset the backoff counter.
      reconnectAttemptsRef.current = 0;
      // If this tab is the reset initiator, claim authority for a few seconds
      // and push the clean seed, so kicked peers that reconnect during the
      // window get REPLACED with the clean board instead of re-merging stale
      // notes back into it. Done once, on the very first open.
      if (RESET_DOC && !resetSignalSentRef.current) {
        resetSignalSentRef.current = true;
        resetAuthorityUntilRef.current = Date.now() + 6000;
        broadcastResetSignal();
      }
      // Announce our current state so peers can merge anything we have
      // that they don't (and so they reciprocate with their state).
      broadcastDoc(docRef.current);
    };

    socket.onmessage = (event) => {
      // Text frames = presence (handled by usePresence) or a canvas-reset
      // control frame; binary = full doc state.
      if (typeof event.data === "string") {
        try {
          const msg = JSON.parse(event.data);
          if (msg?.type === "canvas-reset" && typeof msg.seed === "string") {
            replaceDocFromSeed(msg.seed);
          }
        } catch {
          // Not JSON (a presence frame) — ignore here.
        }
        return;
      }
      // While we hold reset authority, any incoming peer doc is stale by
      // definition (the room was just force-reset), so push the clean seed
      // back at that peer instead of merging its old notes in.
      if (RESET_DOC && Date.now() < resetAuthorityUntilRef.current) {
        broadcastResetSignal();
        return;
      }
      const bytes = new Uint8Array(event.data as ArrayBuffer);
      let merged: Automerge.Doc<CanvasDoc>;
      try {
        const remoteDoc = Automerge.load(bytes) as Automerge.Doc<CanvasDoc>;
        merged = Automerge.merge(docRef.current, remoteDoc);
      } catch (err) {
        console.error("[sync] failed to merge remote doc:", err);
        return;
      }
      const oldHeads = Automerge.getHeads(docRef.current);
      const newHeads = Automerge.getHeads(merged);
      const changed =
        oldHeads.length !== newHeads.length ||
        oldHeads.some((h, i) => h !== newHeads[i]);
      // Always swap in the merged handle even when nothing changed. Automerge 3
      // consumes the local handle inside merge(); reusing the old reference
      // later throws "Attempting to change an outdated document".
      docRef.current = merged;
      if (!changed) {
        setDoc(merged);
        return;
      }
      updateDoc(merged);
      // Echo merged state so any local-only changes propagate to peers.
      // Converges in one round: peer's heads after merge match ours, so
      // they don't re-echo.
      broadcastDoc(merged);
    };

    socket.onclose = () => {
      // Guard: only clear the ref if this socket is still the active one.
      // Without this, a stale close from a previous socket (e.g. from React
      // StrictMode double-effect cleanup) would null out the new socket.
      if (wsRef.current !== socket) return;
      wsRef.current = null;
      setWs(null);
      // Auto-reconnect on unexpected drops (server kick from a peer's reset,
      // dev-server restart, network blip). Skip when we closed on purpose.
      if (!onlineRef.current || intentionalCloseRef.current) return;
      const attempt = reconnectAttemptsRef.current;
      reconnectAttemptsRef.current = attempt + 1;
      const delay = Math.min(500 * 2 ** attempt, 8000);
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        setReconnectNonce((n) => n + 1);
      }, delay);
    };
    socket.onerror = (e) => console.error("[ws] error", e);

    return () => { intentionalCloseRef.current = true; socket.close(); };
    // This effect intentionally depends ONLY on [online, reconnectNonce]. The
    // helpers it calls (broadcastDoc/broadcastResetSignal/replaceDocFromSeed/
    // updateDoc) only read refs and stable state setters, so stale closures are
    // safe. Adding them as deps would tear down and recreate the socket on
    // every render, breaking sync and presence.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, reconnectNonce]);

  // Canvas operations — each captures its own inverse for correctness on undo
  // after concurrent remote edits (see CanvasOp + applyOp above).
  const addNote = useCallback((x: number, y: number, text = "New note", color: NoteColor = "yellow") => {
    const note: StickyNote = {
      id: uuid(), text, x, y,
      color, author: userName, createdAt: Date.now(),
    };
    applyOp({
      do: (d) => { d.notes.push(note); },
      undo: (d) => {
        const i = d.notes.findIndex((n) => n.id === note.id);
        if (i >= 0) d.notes.splice(i, 1);
      },
    });
    return note.id;
  }, [applyOp, userName]);

  const updateNote = useCallback((id: string, patch: Partial<StickyNote>) => {
    const prev = docRef.current.notes.find((n) => n.id === id);
    if (!prev) return;
    const inverse: Partial<StickyNote> = {};
    for (const key of Object.keys(patch) as (keyof StickyNote)[]) {
      (inverse as Record<string, unknown>)[key] = prev[key];
    }
    applyOp({
      do: (d) => { const n = d.notes.find((n) => n.id === id); if (n) Object.assign(n, patch); },
      undo: (d) => { const n = d.notes.find((n) => n.id === id); if (n) Object.assign(n, inverse); },
    });
  }, [applyOp]);

  const deleteNote = useCallback((id: string) => {
    const removed = docRef.current.notes.find((n) => n.id === id);
    if (!removed) return;
    const snapshot: StickyNote = JSON.parse(JSON.stringify(removed));
    applyOp({
      do: (d) => { const i = d.notes.findIndex((n) => n.id === id); if (i >= 0) d.notes.splice(i, 1); },
      undo: (d) => { d.notes.push(snapshot); },
    });
  }, [applyOp]);

  const addShape = useCallback((x: number, y: number, type: Shape["type"], color: string) => {
    const shape: Shape = {
      id: uuid(),
      type, x, y, size: 60, color,
      author: userName,
    };
    applyOp({
      do: (d) => { d.shapes.push(shape); },
      undo: (d) => {
        const i = d.shapes.findIndex((s) => s.id === shape.id);
        if (i >= 0) d.shapes.splice(i, 1);
      },
    });
  }, [applyOp, userName]);

  const applyAiProposal = useCallback((edits: AiProposalEdit[]): boolean => {
    const noteAdds: StickyNote[] = [];
    const shapeAdds: Shape[] = [];
    const noteUpdates: Array<{ id: string; text: string; previousText: string }> = [];
    const noteMoves: Array<{ id: string; x: number; y: number; previousX: number; previousY: number }> = [];
    const noteDeletes: StickyNote[] = [];
    const deletedHighlightSnaps: CanvasHighlight[] = [];
    const taskAdds: CanvasTask[] = [];
    const highlightAdds: CanvasHighlight[] = [];
    const acceptedAt = Date.now();

    for (const edit of edits) {
      if (edit.type === "addNote") {
        noteAdds.push({
          id: uuid(),
          text: edit.text,
          x: edit.x,
          y: edit.y,
          color: edit.color ?? "purple",
          author: "AI synthesis",
          createdAt: acceptedAt,
        });
        continue;
      }

      if (edit.type === "updateNoteText") {
        const current = docRef.current.notes.find((note) => note.id === edit.id);
        if (current) {
          noteUpdates.push({ id: edit.id, text: edit.text, previousText: current.text });
        }
        continue;
      }

      if (edit.type === "moveNote") {
        const current = docRef.current.notes.find((note) => note.id === edit.id);
        if (current) {
          noteMoves.push({
            id: edit.id,
            x: edit.x,
            y: edit.y,
            previousX: current.x,
            previousY: current.y,
          });
        }
        continue;
      }

      if (edit.type === "deleteNote") {
        const current = docRef.current.notes.find((note) => note.id === edit.id);
        if (current) {
          noteDeletes.push(JSON.parse(JSON.stringify(current)));
          deletedHighlightSnaps.push(
            ...JSON.parse(JSON.stringify((docRef.current.highlights ?? []).filter((highlight) => highlight.noteId === edit.id))),
          );
        }
        continue;
      }

      if (edit.type === "addTask") {
        const task: CanvasTask = {
          id: uuid(),
          title: edit.title,
          status: "todo",
          sourceNoteIds: [...(edit.sourceNoteIds ?? [])],
          sourceGroundingIds: [...(edit.sourceGroundingIds ?? [])],
          author: userName,
          createdAt: acceptedAt,
        };
        if (edit.owner) task.owner = edit.owner;
        if (edit.timing) task.timing = edit.timing;
        if (edit.sourceAuthors?.length) task.sourceAuthors = [...edit.sourceAuthors];
        if (edit.sourceCreatedAt?.length) task.sourceCreatedAt = [...edit.sourceCreatedAt];
        taskAdds.push(task);
        continue;
      }

      if (edit.type === "addHighlight") {
        if (docRef.current.notes.some((note) => note.id === edit.noteId)) {
          const highlight: CanvasHighlight = {
            id: uuid(),
            noteId: edit.noteId,
            text: edit.text,
            color: edit.color ?? "#c83f4f",
            author: userName,
            createdAt: acceptedAt,
            sourceNoteIds: [...(edit.sourceNoteIds ?? [edit.noteId])],
            sourceGroundingIds: [...(edit.sourceGroundingIds ?? [])],
          };
          if (edit.rationale) highlight.rationale = edit.rationale;
          highlightAdds.push(highlight);
        }
        continue;
      }

      if (edit.type === "replaceSpan") {
        // Surgical phrase replacement on an existing note. We reuse the
        // noteUpdates channel so undo/redo behaves exactly like a text edit.
        // `find` must appear verbatim in the current note text; if not, the
        // edit is dropped. The caller uses the boolean return value to keep
        // the draft visible and tell the reviewer to regenerate.
        const current = docRef.current.notes.find((note) => note.id === edit.noteId);
        if (current && current.text.includes(edit.find)) {
          // Skip if there is already a pending update queued for this note,
          // so we do not double-apply onto stale `previousText`.
          if (!noteUpdates.some((update) => update.id === edit.noteId)) {
            const nextText = current.text.replace(edit.find, edit.replace);
            noteUpdates.push({ id: edit.noteId, text: nextText, previousText: current.text });
          }
        }
        continue;
      }

      if (edit.type === "addShape") {
        shapeAdds.push({
          id: uuid(),
          type: edit.shape,
          x: edit.x,
          y: edit.y,
          size: edit.size ?? 60,
          color: edit.color ?? "#7b61ff",
          author: userName,
        });
      }
    }

    if (
      noteAdds.length === 0 &&
      shapeAdds.length === 0 &&
      noteUpdates.length === 0 &&
      noteMoves.length === 0 &&
      noteDeletes.length === 0 &&
      taskAdds.length === 0 &&
      highlightAdds.length === 0
    ) return false;

    applyOp({
      do: (d) => {
        noteAdds.forEach((note) => d.notes.push(note));
        shapeAdds.forEach((shape) => d.shapes.push(shape));
        if (!d.tasks) d.tasks = [];
        taskAdds.forEach((task) => d.tasks.push(task));
        if (!d.highlights) d.highlights = [];
        highlightAdds.forEach((highlight) => d.highlights.push(highlight));
        noteUpdates.forEach((update) => {
          const note = d.notes.find((n) => n.id === update.id);
          if (note) note.text = update.text;
        });
        noteMoves.forEach((move) => {
          const note = d.notes.find((n) => n.id === move.id);
          if (note) {
            note.x = move.x;
            note.y = move.y;
          }
        });
        noteDeletes.forEach((deletedNote) => {
          const i = d.notes.findIndex((note) => note.id === deletedNote.id);
          if (i >= 0) d.notes.splice(i, 1);
        });
        if (d.highlights) {
          noteDeletes.forEach((deletedNote) => {
            for (let i = d.highlights.length - 1; i >= 0; i--) {
              if (d.highlights[i].noteId === deletedNote.id) d.highlights.splice(i, 1);
            }
          });
        }
      },
      undo: (d) => {
        noteDeletes.forEach((note) => {
          if (!d.notes.some((existing) => existing.id === note.id)) d.notes.push(note);
        });
        if (!d.highlights) d.highlights = [];
        deletedHighlightSnaps.forEach((highlight) => {
          if (!d.highlights.some((existing) => existing.id === highlight.id)) d.highlights.push(highlight);
        });
        highlightAdds.forEach((highlight) => {
          const i = d.highlights.findIndex((item) => item.id === highlight.id);
          if (i >= 0) d.highlights.splice(i, 1);
        });
        taskAdds.forEach((task) => {
          const i = d.tasks.findIndex((t) => t.id === task.id);
          if (i >= 0) d.tasks.splice(i, 1);
        });
        noteMoves.forEach((move) => {
          const note = d.notes.find((n) => n.id === move.id);
          if (note) {
            note.x = move.previousX;
            note.y = move.previousY;
          }
        });
        noteUpdates.forEach((update) => {
          const note = d.notes.find((n) => n.id === update.id);
          if (note) note.text = update.previousText;
        });
        shapeAdds.forEach((shape) => {
          const i = d.shapes.findIndex((s) => s.id === shape.id);
          if (i >= 0) d.shapes.splice(i, 1);
        });
        noteAdds.forEach((note) => {
          const i = d.notes.findIndex((n) => n.id === note.id);
          if (i >= 0) d.notes.splice(i, 1);
        });
      },
    });
    return true;
  }, [applyOp, userName]);

  const toggleTask = useCallback((id: string) => {
    const task = docRef.current.tasks.find((item) => item.id === id);
    if (!task) return;
    const previousStatus = task.status;
    const previousCompletedBy = task.completedBy;
    const previousCompletedAt = task.completedAt;
    const nextStatus = previousStatus === "done" ? "todo" : "done";
    const completedAt = Date.now();
    applyOp({
      do: (d) => {
        const item = d.tasks.find((t) => t.id === id);
        if (!item) return;
        item.status = nextStatus;
        if (nextStatus === "done") {
          item.completedBy = userName;
          item.completedAt = completedAt;
        } else {
          delete item.completedBy;
          delete item.completedAt;
        }
      },
      undo: (d) => {
        const item = d.tasks.find((t) => t.id === id);
        if (!item) return;
        item.status = previousStatus;
        if (previousCompletedBy) item.completedBy = previousCompletedBy;
        else delete item.completedBy;
        if (previousCompletedAt) item.completedAt = previousCompletedAt;
        else delete item.completedAt;
      },
    });
  }, [applyOp, userName]);

  const deleteShape = useCallback((id: string) => {
    const removed = docRef.current.shapes.find((s) => s.id === id);
    if (!removed) return;
    const snapshot: Shape = JSON.parse(JSON.stringify(removed));
    applyOp({
      do: (d) => { const i = d.shapes.findIndex((s) => s.id === id); if (i >= 0) d.shapes.splice(i, 1); },
      undo: (d) => { d.shapes.push(snapshot); },
    });
  }, [applyOp]);

  const moveItem = useCallback((kind: "note" | "shape", id: string, x: number, y: number) => {
    // Move is not pushed onto the undo stack (would be too noisy during drag).
    // To make undo cover drag, capture the start position on mousedown and
    // emit a single applyOp on mouseup. Out of scope for Act 1.
    const next = Automerge.change(docRef.current, (d) => {
      const arr = kind === "note" ? d.notes : d.shapes;
      const item = (arr as Array<{ id: string; x: number; y: number }>).find((i) => i.id === id);
      if (item) { item.x = x; item.y = y; }
    });
    updateDoc(next);
    broadcastDoc(next);
  }, []);

  const addStroke = useCallback((stroke: InkStroke) => {
    applyOp({
      do: (d) => { d.strokes.push(stroke); },
      undo: (d) => {
        const i = d.strokes.findIndex((s) => s.id === stroke.id);
        if (i >= 0) d.strokes.splice(i, 1);
      },
    });
  }, [applyOp]);

  const deleteStroke = useCallback((id: string) => {
    const removed = docRef.current.strokes.find((s) => s.id === id);
    if (!removed) return;
    const snapshot: InkStroke = JSON.parse(JSON.stringify(removed));
    applyOp({
      do: (d) => { const i = d.strokes.findIndex((s) => s.id === id); if (i >= 0) d.strokes.splice(i, 1); },
      undo: (d) => { d.strokes.push(snapshot); },
    });
  }, [applyOp]);

  // Shared text: diff-based splice. Compute common prefix/suffix between old
  // and new value, then issue a single Automerge.splice. This gives correct
  // character-level CRDT merge for concurrent edits and is O(n) per change.
  // Bypasses the canvas undo stack — let Automerge text history + browser
  // native undo cover this surface.
  const setText = useCallback((newValue: string) => {
    const oldValue = docRef.current.text ?? "";
    if (oldValue === newValue) return;
    let start = 0;
    const minLen = Math.min(oldValue.length, newValue.length);
    while (start < minLen && oldValue.charCodeAt(start) === newValue.charCodeAt(start)) start++;
    let oldEnd = oldValue.length;
    let newEnd = newValue.length;
    while (oldEnd > start && newEnd > start && oldValue.charCodeAt(oldEnd - 1) === newValue.charCodeAt(newEnd - 1)) {
      oldEnd--; newEnd--;
    }
    const del = oldEnd - start;
    const ins = newValue.slice(start, newEnd);
    const next = Automerge.change(docRef.current, (d) => {
      Automerge.splice(d as CanvasDoc, ["text"], start, del, ins);
    });
    updateDoc(next);
    broadcastDoc(next);
  }, []);

  const clearText = useCallback(() => {
    const len = (docRef.current.text ?? "").length;
    if (len === 0) return;
    const next = Automerge.change(docRef.current, (d) => {
      Automerge.splice(d as CanvasDoc, ["text"], 0, len, "");
    });
    updateDoc(next);
    broadcastDoc(next);
  }, []);

  // Note text: diff-based splice into the note's text field. Same algorithm
  // as setText, but pathed into the note inside the notes array. This gives
  // character-level CRDT merge for two users typing into the same sticky.
  // Skips the undo stack — typing keystrokes shouldn't fill it.
  const setNoteText = useCallback((id: string, newValue: string) => {
    const idx = docRef.current.notes.findIndex((n) => n.id === id);
    if (idx < 0) return;
    const oldValue = docRef.current.notes[idx].text ?? "";
    if (oldValue === newValue) return;
    let start = 0;
    const minLen = Math.min(oldValue.length, newValue.length);
    while (start < minLen && oldValue.charCodeAt(start) === newValue.charCodeAt(start)) start++;
    let oldEnd = oldValue.length;
    let newEnd = newValue.length;
    while (oldEnd > start && newEnd > start && oldValue.charCodeAt(oldEnd - 1) === newValue.charCodeAt(newEnd - 1)) {
      oldEnd--; newEnd--;
    }
    const del = oldEnd - start;
    const ins = newValue.slice(start, newEnd);
    const next = Automerge.change(docRef.current, (d) => {
      Automerge.splice(d as CanvasDoc, ["notes", idx, "text"], start, del, ins);
    });
    updateDoc(next);
    broadcastDoc(next);
  }, []);

  const clearCanvas = useCallback(() => {
    if (!window.confirm("Clear all notes, shapes, strokes, tasks, and highlights? This cannot be undone across sessions.")) return;
    // Capture snapshots for undo
    const noteSnaps = JSON.parse(JSON.stringify([...docRef.current.notes]));
    const shapeSnaps = JSON.parse(JSON.stringify([...docRef.current.shapes]));
    const strokeSnaps = JSON.parse(JSON.stringify([...(docRef.current.strokes ?? [])]));
    const taskSnaps = JSON.parse(JSON.stringify([...(docRef.current.tasks ?? [])]));
    const highlightSnaps = JSON.parse(JSON.stringify([...(docRef.current.highlights ?? [])]));
    applyOp({
      do: (d) => {
        d.notes.splice(0, d.notes.length);
        d.shapes.splice(0, d.shapes.length);
        if (d.strokes) d.strokes.splice(0, d.strokes.length);
        if (d.tasks) d.tasks.splice(0, d.tasks.length);
        if (d.highlights) d.highlights.splice(0, d.highlights.length);
      },
      undo: (d) => {
        noteSnaps.forEach((n: StickyNote) => d.notes.push(n));
        shapeSnaps.forEach((s: Shape) => d.shapes.push(s));
        strokeSnaps.forEach((s: InkStroke) => { if (d.strokes) d.strokes.push(s); });
        taskSnaps.forEach((t: CanvasTask) => { if (d.tasks) d.tasks.push(t); });
        highlightSnaps.forEach((h: CanvasHighlight) => { if (d.highlights) d.highlights.push(h); });
      },
    });
  }, [applyOp]);

  return { doc, online, setOnline, ws, docId: DOC_ID, isResetRoom: RESET_DOC, addNote, updateNote, deleteNote, setNoteText, addShape, deleteShape, moveItem, addStroke, deleteStroke, clearCanvas, setText, clearText, applyAiProposal, toggleTask, undo, redo, canUndo, canRedo };
}
