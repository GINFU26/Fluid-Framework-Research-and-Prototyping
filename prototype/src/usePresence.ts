import { useEffect, useState, useCallback } from "react";

// Where a user's text caret is, if they're typing. surface = "text" is the
// shared text view; surface = "note" is a sticky on the canvas (noteId).
export type CaretPresence =
  | { surface: "text"; offset: number }
  | { surface: "note"; noteId: string; offset: number };

export interface UserPresence {
  userName: string;
  color: string;
  cursorX: number;
  cursorY: number;
  caret: CaretPresence | null;
  selectedNoteIds: string[];
  lastSeen: number;
}

const COLORS = ["#7b61ff", "#36a3ff", "#2ebf91", "#ff8bb3", "#8f7be8", "#2bb3bd"];

function hashColor(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % COLORS.length;
  return COLORS[h];
}

const PRESENCE_TIMEOUT_MS = 5000;

export function usePresence(userName: string, ws: WebSocket | null) {
  const [others, setOthers] = useState<Map<string, UserPresence>>(new Map());
  const myColor = hashColor(userName);

  // Presence messages carry partial updates: senders include only the fields
  // they changed (cursorX/Y for mouse, caret for text). Receivers merge into
  // the existing per-user record so an unrelated update doesn't blank prior
  // state.
  const sendCursor = useCallback((x: number, y: number) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "presence", userName, color: myColor, cursorX: x, cursorY: y }));
  }, [ws, userName, myColor]);

  const sendCaret = useCallback((caret: CaretPresence | null) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "presence", userName, color: myColor, caret }));
  }, [ws, userName, myColor]);

  // Selection broadcast. Selected note ids are pure UI state (not in the
  // Automerge doc) so they need their own presence channel. Sending an
  // empty array on deselect lets peers clear the colored ring.
  const sendSelection = useCallback((selectedNoteIds: string[]) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "presence", userName, color: myColor, selectedNoteIds }));
  }, [ws, userName, myColor]);

  useEffect(() => {
    if (!ws) return;
    const handler = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      try {
        const msg = JSON.parse(event.data);
        if (msg.type !== "presence") return;
        if (msg.userName === userName) return;
        setOthers((prev) => {
          const next = new Map(prev);
          const existing = next.get(msg.userName);
          next.set(msg.userName, {
            userName: msg.userName,
            color: msg.color ?? existing?.color ?? "#7b61ff",
            cursorX: msg.cursorX ?? existing?.cursorX ?? -9999,
            cursorY: msg.cursorY ?? existing?.cursorY ?? -9999,
            caret: msg.caret !== undefined ? msg.caret : (existing?.caret ?? null),
            selectedNoteIds: Array.isArray(msg.selectedNoteIds)
              ? msg.selectedNoteIds.filter((id: unknown): id is string => typeof id === "string")
              : (existing?.selectedNoteIds ?? []),
            lastSeen: Date.now(),
          });
          return next;
        });
      } catch { /* ignore */ }
    };
    ws.addEventListener("message", handler);
    return () => ws.removeEventListener("message", handler);
  }, [ws, userName]);

  useEffect(() => {
    if (!ws) {
      window.queueMicrotask(() => setOthers(new Map()));
    }
  }, [ws]);

  // Heartbeat so peers don't evict us when nothing is happening locally
  // (e.g. both users are idle on the text surface, where there is no mouse
  // tracking to keep traffic flowing). Send a minimal presence ping every
  // 2.5s — well under PRESENCE_TIMEOUT_MS. The receiver's merge logic falls
  // back to existing fields when a ping omits them, so this doesn't clobber
  // cursor/caret/selection state.
  useEffect(() => {
    if (!ws) return;
    const send = () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "presence", userName, color: myColor }));
    };
    // Fire immediately if the socket is already open, AND again the instant it
    // opens. The relay is a stateless broadcast that never replays presence to
    // a peer that joins later, so without an on-open ping a freshly connected
    // peer stays invisible for up to one heartbeat interval (2.5s) — long
    // enough to read as "presence is broken" when opening a fresh tab.
    send();
    ws.addEventListener("open", send);
    const id = setInterval(send, 2500);
    return () => {
      clearInterval(id);
      ws.removeEventListener("open", send);
    };
  }, [ws, userName, myColor]);

  useEffect(() => {
    const id = setInterval(() => {
      setOthers((prev) => {
        const now = Date.now();
        let changed = false;
        const next = new Map(prev);
        for (const [k, v] of next) {
          if (now - v.lastSeen > PRESENCE_TIMEOUT_MS) { next.delete(k); changed = true; }
        }
        return changed ? next : prev;
      });
    }, 1000);
    return () => clearInterval(id);
  }, []);

  return { others, myColor, sendCursor, sendCaret, sendSelection };
}
