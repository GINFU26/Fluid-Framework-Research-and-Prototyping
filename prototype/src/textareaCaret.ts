// Computes the pixel position of a character offset inside a <textarea> by
// rendering an off-screen mirror <div> with the same typography/box styles
// and measuring where a marker <span> at that offset lands.
//
// This is the standard technique used by libraries like `textarea-caret`.
// Mirror is cached as a module-level singleton — one DOM node reused across
// all callers and all textareas.

const MIRROR_PROPS = [
  "boxSizing",
  "width", "height",
  "overflowX", "overflowY",
  "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
  "borderTopStyle", "borderRightStyle", "borderBottomStyle", "borderLeftStyle",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "fontStyle", "fontVariant", "fontWeight", "fontStretch", "fontSize",
  "lineHeight", "fontFamily",
  "textAlign", "textTransform", "textIndent", "textDecoration",
  "letterSpacing", "wordSpacing", "tabSize",
  "whiteSpace", "wordWrap", "wordBreak", "direction",
] as const;

let mirror: HTMLDivElement | null = null;

function ensureMirror(): HTMLDivElement {
  if (mirror) return mirror;
  const div = document.createElement("div");
  div.setAttribute("aria-hidden", "true");
  div.style.position = "absolute";
  div.style.top = "0";
  div.style.left = "-9999px";
  div.style.visibility = "hidden";
  div.style.whiteSpace = "pre-wrap";
  div.style.wordWrap = "break-word";
  document.body.appendChild(div);
  mirror = div;
  return div;
}

export function getCaretCoords(
  textarea: HTMLTextAreaElement,
  offset: number
): { top: number; left: number; height: number } {
  const div = ensureMirror();
  const cs = window.getComputedStyle(textarea);
  for (const p of MIRROR_PROPS) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (div.style as any)[p] = (cs as any)[p];
  }

  // Use clientWidth (inner width including padding, excluding border and
  // scrollbar) minus horizontal padding to get the exact content width.
  // This is more accurate than getComputedStyle().width which doesn't
  // account for the visible scrollbar width.
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  div.style.width = `${textarea.clientWidth - padL - padR}px`;
  div.style.boxSizing = "content-box";

  // text-align inherits from ancestor CSS (e.g. #root { text-align: center }).
  // Centering shifts span.offsetLeft away from what the textarea renders.
  // Force left-to-right layout so mirror and textarea agree.
  div.style.textAlign = "left";
  div.style.direction = cs.direction || "ltr";
  const text = textarea.value;
  const safeOffset = Math.max(0, Math.min(offset, text.length));
  div.textContent = text.slice(0, safeOffset);
  const span = document.createElement("span");
  // A single character gives us the caret position (offsetTop/Left) and
  // one line's height (offsetHeight). Using the remaining text here was a
  // bug: span.offsetHeight would equal the height of ALL remaining lines,
  // producing a very tall caret bar.
  span.textContent = "|";
  div.appendChild(span);
  const top = span.offsetTop;
  const left = span.offsetLeft;
  const height = span.offsetHeight || parseInt(cs.lineHeight, 10) || parseInt(cs.fontSize, 10) || 16;
  div.removeChild(span);
  return {
    top: top - textarea.scrollTop,
    left: left - textarea.scrollLeft,
    height,
  };
}
