// Canvas document schema for Automerge

export type NoteColor = "yellow" | "blue" | "green" | "pink" | "purple" | "orange";
export type ShapeType = "circle" | "square" | "triangle" | "star";

export interface StickyNote {
  id: string;
  text: string;
  x: number;
  y: number;
  color: NoteColor;
  author: string;
  createdAt: number;
}

export interface Shape {
  id: string;
  type: ShapeType;
  x: number;
  y: number;
  size: number;
  color: string;
  author: string;
}

// Freehand ink stroke: flat [x0,y0,x1,y1,...] avoids nested objects in Automerge
export interface InkStroke {
  id: string;
  points: number[];
  color: string;
  width: number;
  author: string;
}

export interface CanvasHighlight {
  id: string;
  noteId: string;
  text: string;
  color: string;
  author: string;
  createdAt: number;
  sourceNoteIds?: string[];
  sourceGroundingIds?: string[];
  rationale?: string;
}

export type TaskStatus = "todo" | "done";

export interface CanvasTask {
  id: string;
  title: string;
  status: TaskStatus;
  owner?: string;
  timing?: string;
  sourceAuthors?: string[];
  sourceCreatedAt?: number[];
  sourceNoteIds?: string[];
  sourceGroundingIds?: string[];
  completedBy?: string;
  completedAt?: number;
  author: string;
  createdAt: number;
}

export interface CanvasDoc {
  notes: StickyNote[];
  shapes: Shape[];
  strokes: InkStroke[];
  tasks: CanvasTask[];
  highlights: CanvasHighlight[];
  // Shared collaborative text. In Automerge v3 a plain string field becomes a
  // text CRDT when mutated via Automerge.splice, giving character-level merge.
  text: string;
}
