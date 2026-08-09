import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { aiApi } from '../api';
import type { RecoveryActionDto, RecoveryCheckpointDto, RecoveryStatusDto } from '../api';
import './SprintRecoveryModal.css';

/** A tooltip that measures the viewport and clamps its own position, rendered through a portal to
 *  `document.body` as `position: fixed`.
 *
 *  Found live, twice: the previous approach was a pure-CSS `:hover::after` anchored to the trigger
 *  element. CSS alone has no way to know how close that trigger is to the screen edge, so any chip in
 *  the outer ~150px of the modal still pushed its tooltip off-screen — centering it on the trigger
 *  (the first attempted fix) only moved *which* chips were affected, it couldn't eliminate the class
 *  of bug, because centering still has no idea where the viewport boundary actually is. This
 *  component does: on hover it reads the trigger's `getBoundingClientRect()`, then clamps the
 *  tooltip's horizontal position to `[8px, window width - tooltip width - 8px]` and flips it below
 *  the trigger instead of above whenever there isn't enough room above (e.g. right under the modal
 *  header) — collision detection, not a fixed CSS direction. This is the same technique real
 *  positioning libraries (Floating UI, Popper) automate; here it's hand-rolled because the only two
 *  behaviors actually needed are "don't go past the left/right edge" and "flip if there's no room
 *  above," not the full general case those libraries solve. Portal + `position: fixed` also means it
 *  is never clipped by the modal's own `overflow-y: auto`, which an absolutely-positioned child would
 *  be if it tried to render outside its scroll container's box. */
