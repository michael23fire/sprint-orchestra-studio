import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './Tooltip.css';

/** A tooltip that measures the viewport and clamps its own position, rendered through a portal to
 *  `document.body` as `position: fixed`. Originally lived inside SprintRecoveryModal.tsx; extracted
 *  here once a second feature (the Backlog row's "what does this button do" icons) needed the exact
 *  same positioning logic — duplicating it would have meant two places that could drift out of sync
 *  on the next viewport-edge bug.
 *
 *  Found live, twice: the previous approach was a pure-CSS `:hover::after` anchored to the trigger
 *  element. CSS alone has no way to know how close that trigger is to the screen edge, so any chip in
 *  the outer ~150px of the modal still pushed its tooltip off-screen — centering it on the trigger
 *  (the first attempted fix) only moved *which* chips were affected, it couldn't eliminate the class
 *  of bug, because centering still has no idea where the viewport boundary actually is. This
 *  component does: on hover it reads the trigger's `getBoundingClientRect()`, then clamps the
 *  tooltip's horizontal position to `[8px, window width - tooltip width - 8px]` and flips it below
 *  the trigger instead of above whenever there isn't enough room above. This is the same technique
 *  real positioning libraries (Floating UI, Popper) automate; here it's hand-rolled because the only
 *  two behaviors actually needed are "don't go past the left/right edge" and "flip if there's no room
 *  above," not the full general case those libraries solve. Portal + `position: fixed` also means it
 *  is never clipped by an ancestor's `overflow: hidden`/`auto`, which an absolutely-positioned child
 *  would be if it tried to render outside that ancestor's box.
 *
 *  `text` accepts any ReactNode, not just a string — the Backlog row's explainer icons need real
 *  structure (a title, a description, a safety note), not one run-on sentence. Existing plain-string
 *  callers keep working untouched, since a string is itself a valid ReactNode.
 */
export function Tooltip({ text, children }: { text: ReactNode; children: ReactNode }) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; openDown: boolean } | null>(null);

  function show() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const margin = 8;
    const estimatedWidth = Math.min(320, window.innerWidth - margin * 2);
    const left = Math.min(
      Math.max(rect.left + rect.width / 2 - estimatedWidth / 2, margin),
      window.innerWidth - estimatedWidth - margin,
    );
    const openDown = rect.top < 90; // not enough room above when this close to a modal header
    setPos({ top: openDown ? rect.bottom + 8 : rect.top - 8, left, openDown });
  }

  return (
    <span
      ref={triggerRef}
      className="tt-trigger"
      onMouseEnter={show}
      onMouseLeave={() => setPos(null)}
    >
      {children}
      {pos && createPortal(
        <span
          className="tt-bubble"
          style={{
            left: pos.left,
            top: pos.openDown ? pos.top : undefined,
            bottom: pos.openDown ? undefined : window.innerHeight - pos.top,
          }}
        >
          {text}
        </span>,
        document.body,
      )}
    </span>
  );
}

/** The recurring shape a "what does this feature do" tooltip needs: a title, a plain-language
 *  description, and — for anything that touches Jira — a safety note stated up front rather than
 *  buried in the description prose. Pulled out so the Backlog row's two explainer icons (health check,
 *  recovery) render from the same layout instead of two hand-built JSX blocks that could drift apart
 *  in spacing or hierarchy. */
export function TooltipExplainer({ title, description, note }: { title: string; description: string; note?: string }) {
  return (
    <span className="tt-bubble__content">
      <span className="tt-bubble__title">{title}</span>
      <span className="tt-bubble__desc">{description}</span>
      {note && <span className="tt-bubble__note">{note}</span>}
    </span>
  );
}
