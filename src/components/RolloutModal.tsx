import { useState } from 'react';
import { aiApi } from '../api';
import type { EpicDraftDto, IssueDraftDto, RolloutStatusDto } from '../api';
import './RolloutModal.css';

interface RolloutModalProps {
  spaceId: number;
  /** Same refresh callback PlanEpicModal takes (wired to TicketContext's refreshData) — called once
   *  a rollout actually commits, so the backlog reflects what really landed. */
  onCommitted: () => void;
  onClose: () => void;
}

/**
 * A durable, human-approved commit-to-Jira workflow — separate from PlanEpicModal, not a replacement
 * for it. PlanEpicModal's client-side commit loop (generate -> extensively edit sprint buckets +
 * dependencies in the browser -> loop over issueApi.create) is fully-featured but has a real,
 * visible gap: if the browser closes or the network drops mid-loop, "created N of M issues" is a
 * manual-recovery message, not a guarantee. This modal exercises the alternative: the plan is
 * generated and then paused *server-side* (ai-service/app/planning/rollout_graph.py), so approval can
 * happen from a different tab/device/day, and the actual Jira write survives an ai-service restart
 * mid-commit without ever duplicating an issue. Scope is intentionally smaller than PlanEpicModal for
 * now — no sprint bucketing UI, no dependency editing — see aiApi.ts's RolloutStatusDto doc comment.
 */