function Tooltip({ text, children }: { text: string; children: ReactNode }) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; openDown: boolean } | null>(null);

  function show() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const margin = 8;
    const estimatedWidth = Math.min(300, window.innerWidth - margin * 2);
    const left = Math.min(
      Math.max(rect.left + rect.width / 2 - estimatedWidth / 2, margin),
      window.innerWidth - estimatedWidth - margin,
    );
    const openDown = rect.top < 90; // not enough room above when this close to the modal header
    setPos({ top: openDown ? rect.bottom + 8 : rect.top - 8, left, openDown });
  }

  return (
    <span
      ref={triggerRef}
      className="sr-tt-trigger"
      onMouseEnter={show}
      onMouseLeave={() => setPos(null)}
    >
      {children}
      {pos && createPortal(
        <span
          className="sr-tt-bubble"
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

/** Short hover-preview for a citation chip — falls back to the bare id if the evidence somehow isn't
 *  in `state.evidence` (shouldn't happen, `_apply_grounding` server-side guarantees every cited id was
 *  actually gathered, but a UI helper shouldn't crash if that invariant is ever violated). */
// Machine timestamps reach users in several places — risk-signal text embeds an issue's `updated_at`,
// checkpoints carry a `createdAt`. Rendering them raw ("2026-08-08T01:04:08.794744Z") is debug output,
// not something to put in front of a PM, and it's also in UTC while the reader is not. Everything
// below formats in the *viewer's* own locale and timezone, which is the only correct default: the
// browser knows where the reader is, the server does not.
const ISO_TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;

function _parseIso(raw: string): Date | null {
  // A bare "…T01:04:08.794744" with no zone is UTC in this system (Postgres/LangGraph both emit UTC);
  // without the explicit Z, JS would read it as local time and silently shift it.
  const hasZone = raw.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(raw);
  const d = new Date(hasZone ? raw : `${raw}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Absolute, timezone-labelled, in the viewer's locale — e.g. "8 Aug 2026, 09:04 GMT+8". */
function _formatAbsolute(d: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  }).format(d);
}

/** "just now" / "3 minutes ago" / "2 days ago" — what a reader actually wants when scanning a list of
 *  steps. Paired with the absolute time rather than replacing it, never on its own. */
function _formatRelative(d: Date): string {
  const seconds = Math.round((d.getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return 'just now';
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const steps: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, 'second'], [3600, 'minute'], [86400, 'hour'], [604800, 'day'], [2629800, 'week'],
    [31557600, 'month'], [Infinity, 'year'],
  ];
  let divisor = 1;
  for (const [limit, unit] of steps) {
    if (abs < limit) return rtf.format(Math.round(seconds / divisor), unit);
    divisor = limit;
  }
  return _formatAbsolute(d);
}

/** Rewrites every machine timestamp embedded in a free-text string into the viewer's local format.
 *  Applied at render time to model- and code-generated prose (evidence content, hypothesis text)
 *  because timestamps are interpolated into those strings server-side, not carried as separate
 *  fields — a formatter on a dedicated field couldn't reach them. */
function humanizeTimestamps(text: string): string {
  return text.replace(ISO_TIMESTAMP_RE, (match) => {
    const d = _parseIso(match);
    return d ? _formatAbsolute(d) : match;
  });
}

/** Plain-English stand-in for `RootCauseHypothesis.confidence`. Found live: "high confidence" /
 *  "medium confidence" / "low confidence" reads as a percentage or statistical claim, which is not
 *  what this value is — it's how directly the retrieved evidence backs up one specific sentence, not
 *  how sure the system is that a risk exists at all (the tooltip already said this; the label itself
 *  should say it too, since a hover-only caveat is easy to miss). */
const CAUSE_LABELS: Record<string, string> = {
  high: 'Well-supported',
  medium: 'Some support',
  low: 'Limited support',
};

/** Plain-English name for a citation id. The raw ids (`risk1`, `ev3`, `human-clarification-1`) are
 *  internal handles the model uses to reference evidence; showing them bare made users ask what
 *  "risk1" even meant. The friendly label goes on the chip, the raw id stays in the tooltip so the
 *  mapping is never hidden. */
function _citationLabel(citationId: string): string {
  if (citationId.startsWith('risk')) return `Warning sign ${citationId.slice(4)}`;
  if (citationId.startsWith('human-clarification')) return 'Your answer';
  if (citationId.startsWith('ev')) return `Evidence ${citationId.slice(2)}`;
  return citationId;
}

/** Where a piece of evidence came from, in words rather than a field name. */
const SOURCE_LABELS: Record<string, string> = {
  risk_signal: 'automatic warning sign',
  comment: 'a comment',
  description: 'the ticket description',
  history: 'the change history',
  attachment: 'an attachment',
  structured: 'ticket data',
};

function _evidencePreview(state: RecoveryStatusDto, citationId: string): string {
  const item = state.evidence.find((e) => e.citationId === citationId);
  if (!item) return citationId;
  const readable = humanizeTimestamps(item.content);
  const content = readable.length > 240 ? `${readable.slice(0, 240)}…` : readable;
  const where = SOURCE_LABELS[item.sourceType] ?? item.sourceType;
  const on = item.issueKey ? ` on ${item.issueKey}` : '';
  return `${_citationLabel(citationId)} — from ${where}${on}\n\n${content}`;
}

const STATUS_LABELS: Record<string, string> = {
  diagnosing: 'Checking the sprint…',
  no_risk_found: 'All clear ✅',
  awaiting_clarification: 'Waiting for your answer',
  awaiting_plan_approval: 'Waiting for your decision',
  committing: 'Applying changes in Jira…',
  waiting_reevaluation: 'Watching for changes',
  recovered: 'Fixed ✅',
  escalated: 'Needs a human decision',
  rejected: 'Stopped',
  revising: 'Coming up with new plans…',
  failed: "Couldn't finish",
};

// Human phrasing for `next` — which node a checkpoint is about to run. Combined with `status` below
// because `status` alone is ambiguous: e.g. `diagnosing` covers both "about to run diagnose for the
// first time" (next=diagnose) and "diagnosis just finished, about to plan" (next=plan) — two very
// different points in the workflow that only `next` distinguishes.
const NODE_LABELS: Record<string, string> = {
  diagnose: 'checking for risk',
  clarify: 'waiting for your answer to a question',
  plan: 'coming up with a plan',
  approval: 'waiting for your decision on a plan',
  commit_one_action: 'applying a change in Jira',
  wait_for_reevaluation: 'waiting to check again',
  reevaluate: 'checking again',
};

/** A raw `status=X → next=Y` pair (what the graph literally stores) translated into one plain-English
 *  sentence describing what point in the workflow that checkpoint represents. Found live: showing the
 *  raw pair directly ("status=revising → next=plan") is LangGraph internals, not something a non-
 *  engineer reviewing a checkpoint list should have to parse — this is the readable version, with the
 *  raw pair still shown alongside it in small monospace text for anyone who does want it (see
 *  .sr-history__raw), not removed entirely. */
function _checkpointLabel(status: string, nextNode: string | null): string {
  const niceStatus = STATUS_LABELS[status] ?? status.replace(/_/g, ' ');
  if (!nextNode) return `${niceStatus} — ended here`;
  const niceNext = NODE_LABELS[nextNode] ?? nextNode.replace(/_/g, ' ');
  return `${niceStatus} — then: ${niceNext}`;
}

const INLINE_CITATION_RE = /\[(ev\d+|risk\d+|human-clarification-\d+)\]/g;

/** Renders one hypothesis's statement with its citations inline, next to the exact clause they
 *  support — instead of one undifferentiated row of chips dumped below the whole paragraph, which
 *  gave no way to tell which fact backed which claim. The prompt in `diagnose_node` asks the model to
 *  place `[ev1]`-style markers at the right spot in `statement`; this splits on those markers and
 *  swaps each one for the same hoverable chip used elsewhere. Not a hard dependency on the model
 *  complying: any id in `supportingEvidenceIds` that never appears inline still gets listed in a
 *  fallback row underneath, so a partial or absent inline citation degrades gracefully instead of
 *  silently dropping evidence. */
function CauseCards({ state }: { state: RecoveryStatusDto }) {
  return (
    <>
      <p className="rl-hint sr-hint-tight">
        Based on {state.evidence.length} piece(s) of evidence found this run. Each highlighted tag
        below is a citation — hover it to preview what it says.
      </p>
      {state.hypotheses.map((h, i) => {
        const text = humanizeTimestamps(h.statement);
        const parts = text.split(INLINE_CITATION_RE);
        const inlineIds = new Set<string>();
        const rendered: ReactNode[] = parts.map((part, idx) => {
          if (idx % 2 === 1) {
            inlineIds.add(part);
            return (
              <Tooltip key={idx} text={_evidencePreview(state, part)}>
                <code className="sr-cite-chip sr-cite-chip--inline">{_citationLabel(part)}</code>
              </Tooltip>
            );
          }
          return <span key={idx}>{part}</span>;
        });
        const uncited = h.supportingEvidenceIds.filter((id) => !inlineIds.has(id));
        return (
          <div className="sr-hyp-card" key={i}>
            <div className="sr-hyp-card__top">
              <Tooltip text="How well the evidence backs up this specific claim — not how serious the risk is">
                <span className={`rl-badge sr-conf--${h.confidence}`}>
                  {CAUSE_LABELS[h.confidence] ?? h.confidence}
                </span>
              </Tooltip>
            </div>
            <p className="sr-hyp-card__statement">{rendered}</p>
            {uncited.length > 0 && (
              <div className="sr-cites">
                {uncited.map((id) => (
                  <Tooltip key={id} text={_evidencePreview(state, id)}>
                    <code className="sr-cite-chip">{_citationLabel(id)}</code>
                  </Tooltip>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

interface SprintRecoveryModalProps {
  spaceId: number;
  sprintId: number;
  sprintName: string;
  onClose: () => void;
}

/**
 * A durable sprint-risk diagnosis + recovery workflow — genuinely different LangGraph shape from
 * RolloutModal: three differently-shaped pauses (a free-text clarifying question, a plan
 * approve/edit/reject, and a wait resumable by either a human or a real Kafka event), a bounded
 * escalation replan loop, and a time-travel picker. See
 * ai-service/app/sprint_recovery/graph.py's module docstring for the full design rationale — none of
 * this is "impossible without a framework," it's where the honest case for using one anyway is
 * strongest in this codebase.
 */
export function SprintRecoveryModal({ spaceId, sprintId, sprintName, onClose }: SprintRecoveryModalProps) {
  const [state, setState] = useState<RecoveryStatusDto | null>(null);
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clarifyAnswer, setClarifyAnswer] = useState('');
  const [history, setHistory] = useState<RecoveryCheckpointDto[] | null>(null);
  const [timeTravelNote, setTimeTravelNote] = useState('');
  const [selectedCheckpoint, setSelectedCheckpoint] = useState<string | null>(null);
  const [revisionFeedback, setRevisionFeedback] = useState('');
  const [elapsed, setElapsed] = useState(0);
  // Real progress from the SSE stream (see aiApi.startSprintRecoveryStream/
  // answerSprintRecoveryClarificationStream's onStage) — falls back to a generic "Working…" label
  // whenever busy is true but no stage event has arrived yet (e.g. the non-streaming decision/retry
  // calls below, which don't chain through an LLM call worth naming a stage for).
  const [stageLabel, setStageLabel] = useState<string | null>(null);
  // Found live: this modal's body is height-capped with internal scroll (see .sr-modal's max-height),
  // so content that appears *below the fold* after a state transition — the "Re-check now" button
  // once a plan finishes committing, the checkpoint list once history loads — looked like "nothing
  // happened" even though it rendered correctly, just off-screen. These refs + the effects below bring
  // each one into view automatically instead of requiring a manual scroll to discover it exists.
  const reevaluateSectionRef = useRef<HTMLDivElement>(null);
  const historySectionRef = useRef<HTMLDivElement>(null);

  const isWaiting = starting || busy;

  // Found live: the Backlog page behind this modal stayed scrollable the whole time it was open —
  // easy to miss since the dimmed overlay makes it *look* locked, but the underlying page still
  // scrolled on wheel/trackpad input reaching through the gap around the modal. Standard modal
  // behavior locks the page scroll for as long as the modal is mounted, restoring it on close.
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    if (!isWaiting) {
      setElapsed(0);
      return;
    }
    const startedAt = Date.now();
    const id = window.setInterval(() => setElapsed(Math.round((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(id);
  }, [isWaiting]);

  useEffect(() => {
    if (state?.status === 'waiting_reevaluation') {
      reevaluateSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [state?.status]);

  useEffect(() => {
    if (history) {
      historySectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [history]);

  // While the workflow is parked at `waiting_reevaluation`, something *other than this browser tab*
  // can move it forward: `kafka_trigger.py` resumes that exact pause when a relevant Jira change is
  // published. Found live — and it fires far more often than expected, because the workflow's own
  // approved actions (change_priority / add_comment / move_out_of_sprint) are themselves Jira changes
  // that get published. Without this poll the modal sat on a stale "Re-check now" button whose click
  // then hit a workflow that had already moved on. Polling is the right shape here rather than a
  // second SSE stream: it's one cheap GET every few seconds, only while parked at this one state.
  useEffect(() => {
    if (state?.status !== 'waiting_reevaluation' || busy) return;
    const threadId = state.threadId;
    let cancelled = false;
    const id = window.setInterval(async () => {
      try {
        const latest = await aiApi.getSprintRecoveryStatus(threadId);
        if (!cancelled && latest.status !== 'waiting_reevaluation') setState(latest);
      } catch {
        /* transient — the next tick retries, and the manual button is still there as a fallback */
      }
    }, 3000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [state?.status, state?.threadId, busy]);

  async function run(fn: () => Promise<RecoveryStatusDto>) {
    setBusy(true);
    setError(null);
    try {
      const result = await fn();
      setState(result);
      setHistory(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleStart() {
    setStarting(true);
    setError(null);
    setStageLabel(null);
    try {
      const result = await aiApi.startSprintRecoveryStream(spaceId, sprintId, sprintName, setStageLabel);
      setState(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
      setStageLabel(null);
    }
  }

  async function handleClarify() {
    if (!state || !clarifyAnswer.trim()) return;
    const answer = clarifyAnswer.trim();
    setBusy(true);
    setError(null);
    setStageLabel(null);
    try {
      const result = await aiApi.answerSprintRecoveryClarificationStream(state.threadId, answer, setStageLabel);
      setState(result);
      setHistory(null);
      setClarifyAnswer('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setStageLabel(null);
    }
  }

  async function handleDecision(
    decision: 'approve' | 'edit' | 'reject' | 'revise',
    planId?: string,
    actions?: RecoveryActionDto[],
    feedback?: string,
  ) {
    if (!state) return;
    setBusy(true);
    setError(null);
    setStageLabel(null);
    try {
      const result = await aiApi.submitSprintRecoveryDecisionStream(
        state.threadId, decision, planId, actions, feedback, setStageLabel,
      );
      setState(result);
      setHistory(null);
      if (decision === 'revise') setRevisionFeedback('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setStageLabel(null);
    }
  }

  /** Back to the initial screen — the only next step after a terminal 'rejected' status. Does not
   *  reuse the old thread_id: a rejected workflow is done, a fresh Analyze starts a genuinely new one. */
  function handleStartOver() {
    setState(null);
    setRevisionFeedback('');
    setError(null);
  }

  async function handleRetry() {
    if (!state) return;
    await run(() => aiApi.retrySprintRecovery(state.threadId));
  }

  async function handleTriggerReevaluation() {
    if (!state) return;
    setBusy(true);
    setError(null);
    setStageLabel(null);
    try {
      const result = await aiApi.triggerSprintRecoveryReevaluationStream(state.threadId, setStageLabel);
      setState(result);
      setHistory(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setStageLabel(null);
    }
  }

  async function handleLoadHistory() {
    if (!state) return;
    setBusy(true);
    try {
      const h = await aiApi.getSprintRecoveryHistory(state.threadId);
      setHistory(h);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleTimeTravel() {
    if (!state || !selectedCheckpoint || !timeTravelNote.trim()) return;
    await run(() => aiApi.timeTravelSprintRecovery(state.threadId, selectedCheckpoint, timeTravelNote.trim()));
    setTimeTravelNote('');
    setSelectedCheckpoint(null);
  }

  return (
    <div className="bl-overlay" onMouseDown={onClose}>
      <div className="bl-modal sr-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="bl-modal__header">
          <h2 className="bl-modal__title">🚑 Sprint Risk & Recovery — {sprintName}</h2>
          <button type="button" className="bl-modal__close" onClick={onClose}>✕</button>
        </div>
        <div className="bl-modal__body sr-body">
          {!state && (
            <>
              <p className="rl-hint">
                Checks this sprint for real signs of risk, explains what might be going wrong (every
                claim is backed by evidence you can inspect), and only makes changes in Jira after you
                approve a plan. Along the way it may pause to ask you a question, or to wait for your
                decision on a plan — nothing happens in Jira without your OK.
              </p>
              <button type="button" className="bl-btn bl-btn--primary" onClick={handleStart} disabled={starting}>
                {starting ? <><span className="sr-spinner" aria-hidden="true" /> {stageLabel ?? 'Starting…'} ({elapsed}s)</> : 'Analyze Sprint Health'}
              </button>
            </>
          )}
          {error && <p className="rl-error">{error}</p>}

          {state && (
            <>
              <div className="sr-status-row">
                <span className={`rl-badge sr-badge--${state.status}`}>{STATUS_LABELS[state.status] ?? state.status}</span>
                {/* Found live: this showed "Attempt 1 of 3" on a sprint that got handed to a human on
                    the very first pass — because no issue-level action was even possible, not because
                    3 attempts were exhausted (see plan_node's immediate-handoff branch). "Attempt 1 of
                    3" implies 2 more tries were available; there weren't. Only show it once the
                    autonomous retry loop was actually in play. */}
                {!(
                  state.status === 'no_risk_found' ||
                  (state.status === 'escalated' && state.escalationRounds.length === 0)
                ) && (
                  <Tooltip text={`The AI gets ${state.maxEscalationRounds + 1} attempts to fix this before handing the decision to a person.`}>
                    <span className="sr-attempt">
                      Attempt {state.escalationRound + 1} of {state.maxEscalationRounds + 1}
                    </span>
                  </Tooltip>
                )}
                {/* Staleness can only ever bias this check toward looking *more* at-risk than reality
                    (a stale read can't see a fix that already landed, but it can't invent a new problem
                    either) — so this is only worth showing next to a still-at-risk-looking status, never
                    next to "recovered". Without this, a re-escalation right after approving an obviously
                    correct fix reads as an unexplained bug rather than a known, named, honest limit. */}
                {state.indexCatchUpTimedOut && (state.status === 'escalated' || state.status === 'diagnosing') && (
                  <Tooltip text="We couldn't confirm the latest changes had finished syncing before this check ran, so this result may be based on slightly stale data. This isn't a sign the fix failed — the next automatic re-check will see the current state.">
                    <span className="sr-stale-caveat">⚠ unconfirmed sync</span>
                  </Tooltip>
                )}
                {busy && (
                  <span className="sr-waiting">
                    <span className="sr-spinner" aria-hidden="true" /> {stageLabel ?? 'working…'} ({elapsed}s)
                  </span>
                )}
                <span className="sr-status-row__spacer" />
                <button type="button" className="bl-btn bl-btn--outline" onClick={handleLoadHistory} disabled={busy}>
                  View past steps
                </button>
              </div>
              {/* Two different reasons land on status="escalated", and they read very differently:
                  either the AI tried several plans and none worked (handled below, with a round-by-
                  round breakdown), or — this case — it never had anything it could act on in the first
                  place, decided in `plan_node` before any plan was ever proposed. Giving this its own
                  clearly-labelled panel (instead of `state.error` rendering as a bare red line with no
                  framing) was the fix for "why does this say escalated after only 1 attempt": there
                  was no attempt to count. */}
              {state.status === 'escalated' && state.escalationRounds.length === 0 && state.error && (
                <div className="sr-escalation">
                  <p className="sr-escalation__title">
                    The AI couldn't take any action here — no attempt was needed, this went straight to
                    you:
                  </p>
                  <p className="sr-escalation__round-rationale">{humanizeTimestamps(state.error)}</p>
                </div>
              )}
              {state.error && state.status !== 'escalated' && <p className="rl-error">{state.error}</p>}

              {state.status === 'escalated' && state.escalationRounds.length > 0 && (() => {
                // Every escalation looks the same at a glance — red, "needs a human decision" — but
                // two different situations land here. Focused: every flagged issue below was already
                // acted on at least once across the rounds — the AI exhausted what its 4 action types
                // can do, and what's left is real engineering time, not more planning. Unresolved:
                // some flagged issue was never even attempted (e.g. the token budget ran out first) —
                // a real gap, not just "waiting on someone to finish the work."
                const focused = state.escalationUnaddressedIssueKeys.length === 0;
                return (
                <div className={`sr-escalation${focused ? ' sr-escalation--focused' : ''}`}>
                  <p className="sr-escalation__title">
                    {focused ? (
                      <>
                        The AI has done everything it can here — every issue it flagged already has an
                        action against it. What's left needs a person to actually do the work, not
                        another plan. Here's exactly what it tried:
                      </>
                    ) : (
                      <>
                        The AI tried {state.escalationRounds.length} plan
                        {state.escalationRounds.length > 1 ? 's' : ''} but couldn't fix this on its own
                        — it's now up to you to decide what to do next. Here's exactly what it tried:
                      </>
                    )}
                  </p>
                  <div className="sr-escalation__rounds">
                    {state.escalationRounds.map((r) => (
                      <div className="sr-escalation__round" key={r.round}>
                        <div className="sr-escalation__round-header">
                          <span className="sr-escalation__round-badge">Round {r.round}</span>
                          <span className="sr-escalation__round-plan">{r.planName}</span>
                        </div>
                        <p className="sr-escalation__round-rationale">{humanizeTimestamps(r.rationale)}</p>
                        {r.actions.length > 0 && (
                          <>
                            <p className="sr-escalation__actions-title">What it changed in Jira:</p>
                            <ul className="sr-escalation__round-actions">
                              {r.actions.map((a, i) => <li key={i}>{humanizeTimestamps(a)}</li>)}
                            </ul>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                  {state.escalationStillAtRiskReasons.length > 0 && (
                    <div className="sr-escalation__reasons">
                      <p className="sr-escalation__reasons-title">Still at risk because:</p>
                      <ul>
                        {state.escalationStillAtRiskReasons.map((reason, i) => (
                          <li key={i}>{humanizeTimestamps(reason)}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {!focused && (
                    <div className="sr-escalation__reasons">
                      <p className="sr-escalation__reasons-title">Never got attempted:</p>
                      <ul>
                        {state.escalationUnaddressedIssueKeys.map((key) => <li key={key}><code>{key}</code></li>)}
                      </ul>
                    </div>
                  )}
                </div>
                );
              })()}

              {state.riskSignalCount === 0 && !state.clarificationQuestion && state.hypotheses.length === 0 && (
                <p className="rl-hint">No signs of risk found in this sprint — that's the expected, healthy result, not an error.</p>
              )}

              {state.status === 'awaiting_clarification' || state.clarificationQuestion ? (
                <div className="sr-clarify">
                  {/* Found live: the question appeared with no stated reason, so there was no way to
                      tell "it asked because evidence was genuinely ambiguous" apart from "it always
                      asks first" — the two other sprints in the same demo skip straight to a plan with
                      no question at all, which only makes sense once you know this step is conditional.
                      The reasoning already renders in "Possible causes" below (using the same low-
                      confidence hypotheses that triggered the question) — this line is the missing
                      link between the two, not new data. */}
                  <p className="sr-clarify__why">
                    It found some evidence but isn't confident enough to act on it yet — see "Possible
                    causes" below for exactly what it has so far and why that's not conclusive.
                  </p>
                  <p className="sr-question"><b>Quick question:</b> {state.clarificationQuestion}</p>
                  <textarea
                    className="bl-modal__input"
                    placeholder="Your answer (used to help figure out what's going on)"
                    value={clarifyAnswer}
                    onChange={(e) => setClarifyAnswer(e.target.value)}
                  />
                  <button type="button" className="bl-btn bl-btn--primary" onClick={handleClarify} disabled={busy || !clarifyAnswer.trim()}>
                    Answer
                  </button>
                </div>
              ) : null}

              {state.hypotheses.length > 0 && (
                // Once the sprint is Fixed or handed off, these are history, not a current problem —
                // found live: showing "Possible causes" in full, unlabeled, right below a settled-
                // status badge read as if the sprint were still an open question. Collapsed behind a
                // plainly-labelled toggle for terminal states; still expanded by default while a
                // decision is pending, since that's exactly when a reviewer needs to see it immediately.
                (state.status === 'recovered' || state.status === 'escalated') ? (
                  <details className="sr-hypotheses sr-hypotheses--past">
                    <summary className="sr-section-title sr-evidence__summary">
                      {state.status === 'recovered' ? 'What was found before it was fixed' : 'What was found'}
                      {' '}({state.hypotheses.length}) — click to expand
                    </summary>
                    <CauseCards state={state} />
                  </details>
                ) : (
                  <div className="sr-hypotheses">
                    <p className="sr-section-title">Possible causes</p>
                    <CauseCards state={state} />
                  </div>
                )
              )}

              {state.evidence.length > 0 && (() => {
                const citedIds = new Set(state.hypotheses.flatMap((h) => h.supportingEvidenceIds));
                return (
                <details className="sr-evidence">
                  <summary className="sr-section-title sr-evidence__summary">
                    Evidence ({citedIds.size} used above, {state.evidence.length} found in total — click to expand)
                  </summary>
                  <p className="rl-hint sr-hint-tight">
                    Everything the system actually looked at this run, not just what got used above —
                    shown in full so nothing is hidden, including things it decided weren't relevant.
                  </p>
                  <div className="sr-evidence__list">
                    {state.evidence.map((e) => (
                      <div className={`sr-evidence__item${citedIds.has(e.citationId) ? ' sr-evidence__item--cited' : ''}`} key={e.citationId}>
                        <code className="sr-cite-chip">{_citationLabel(e.citationId)}</code>
                        {citedIds.has(e.citationId) && <span className="sr-evidence__cited-badge">used above</span>}
                        <span className="sr-evidence__meta">
                          from {SOURCE_LABELS[e.sourceType] ?? e.sourceType}{e.issueKey ? ` on ${e.issueKey}` : ''}
                        </span>
                        <p className="sr-evidence__content">{humanizeTimestamps(e.content)}</p>
                      </div>
                    ))}
                  </div>
                </details>
                );
              })()}

              {/* Still choosing: show every proposed option. Once a decision has been made, `plans` is
                  the *original* pre-edit proposals and never reflects a human edit — `approvedPlan` is
                  the plan that's actually executing (or already ran). Found live: after an edited plan
                  failed partway through, showing `plans` here rendered the wrong action text entirely
                  and put the "done" checkmark on the wrong row, because `committedActions`' indices
                  refer to `approvedPlan.actions`, not the stale pre-edit list. Falls back to `plans` for
                  a checkpoint from before `approvedPlan` existed, rather than showing nothing. */}
              {(() => {
                const plansToShow = state.status === 'awaiting_plan_approval'
                  ? state.plans
                  : state.approvedPlan ? [state.approvedPlan] : state.plans;
                if (plansToShow.length === 0) return null;
                return (
                <div className="sr-plans">
                  <p className="sr-section-title">
                    {state.status === 'awaiting_plan_approval' ? 'Suggested plans — pick one' : 'Plan'}
                  </p>
                  {plansToShow.map((p) => (
                    <div className="sr-plan" key={p.planId}>
                      <div className="sr-plan__header">
                        <span className="sr-plan__name">{p.name}</span>
                        <p className="sr-plan__rationale">{p.rationale}</p>
                        <p className="sr-plan__impact"><b>Trade-off:</b> {p.impactOnGoal}</p>
                      </div>
                      <ul className="sr-actions">
                        {p.actions.map((a, i) => {
                          const done = state.committedActions[String(i)];
                          return (
                            <li key={i} className={done ? 'sr-action--done' : ''}>
                              {done && <span className="sr-action__done-mark" title={done}>✓</span>}
                              <span className={`sr-action-chip sr-action-chip--${a.actionType}`}>{a.actionType.replace(/_/g, ' ')}</span>
                              <span className="sr-action__body">
                                <code>{a.targetIssueKey}</code>
                                {a.dependsOnIssueKey ? <> blocked by <code>{a.dependsOnIssueKey}</code></> : ''}
                                {a.newPriority ? <> → <b>{a.newPriority}</b></> : ''}
                                {a.commentBody ? <span className="sr-action__comment">"{a.commentBody}"</span> : ''}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                      {state.status === 'awaiting_plan_approval' && (
                        <div className="sr-plan__actions">
                          <button type="button" className="bl-btn bl-btn--primary" onClick={() => handleDecision('approve', p.planId)} disabled={busy}>
                            {busy ? 'Working…' : 'Approve — execute this plan'}
                          </button>
                        </div>
                      )}
                    </div>
                  ))}

                  {state.status === 'awaiting_plan_approval' && (
                    <div className="sr-revise">
                      {/* Duplicated from the top status row on purpose — the top one is out of view by
                          the time someone has scrolled down to this panel and clicked a button here;
                          without this, "did anything happen?" was only answerable by scrolling back up. */}
                      {busy && (
                        <span className="sr-waiting sr-waiting--local">
                          <span className="sr-spinner" aria-hidden="true" /> {stageLabel ?? 'working…'} ({elapsed}s)
                        </span>
                      )}
                      {state.planRevisionRound >= state.maxPlanRevisionRounds ? (
                        // Found live: submitting one more revise past the cap used to silently degrade
                        // to a plain reject inside approval_node — indistinguishable from a real
                        // rejection in the UI, with the only trace a small error line. Locking this out
                        // proactively means that can't happen again: the limit is stated before anyone
                        // hits it, not discovered after feedback quietly went nowhere.
                        <p className="sr-revise__label sr-revise__label--limit">
                          You've already asked for different plans {state.maxPlanRevisionRounds} time
                          {state.maxPlanRevisionRounds > 1 ? 's' : ''} — that's the limit for this
                          check. Approve one of the plans above, or reject all and start over.
                        </p>
                      ) : (
                        <>
                          <p className="sr-revise__label">
                            None of these quite right?
                            {state.planRevisionRound > 0
                              ? ` (asked ${state.planRevisionRound}/${state.maxPlanRevisionRounds} times so far)`
                              : ''}
                          </p>
                          <textarea
                            className="bl-modal__input"
                            placeholder="What would you change? (required — used to come up with new plans)"
                            value={revisionFeedback}
                            onChange={(e) => setRevisionFeedback(e.target.value)}
                          />
                        </>
                      )}
                      <div className="sr-revise__actions">
                        <button type="button" className="bl-btn bl-btn--ghost" onClick={() => handleDecision('reject')} disabled={busy}>
                          {busy ? 'Working…' : 'Reject all — stop this recovery'}
                        </button>
                        {state.planRevisionRound < state.maxPlanRevisionRounds && (
                          <button
                            type="button"
                            className="bl-btn bl-btn--outline"
                            onClick={() => handleDecision('revise', undefined, undefined, revisionFeedback.trim())}
                            disabled={busy || !revisionFeedback.trim()}
                          >
                            {busy ? (stageLabel ?? 'Working…') : 'Request different plans'}
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
                );
              })()}

              {(state.status === 'committing' || state.status === 'failed') && (
                <button type="button" className="bl-btn bl-btn--primary" onClick={handleRetry} disabled={busy}>
                  {busy ? 'Working…' : state.status === 'committing' ? 'Resume — pick up where it left off' : "Try again (won't repeat what already succeeded)"}
                </button>
              )}

              {state.status === 'waiting_reevaluation' && (
                <div ref={reevaluateSectionRef} className="sr-reevaluate-anchor">
                  <p className="rl-hint sr-hint-tight">
                    This checks again automatically if something relevant changes in Jira — or you can
                    check right now.
                  </p>
                  {busy && (
                    <span className="sr-waiting sr-waiting--local">
                      <span className="sr-spinner" aria-hidden="true" /> {stageLabel ?? 'checking…'} ({elapsed}s)
                    </span>
                  )}
                  <button type="button" className="bl-btn bl-btn--primary" onClick={handleTriggerReevaluation} disabled={busy}>
                    {busy ? (stageLabel ?? 'Checking…') : 'Re-check now'}
                  </button>
                </div>
              )}

              {state.status === 'rejected' && (
                <button type="button" className="bl-btn bl-btn--primary" onClick={handleStartOver}>
                  Start a new diagnosis
                </button>
              )}

              {history && (
                <div ref={historySectionRef} className="sr-history">
                  <p className="sr-section-title">Past steps</p>
                  <p className="rl-hint sr-hint-tight">
                    Everything this check has done so far, newest first. Pick any step to rewind to it
                    and run forward again from that point with new information.
                  </p>
                  <ol className="sr-timeline">
                    {(() => {
                      const steps = history.filter((h) => h.status);
                      return steps.map((h, i) => {
                        const when = h.createdAt ? _parseIso(h.createdAt) : null;
                        const isLatest = i === 0;
                        const stepNumber = steps.length - i; // oldest step is #1
                        return (
                          <li
                            className={`sr-timeline__item${selectedCheckpoint === h.checkpointId ? ' sr-timeline__item--selected' : ''}${isLatest ? ' sr-timeline__item--latest' : ''}`}
                            key={h.checkpointId}
                          >
                            <label className="sr-timeline__row">
                              <input
                                type="radio"
                                name="checkpoint"
                                className="sr-timeline__radio"
                                checked={selectedCheckpoint === h.checkpointId}
                                onChange={() => setSelectedCheckpoint(h.checkpointId)}
                              />
                              <span className="sr-timeline__marker" aria-hidden="true" />
                              <span className="sr-timeline__body">
                                <span className="sr-timeline__headline">
                                  <span className="sr-timeline__step">Step {stepNumber}</span>
                                  <span className="sr-timeline__label">
                                    {_checkpointLabel(h.status as string, h.nextNode)}
                                  </span>
                                  {isLatest && <span className="sr-timeline__now">most recent</span>}
                                </span>
                                {h.detail && (
                                  <span className="sr-timeline__detail">{humanizeTimestamps(h.detail)}</span>
                                )}
                                {when && (
                                  <span className="sr-timeline__time" title={_formatAbsolute(when)}>
                                    {_formatRelative(when)} · {_formatAbsolute(when)}
                                  </span>
                                )}
                              </span>
                            </label>
                          </li>
                        );
                      });
                    })()}
                  </ol>
                  {selectedCheckpoint && (
                    <div className="sr-rewind">
                      {/* Found live: picking a step (a plain radio button — no API call happens on
                          selection, see setSelectedCheckpoint) looked like it had already done
                          something, especially once the row got a highlighted background. Nothing
                          changes until the button at the bottom of this box is actually clicked — said
                          explicitly now instead of only implied by "go back to". */}
                      <p className="sr-rewind__title">
                        Nothing has happened yet — selecting a step just previews it
                      </p>
                      <p className="sr-rewind__explainer">
                        Only clicking the button below actually does anything, and it does two things
                        in order:
                      </p>
                      {/* Spelled out as two explicit, numbered things on purpose — found live: without
                          this, "rewind and check again" read as one vague action, when what actually
                          happens is a real jump backward followed by a real forward re-run. Verified
                          against `time_travel_resume`: it always re-enters diagnosis first, regardless
                          of which later step you picked to jump back to — so step 2 below is accurate
                          even from a step that already had a plan or was already Fixed. */}
                      <ol className="sr-rewind__steps">
                        <li><b>Jumps back</b> in this check's own reasoning to this exact point — later
                          plans and approval decisions are set aside, as if this check hadn't reasoned
                          through them yet.</li>
                        <li><b>Re-diagnoses from there</b> with your note folded in as if it had just
                          been told to it — not a straight jump to a new plan; it re-evaluates first,
                          which usually leads to a new plan but could also ask another question if
                          what you wrote still leaves something unclear.</li>
                      </ol>
                      {/* Found live, from a direct user question ("does rewinding put a moved-out issue
                          back in the sprint?"): the two lines above talk about the check's own
                          reasoning being set aside, but say nothing about real Jira writes an already-
                          approved plan made — easy to misread as "everything is undone." It isn't, and
                          can't be: this only replays LangGraph's own checkpoint, never calls back out to
                          Jira. Said explicitly, not left implied, because assuming otherwise here would
                          be actively misleading, not just incomplete. */}
                      <p className="sr-rewind__warning">
                        <b>This does not undo anything already written to Jira.</b> If an earlier
                        approved plan already moved an issue out of the sprint, changed its priority, or
                        posted a comment, that stays exactly as it is — rewinding only replays this
                        check's own reasoning, it never calls back out to Jira. If you need the Jira-side
                        change itself undone, that has to be done directly in Jira first.
                      </p>
                      <p className="sr-rewind__explainer">
                        Use this when something the AI didn't know about has since come to light (e.g.
                        a blocker got resolved) and you want it to redo its reasoning with that fact
                        included, instead of starting a whole new check from scratch.
                      </p>
                      <textarea
                        className="bl-modal__input"
                        placeholder="What should it know this time? (e.g. 'PAY-97 was actually descoped — re-plan around that')"
                        value={timeTravelNote}
                        onChange={(e) => setTimeTravelNote(e.target.value)}
                      />
                      <button type="button" className="bl-btn bl-btn--primary" onClick={handleTimeTravel} disabled={busy || !timeTravelNote.trim()}>
                        {busy ? 'Working…' : 'Rewind and check again from here'}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
        <div className="bl-modal__footer">
          <button type="button" className="bl-btn bl-btn--ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
