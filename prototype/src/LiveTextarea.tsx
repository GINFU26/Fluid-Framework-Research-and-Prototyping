import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from "react";

// Compute where a cursor at `cursor` should land after the string changes
// from `oldStr` to `newStr`. Inserts strictly before the cursor push it
// right; deletions before push it left; edits straddling collapse it to the
// end of the replaced region. Keeps the local cursor stable while a remote
// peer edits elsewhere in the same field.
function adjustCursor(cursor: number, oldStr: string, newStr: string): number {
  if (oldStr === newStr) return cursor;
  let start = 0;
  const minLen = Math.min(oldStr.length, newStr.length);
  while (start < minLen && oldStr.charCodeAt(start) === newStr.charCodeAt(start)) start++;
  let oldEnd = oldStr.length;
  let newEnd = newStr.length;
  while (oldEnd > start && newEnd > start && oldStr.charCodeAt(oldEnd - 1) === newStr.charCodeAt(newEnd - 1)) {
    oldEnd--; newEnd--;
  }
  const del = oldEnd - start;
  const insLen = newEnd - start;
  if (cursor <= start) return cursor;
  if (cursor >= start + del) return cursor + (insLen - del);
  return start + insLen;
}

type TextareaProps = Omit<
  React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  "value" | "defaultValue" | "onChange" | "onSelect" | "onFocus" | "onBlur"
>;

interface LiveTextareaProps extends TextareaProps {
  value: string;
  onTextChange: (next: string) => void;
  autoGrow?: boolean;
  // Fires whenever the user's caret moves (typing, click, arrow keys, focus).
  // Called with null on blur or unmount so peers can hide the caret.
  onCaretChange?: (offset: number | null) => void;
}

function resizeToContent(textarea: HTMLTextAreaElement) {
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;
}

// A textarea bound to a CRDT-backed string. Renders uncontrolled (defaultValue
// + ref) so React re-renders don't reset the cursor on every keystroke. When
// `value` changes from a remote update, the diff is applied to the DOM
// textarea and the cursor is adjusted in place.
export const LiveTextarea = forwardRef<HTMLTextAreaElement, LiveTextareaProps>(
  function LiveTextarea({ value, onTextChange, autoGrow = false, onCaretChange, ...rest }, forwardedRef) {
    const ref = useRef<HTMLTextAreaElement>(null);
    const prevRef = useRef(value);
    // Hold the latest onCaretChange in a ref so the unmount cleanup below
    // doesn't depend on its identity. Callers commonly pass an inline arrow
    // (so they can wrap the offset into a CaretPresence shape), which would
    // otherwise make the effect's cleanup fire on every render and broadcast
    // a spurious "caret:null" after every keystroke — clobbering the real
    // caret on every peer.
    const onCaretChangeRef = useRef(onCaretChange);
    onCaretChangeRef.current = onCaretChange;

    useImperativeHandle(forwardedRef, () => ref.current as HTMLTextAreaElement, []);

    useLayoutEffect(() => {
      const ta = ref.current;
      if (!ta) return;
      const prev = prevRef.current;
      if (value !== ta.value) {
        const focused = document.activeElement === ta;
        const selStart = ta.selectionStart;
        const selEnd = ta.selectionEnd;
        ta.value = value;
        if (focused) {
          const newStart = adjustCursor(selStart, prev, value);
          const newEnd = selEnd === selStart ? newStart : adjustCursor(selEnd, prev, value);
          ta.setSelectionRange(newStart, newEnd);
        }
      }
      if (autoGrow) resizeToContent(ta);
      prevRef.current = value;
    }, [autoGrow, value]);

    useLayoutEffect(() => {
      const ta = ref.current;
      if (autoGrow && ta) resizeToContent(ta);
    }, [autoGrow]);

    // Tell peers our caret is gone when the component unmounts (e.g., user
    // switches views). Read from the ref so this effect runs once, not on
    // every render — see the comment on onCaretChangeRef above.
    useEffect(() => {
      return () => onCaretChangeRef.current?.(null);
    }, []);

    const reportCaret = () => {
      const ta = ref.current;
      if (!ta || !onCaretChange) return;
      onCaretChange(ta.selectionStart);
    };

    return (
      <textarea
        ref={ref}
        defaultValue={value}
        onChange={(e) => {
          onTextChange(e.target.value);
          if (autoGrow) resizeToContent(e.target);
          reportCaret();
        }}
        onSelect={reportCaret}
        onFocus={reportCaret}
        onBlur={() => onCaretChange?.(null)}
        {...rest}
      />
    );
  }
);
