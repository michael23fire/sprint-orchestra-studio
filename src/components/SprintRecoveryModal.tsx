import { useEffect, useState } from 'react';
import { aiApi } from '../api';
import type { RecoveryActionDto, RecoveryCheckpointDto, RecoveryStatusDto } from '../api';
import './SprintRecoveryModal.css';

/** Short hover-preview for a citation chip — falls back to the bare id if the evidence somehow isn't
 *  in `state.evidence` (shouldn't happen, `_apply_grounding` server-side guarantees every cited id was
 *  actually gathered, but a UI helper shouldn't crash if that invariant is ever violated). */
function _evidencePreview(state: RecoveryStatusDto, citationId: string): string {
  const item = state.evidence.find((e) => e.citationId === citationId);
  if (!item) return citationId;
  const content = item.content.length > 240 ? `${item.content.slice(0, 240)}…` : item.content;
  return `[${item.citationId}] (${item.issueKey || 'no issue'} / ${item.sourceType}) ${content}`;
}

const STATUS_LABELS: Record<string, string> = {
  diagnosing: 'Diagnosing…',
  awaiting_plan_approval: 'Awaiting your approval',
  committing: 'Committing (crashed mid-write?)',
  waiting_reevaluation: 'Waiting for a Jira event or manual re-check',
  recovered: 'Recovered',
  escalated: 'Escalated — capacity exhausted',
  rejected: 'Rejected',
  revising: 'Regenerating plans from your feedback',
  failed: 'Failed',
};

// Human phrasing for `next` — which node a checkpoint is about to run. Combined with `status` below
// because `status` alone is ambiguous: e.g. `diagnosing` covers both "about to run diagnose for the
// first time" (next=diagnose) and "diagnosis just finished, about to plan" (next=plan) — two very
// different points in the workflow that only `next` distinguishes.
const NODE_LABELS: Record<string, string> = {
  diagnose: 'diagnosing risk signals',
  clarify: 'waiting on your answer to a clarifying question',
  plan: 'generating recovery plans',
  approval: 'awaiting your plan decision',
  commit_one_action: 'committing an approved action to Jira',
  wait_for_reevaluation: 'waiting to re-check the sprint',
  reevaluate: 're-checking risk signals',
};

/** A raw `status=X → next=Y` pair (what the graph literally stores) translated into one plain-English
 *  sentence describing what point in the workflow that checkpoint represents. Found live: showing the
 *  raw pair directly ("status=revising → next=plan") is LangGraph internals, not something a non-
 *  engineer reviewing a checkpoint list should have to parse — this is the readable version, with the
 *  raw pair still shown alongside it in small monospace text for anyone who does want it (see
 *  .sr-history__raw), not removed entirely. */