export function RolloutModal({ spaceId, onCommitted, onClose }: RolloutModalProps) {
  const [proposal, setProposal] = useState('');
  const [genLoading, setGenLoading] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [state, setState] = useState<RolloutStatusDto | null>(null);
  const [decisionLoading, setDecisionLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  /** Local title edits — keyed by tempId, only sent to the server if "Save edits & approve" is used
   *  instead of a plain Approve. Lighter-weight than PlanEpicModal's full inline-editable form. */
  const [editedTitles, setEditedTitles] = useState<Record<string, string>>({});
  // Real progress from the SSE stream (see aiApi.startRolloutStream's onStage) — only ever one label
  // ("generating the rollout plan"), since plan_node is the only LLM call this graph makes on start.
  const [stageLabel, setStageLabel] = useState<string | null>(null);

  async function handleStart() {
    if (!proposal.trim() || genLoading) return;
    setGenLoading(true);
    setGenError(null);
    setStageLabel(null);
    try {
      const result = await aiApi.startRolloutStream(proposal.trim(), spaceId, [], null, null, setStageLabel);
      setState(result);
      setEditedTitles({});
    } catch (err) {
      setGenError(err instanceof Error ? err.message : 'Failed to start the rollout — try again.');
    } finally {
      setGenLoading(false);
      setStageLabel(null);
    }
  }

  async function handleDecision(decision: 'approve' | 'edit' | 'reject') {
    if (!state || decisionLoading) return;
    setDecisionLoading(true);
    try {
      let edited: { epic: EpicDraftDto; issues: IssueDraftDto[] } | undefined;
      if (decision === 'edit' && state.plan) {
        edited = {
          epic: state.plan.epic!,
          issues: state.plan.issues.map((i) => ({ ...i, title: editedTitles[i.tempId] ?? i.title })),
        };
      }
      const result = await aiApi.submitRolloutDecision(state.threadId, decision, edited);
      setState(result);
      if (result.status === 'committed') onCommitted();
    } catch (err) {
      setState((prev) => (prev ? { ...prev, error: err instanceof Error ? err.message : String(err) } : prev));
    } finally {
      setDecisionLoading(false);
    }
  }

  async function handleRetry() {
    if (!state || decisionLoading) return;
    setDecisionLoading(true);
    try {
      const result = await aiApi.retryRollout(state.threadId);
      setState(result);
      if (result.status === 'committed') onCommitted();
    } catch (err) {
      setState((prev) => (prev ? { ...prev, error: err instanceof Error ? err.message : String(err) } : prev));
    } finally {
      setDecisionLoading(false);
    }
  }

  async function handleRefresh() {
    if (!state || refreshing) return;
    setRefreshing(true);
    try {
      const result = await aiApi.getRolloutStatus(state.threadId);
      setState(result);
      if (result.status === 'committed') onCommitted();
    } catch (err) {
      setState((prev) => (prev ? { ...prev, error: err instanceof Error ? err.message : String(err) } : prev));
    } finally {
      setRefreshing(false);
    }
  }

  const statusLabel: Record<string, string> = {
    pending_approval: 'Pending your approval',
    committing: 'Committing to Jira…',
    committed: 'Committed',
    rejected: 'Rejected',
    failed: 'Failed',
  };

  return (
    <div className="bl-overlay" onMouseDown={onClose}>
      <div className="bl-modal rl-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="bl-modal__header">
          <h2 className="bl-modal__title">🔒 Epic rollout (durable, AI Engineer demo)</h2>
          <button type="button" className="bl-modal__close" onClick={onClose}>✕</button>
        </div>
        <div className="bl-modal__body rl-body">
          {!state && (
            <>
              <p className="rl-hint">
                Same plan-generation model as "Plan Epic with AI", but the approval step is durable —
                it pauses server-side (survives an ai-service restart while paused) — and committing
                writes issues to Jira exactly once each, even across a crash mid-commit.
              </p>
              <label className="bl-modal__label" htmlFor="rl-proposal">Proposal</label>
              <textarea
                id="rl-proposal"
                className="bl-modal__input rl-textarea"
                placeholder="e.g. Add a dark mode toggle to account settings, persisted per-user."
                value={proposal}
                onChange={(e) => setProposal(e.target.value)}
                autoFocus
              />
              {genError && <p className="rl-error">{genError}</p>}
            </>
          )}

          {state && (
            <>
              <div className="rl-status-row">
                <span className={`rl-badge rl-badge--${state.status}`}>{statusLabel[state.status] ?? state.status}</span>
                <span className="rl-thread">thread {state.threadId.slice(0, 8)}</span>
                <button type="button" className="bl-btn bl-btn--outline rl-refresh" onClick={handleRefresh} disabled={refreshing}>
                  {refreshing ? 'Refreshing…' : 'Refresh status'}
                </button>
              </div>
              {state.error && <p className="rl-error">{state.error}</p>}

              {state.plan?.epic && (
                <>
                  <p className="rl-epic-title">
                    {state.epicIssueKey ? `${state.epicIssueKey} — ` : ''}{state.plan.epic.title}
                  </p>
                  <p className="rl-epic-desc">{state.plan.epic.description}</p>
                </>
              )}

              <div className="rl-issues">
                {state.plan?.issues.map((issue) => {
                  const createdKey = state.committedIssueKeys[issue.tempId];
                  return (
                    <div className="rl-issue" key={issue.tempId}>
                      {createdKey && <span className="rl-badge rl-badge--committed rl-issue__key">{createdKey}</span>}
                      <input
                        className="bl-modal__input"
                        value={editedTitles[issue.tempId] ?? issue.title}
                        disabled={state.status !== 'pending_approval'}
                        onChange={(e) => setEditedTitles((prev) => ({ ...prev, [issue.tempId]: e.target.value }))}
                      />
                      <span className="rl-issue__meta">{issue.issueType} · {issue.estimateStoryPoints ?? '?'} pts</span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
        <div className="bl-modal__footer">
          {!state && (
            <>
              <button type="button" className="bl-btn bl-btn--ghost" onClick={onClose}>Cancel</button>
              <button
                type="button"
                className="bl-btn bl-btn--primary"
                onClick={handleStart}
                disabled={!proposal.trim() || genLoading}
              >
                {genLoading ? (stageLabel ?? 'Starting…') : 'Generate plan (pauses for approval)'}
              </button>
            </>
          )}
          {state?.status === 'pending_approval' && (
            <>
              <button type="button" className="bl-btn bl-btn--ghost" onClick={() => handleDecision('reject')} disabled={decisionLoading}>
                Reject
              </button>
              <button type="button" className="bl-btn bl-btn--outline" onClick={() => handleDecision('edit')} disabled={decisionLoading}>
                Save title edits &amp; approve
              </button>
              <button type="button" className="bl-btn bl-btn--primary" onClick={() => handleDecision('approve')} disabled={decisionLoading}>
                {decisionLoading ? 'Committing…' : 'Approve — commit to Jira'}
              </button>
            </>
          )}
          {(state?.status === 'failed' || state?.status === 'committing') && (
            <>
              <button type="button" className="bl-btn bl-btn--ghost" onClick={onClose}>Close</button>
              <button type="button" className="bl-btn bl-btn--primary" onClick={handleRetry} disabled={decisionLoading}>
                {decisionLoading
                  ? 'Working…'
                  : state.status === 'committing'
                    ? 'Resume (ai-service likely restarted mid-commit)'
                    : 'Retry (skips whatever already committed)'}
              </button>
            </>
          )}
          {state && state.status !== 'pending_approval' && state.status !== 'failed' && state.status !== 'committing' && (
            <button type="button" className="bl-btn bl-btn--primary" onClick={onClose}>Close</button>
          )}
        </div>
      </div>
    </div>
  );
}
