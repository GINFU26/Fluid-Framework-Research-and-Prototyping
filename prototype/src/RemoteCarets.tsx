import { useLayoutEffect, useState, type RefObject } from "react";
import { getCaretCoords } from "./textareaCaret";

interface RemoteCaret {
  userName: string;
  color: string;
  offset: number;
}

interface RemoteCaretsProps {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  text: string;
  carets: RemoteCaret[];
  // If true (default), shows the username tag above the caret. Disable for
  // tiny surfaces like sticky notes where the tag would overflow.
  showLabels?: boolean;
}

// Renders blinking colored caret bars + name tags at the screen position of
// each remote user's text-caret inside a sibling <textarea>. The overlay is
// pointer-events: none so it doesn't block input.
export function RemoteCarets({ textareaRef, text, carets, showLabels = true }: RemoteCaretsProps) {
  const [positions, setPositions] = useState<
    Array<{ userName: string; color: string; top: number; left: number; height: number }>
  >([]);

  // Recompute on every change to text, carets, or the textarea ref. Scroll
  // events also need to re-measure, hence the listener.
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) { setPositions((prev) => (prev.length === 0 ? prev : [])); return; }

    const recompute = () => {
      if (carets.length === 0) {
        // Avoid creating a new array reference when there's nothing to show —
        // prevents a synchronous re-render on every effect run.
        setPositions((prev) => (prev.length === 0 ? prev : []));
        return;
      }
      // The overlay is absolutely positioned over the textarea's offsetParent
      // (the wrap div), but `getCaretCoords` returns coords measured from the
      // textarea's *inner* border edge. We need to add the textarea's offset
      // inside the wrap (wrap padding) plus the textarea's own border width
      // (clientTop/clientLeft) so each caret lands exactly where the native
      // textarea would render it.
      const baseTop = ta.offsetTop + ta.clientTop;
      const baseLeft = ta.offsetLeft + ta.clientLeft;
      const next = carets.map((c) => {
        const { top, left, height } = getCaretCoords(ta, c.offset);
        return {
          userName: c.userName,
          color: c.color,
          top: baseTop + top,
          left: baseLeft + left,
          height,
        };
      });
      setPositions(next);
    };
    recompute();

    ta.addEventListener("scroll", recompute);
    return () => ta.removeEventListener("scroll", recompute);
  }, [textareaRef, text, carets]);

  if (positions.length === 0) return null;

  return (
    <div
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        overflow: "hidden",
      }}
    >
      {positions.map((p) => (
        <div
          key={p.userName}
          style={{
            position: "absolute",
            top: p.top,
            left: p.left,
            height: p.height,
            width: 2,
            background: p.color,
            boxShadow: `0 0 0 1px ${p.color}33`,
            animation: "remote-caret-blink 1s steps(2, start) infinite",
          }}
        >
          {showLabels && (
            <span
              style={{
                position: "absolute",
                top: -16,
                left: -1,
                background: p.color,
                color: "oklch(98% 0.006 82)",
                fontSize: 10,
                fontWeight: 700,
                lineHeight: "14px",
                padding: "0 5px",
                borderRadius: "3px 3px 3px 0",
                whiteSpace: "nowrap",
                boxShadow: "0 2px 5px rgba(74,63,111,0.14)",
              }}
            >
              {p.userName}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
