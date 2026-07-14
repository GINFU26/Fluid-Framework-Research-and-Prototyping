import type { StickyNote } from "./schema";
import type { CaretPresence, UserPresence } from "./usePresence";
import type { AiProvider } from "./ai";

export interface LiveSemanticConflictSuggestion {
  id: string;
  noteId: string;
  participants: string[];
  reason: string;
  tension: string;
  sourceTrail: string[];
}

interface BuildLiveSemanticConflictArgs {
  notes: StickyNote[];
  userName: string;
  localCaret: CaretPresence | null;
  others: UserPresence[];
  activeNoteId?: string | null;
}

interface ParticipantClaim {
  name: string;
  text: string;
}

export function buildLiveSemanticConflictSuggestion({
  notes,
  userName,
  localCaret,
  others,
  activeNoteId,
}: BuildLiveSemanticConflictArgs): LiveSemanticConflictSuggestion | null {
  const realNoteId = localCaret?.surface === "note" ? localCaret.noteId : activeNoteId ?? null;
  if (!realNoteId) return null;

  const note = notes.find((item) => item.id === realNoteId);
  if (!note || isResolvedMergeNote(note.text)) return null;

  const claims = extractParticipantClaims(note.text);
  const remoteEditors = others.filter((user) => user.caret?.surface === "note" && user.caret.noteId === note.id);
  const claimNames = new Set(claims.map((claim) => claim.name.toLowerCase()));
  const namedParallelSignal = activeNoteId === note.id &&
    claims.length >= 2 &&
    claimNames.has(userName.toLowerCase()) &&
    (others.length === 0 || others.some((user) => claimNames.has(user.userName.toLowerCase())));
  const isRealParallelEdit = Boolean(realNoteId && (remoteEditors.length > 0 || namedParallelSignal));
  if (!isRealParallelEdit) return null;

  if (!hasSemanticConflictSignal(note.text, claims.length)) return null;

  const participants = uniqueNames([
    userName,
    ...remoteEditors.map((user) => user.userName),
    ...claims.map((claim) => claim.name),
  ]);
  if (participants.length < 2) return null;

  const sourceTrail = buildSourceTrail(note.text, participants, claims);
  const tension = NEUTRAL_TENSION_FALLBACK;
  const id = `live-semantic-${note.id}-${hashText(note.text)}-${participants.join("-")}`;

  return {
    id,
    noteId: note.id,
    participants,
    reason: `${participants.slice(0, 3).join(" + ")} are editing the same decision note.`,
    tension,
    sourceTrail,
  };
}

function isResolvedMergeNote(text: string): boolean {
  const firstLine = text.trim().split(/\r?\n/)[0]?.toLowerCase() ?? "";
  return firstLine === "semantic merge" || firstLine === "live semantic merge";
}

function hasSemanticConflictSignal(text: string, claimCount: number): boolean {
  const normalized = text.toLowerCase();
  if (claimCount >= 2) return true;
  if (normalized.trim().length < 36 || normalized.trim() === "new note") return false;
  return /\b(but|however|conflict|tradeoff|risk|blocked|manual|human review|autoplay|private|shared|accept|trust)\b/.test(normalized);
}

function extractParticipantClaims(text: string): ParticipantClaim[] {
  const claims: ParticipantClaim[] = [];
  const seen = new Set<string>();
  for (const line of text.replace(/\r/g, "").split("\n")) {
    const match = line.trim().match(/^([A-Z][A-Za-z ]{1,32})\s*[:-]\s*(.+)$/);
    if (!match?.[1] || !match[2]) continue;
    const name = match[1].trim();
    const body = compressLine(match[2]);
    const key = `${name}:${body}`;
    if (!body || seen.has(key)) continue;
    seen.add(key);
    claims.push({ name, text: body });
  }
  return claims.slice(0, 4);
}

function buildSourceTrail(text: string, participants: string[], claims: ParticipantClaim[]): string[] {
  if (claims.length > 0) {
    return claims.map((claim) => `${claim.name}: ${claim.text}`);
  }

  const fallbackSentences = splitSentences(text).slice(0, Math.max(2, Math.min(participants.length, 4)));
  return participants.slice(0, 4).map((name, index) =>
    `${name}: ${fallbackSentences[index] ?? fallbackSentences[0] ?? "parallel edit intent was captured in this note."}`
  );
}

const NEUTRAL_TENSION_FALLBACK =
  "Both collaborator intents are preserved here; review the unresolved tradeoff before committing.";

const TENSION_SYSTEM_PROMPT = [
  "You analyze a live edit conflict on a shared sticky note.",
  "Given the note text, return ONE short sentence (max 24 words) that names the unresolved tradeoff between the collaborators.",
  "Do not invent facts not present in the note. Do not list more than one tradeoff. No prefixes, no quotes, no markdown.",
].join("\n");

export async function enrichTensionWithAi(
  text: string,
  ai: AiProvider,
  options: { signal?: AbortSignal } = {},
): Promise<string | null> {
  if (typeof ai.chatOnce !== "function") return null;
  try {
    const result = await ai.chatOnce(
      TENSION_SYSTEM_PROMPT,
      `Note text:\n${text}`,
      { signal: options.signal },
    );
    const cleaned = result.replace(/^["'`\s]+|["'`\s]+$/g, "").trim();
    if (!cleaned || cleaned.length < 8) return null;
    return cleaned;
  } catch {
    return null;
  }
}

function uniqueNames(names: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  names.forEach((name) => {
    const cleaned = name.trim();
    const key = cleaned.toLowerCase();
    if (!cleaned || seen.has(key)) return;
    seen.add(key);
    result.push(cleaned);
  });
  return result.slice(0, 5);
}

function splitSentences(text: string): string[] {
  return text
    .replace(/\r/g, " ")
    .split(/(?<=[.!?])\s+|\n+/)
    .map(compressLine)
    .filter(Boolean)
    .filter((sentence) => !/^decision conflict$/i.test(sentence))
    .slice(0, 5);
}

function compressLine(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= 150) return cleaned;
  return `${cleaned.slice(0, 147).trim()}...`;
}

function hashText(text: string): string {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}