function _checkpointLabel(status: string, nextNode: string | null): string {
  const niceStatus = STATUS_LABELS[status] ?? status.replace(/_/g, ' ');
  if (!nextNode) return `${niceStatus} — workflow finished here`;
  const niceNext = NODE_LABELS[nextNode] ?? nextNode.replace(/_/g, ' ');
  return `${niceStatus} — next up: ${niceNext}`;
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

  const isWaiting = starting || busy;

  useEffect(() => {
    if (!isWaiting) {
      setElapsed(0);
      return;
    }
    const startedAt = Date.now();
    const id = window.setInterval(() => setElapsed(Math.round((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(id);
  }, [isWaiting]);

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
    await run(() => aiApi.triggerSprintRecoveryReevaluation(state.threadId));
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
                Diagnoses this sprint from real risk signals + retrieved evidence, proposes grounded
                root-cause hypotheses (every claim must cite something actually retrieved), and — once
                you approve a plan — executes concrete Jira actions idempotently. Pauses durably at
                three different points: a clarifying question if evidence is genuinely insufficient,
                plan approval, and a wait for either a real Jira event or your manual re-check.
              </p>
              <button type="button" className="bl-btn bl-btn--primary" onClick={handleStart} disabled={starting}>
                {starting ? <><span className="sr-spinner" aria-hidden="true" /> {stageLabel ?? 'Starting…'} ({elapsed}s)</> : 'Analyze Sprint Health'}
              </button>
            </>
          )}
          {error && <p className="rl-error">{error}</p>}

          {state && (
            <>
              <div className="rl-status-row">
                <span className={`rl-badge sr-badge--${state.status}`}>{STATUS_LABELS[state.status] ?? state.status}</span>
                <span className="rl-thread">thread {state.threadId.slice(0, 8)} · escalation round {state.escalationRound}</span>
                {busy && (
                  <span className="sr-waiting">
                    <span className="sr-spinner" aria-hidden="true" /> {stageLabel ?? 'working…'} ({elapsed}s)
                  </span>
                )}
                <button type="button" className="bl-btn bl-btn--outline rl-refresh" onClick={handleLoadHistory} disabled={busy}>
                  Time-travel history
                </button>
              </div>
              {state.error && <p className="rl-error">{state.error}</p>}

              {state.status === 'escalated' && state.escalationSummary && (
                <div className="sr-escalation">
                  <p className="sr-escalation__title">
                    Automated recovery couldn't resolve this — handed off to a human
                  </p>
                  <p className="sr-escalation__body">{state.escalationSummary}</p>
                </div>
              )}

              {state.riskSignalCount === 0 && !state.clarificationQuestion && state.hypotheses.length === 0 && (
                <p className="rl-hint">No deterministic risk signals found — nothing to diagnose (this is the correct, honest outcome for a healthy or already-completed sprint, not a bug).</p>
              )}

              {state.status === 'awaiting_clarification' || state.clarificationQuestion ? (
                <div className="sr-clarify">
                  <p className="sr-question"><b>Clarifying question:</b> {state.clarificationQuestion}</p>
                  <textarea
                    className="bl-modal__input"
                    placeholder="Your answer — folded in as evidence for the next diagnosis pass"
                    value={clarifyAnswer}
                    onChange={(e) => setClarifyAnswer(e.target.value)}
                  />
                  <button type="button" className="bl-btn bl-btn--primary" onClick={handleClarify} disabled={busy || !clarifyAnswer.trim()}>
                    Answer
                  </button>
                </div>
              ) : null}

              {state.hypotheses.length > 0 && (
                <div className="sr-hypotheses">
                  <p className="sr-section-title">Root-cause hypotheses</p>
                  <p className="rl-hint sr-hint-tight">
                    {state.evidence.length} evidence item(s) gathered this run. Hover a citation chip
                    (e.g. <code>ev3</code>) below for a preview, or expand "Evidence" further down to see
                    all of them.
                  </p>
                  {state.hypotheses.map((h, i) => (
                    <div className="sr-hyp-card" key={i}>
                      <div className="sr-hyp-card__top">
                        <span
                          className={`rl-badge sr-conf--${h.confidence} sr-tooltip`}
                          data-tooltip="How directly the retrieved evidence supports this specific claim — not how likely the sprint is actually at risk"
                        >
                          {h.confidence} confidence
                        </span>
                      </div>
                      <p className="sr-hyp-card__statement">{h.statement}</p>
                      <div className="sr-cites">
                        {h.supportingEvidenceIds.map((id) => (
                          <code key={id} className="sr-cite-chip sr-tooltip" data-tooltip={_evidencePreview(state, id)}>{id}</code>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {state.evidence.length > 0 && (() => {
                const citedIds = new Set(state.hypotheses.flatMap((h) => h.supportingEvidenceIds));
                return (
                <details className="sr-evidence">
                  <summary className="sr-section-title sr-evidence__summary">
                    Evidence ({citedIds.size} cited by a hypothesis, {state.evidence.length} total gathered — click to expand)
                  </summary>
                  <p className="rl-hint sr-hint-tight">
                    Everything the system actually retrieved this run, not just what a hypothesis
                    happened to cite — shown in full so nothing is hidden, including items the model
                    looked at and decided weren't relevant.
                  </p>
                  <div className="sr-evidence__list">
                    {state.evidence.map((e) => (
                      <div className={`sr-evidence__item${citedIds.has(e.citationId) ? ' sr-evidence__item--cited' : ''}`} key={e.citationId}>
                        <code className="sr-cite-chip">{e.citationId}</code>
                        {citedIds.has(e.citationId) && <span className="sr-evidence__cited-badge">cited</span>}
                        <span className="sr-evidence__meta">{e.issueKey || '(no issue)'} · {e.sourceType}</span>
                        <p className="sr-evidence__content">{e.content}</p>
                      </div>
                    ))}
                  </div>
                </details>
                );
              })()}

              {state.plans.length > 0 && (
                <div className="sr-plans">
                  <p className="sr-section-title">Recovery plans — pick one</p>
                  {state.plans.map((p) => (
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
                                {a.commentBody ? <span className="sr-action__comment">"{a.commentBody.slice(0, 80)}{a.commentBody.length > 80 ? '…' : ''}"</span> : ''}
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
                          You've used all {state.maxPlanRevisionRounds} allowed rounds of "request
                          different plans" for this diagnosis. Approve one of the plans above, or reject
                          all and start a fresh diagnosis.
                        </p>
                      ) : (
                        <>
                          <p className="sr-revise__label">
                            None of these quite right?
                            {state.planRevisionRound > 0
                              ? ` (${state.planRevisionRound}/${state.maxPlanRevisionRounds} revision rounds used)`
                              : ''}
                          </p>
                          <textarea
                            className="bl-modal__input"
                            placeholder="What would you change? (required to request new plans — folded in as feedback for the next round)"
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
              )}

              {(state.status === 'committing' || state.status === 'failed') && (
                <button type="button" className="bl-btn bl-btn--primary" onClick={handleRetry} disabled={busy}>
                  {busy ? 'Working…' : state.status === 'committing' ? 'Resume (ai-service likely restarted mid-commit)' : 'Retry (skips whatever already committed)'}
                </button>
              )}

              {state.status === 'waiting_reevaluation' && (
                <button type="button" className="bl-btn bl-btn--primary" onClick={handleTriggerReevaluation} disabled={busy}>
                  {busy ? 'Checking…' : 'Re-check now (a real Jira event on a relevant issue triggers this automatically)'}
                </button>
              )}

              {state.status === 'rejected' && (
                <button type="button" className="bl-btn bl-btn--primary" onClick={handleStartOver}>
                  Start a new diagnosis
                </button>
              )}

              {history && (
                <div className="sr-history">
                  <p className="sr-section-title">Checkpoint history — pick one to rewind to</p>
                  {history.filter((h) => h.status).map((h) => (
                    <label className="sr-history__row" key={h.checkpointId}>
                      <input
                        type="radio"
                        name="checkpoint"
                        checked={selectedCheckpoint === h.checkpointId}
                        onChange={() => setSelectedCheckpoint(h.checkpointId)}
                      />
                      <span className="sr-history__label">{_checkpointLabel(h.status as string, h.nextNode)}</span>
                      <span className="sr-history__raw">status={h.status} → next={h.nextNode ?? 'end'}</span>
                    </label>
                  ))}
                  {selectedCheckpoint && (
                    <div className="sr-clarify">
                      <textarea
                        className="bl-modal__input"
                        placeholder="Note to fold in as if a human had just answered a clarifying question at that point (e.g. 'PAY-97 was actually descoped per Slack — re-plan around that')"
                        value={timeTravelNote}
                        onChange={(e) => setTimeTravelNote(e.target.value)}
                      />
                      <button type="button" className="bl-btn bl-btn--primary" onClick={handleTimeTravel} disabled={busy || !timeTravelNote.trim()}>
                        Rewind &amp; re-diagnose from here
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
