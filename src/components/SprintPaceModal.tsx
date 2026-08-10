import { useEffect, useMemo, useState } from 'react';
import type { Sprint } from '../types/sprint';
import type { Ticket } from '../types/ticket';
import { aiApi } from '../api';
import type { SprintPaceResponseDto, SprintRiskLevel } from '../api';
import { computeSprintPaceStats } from '../utils/sprintPaceStats';
import { IssueKeyChip } from './IssueKeyChip';
import './SprintPaceModal.css';

interface SprintPaceModalProps {
  sprint: Sprint;
  tickets: Ticket[];
  onClose: () => void;
}

const RISK_META: Record<SprintRiskLevel, { label: string; className: string }> = {
  on_track: { label: 'On track', className: 'sp-badge--ok' },
  at_risk: { label: 'At risk', className: 'sp-badge--warn' },
  behind: { label: 'Behind', className: 'sp-badge--danger' },
};

export function SprintPaceModal({ sprint, tickets, onClose }: SprintPaceModalProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SprintPaceResponseDto | null>(null);

  const sprintTickets = useMemo(() => tickets.filter((t) => t.sprintId === sprint.id), [tickets, sprint.id]);

  // Deterministic — computed here, not by the model (see ai-service/app/sprint_pace/schemas.py's
  // module docstring for why: burndown math and "who's blocked/stale/unestimated" are facts, not
  // something to let an LLM guess at). Shared with the Backlog row's AI-recovery gating.
  const stats = useMemo(() => computeSprintPaceStats(sprint, sprintTickets), [sprintTickets, sprint]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    aiApi.sprintPace({
      sprintName: sprint.name,
      riskLevel: stats.riskLevel,
      daysRemaining: stats.daysRemaining,
      committedPoints: stats.committedPoints,
      completedPoints: stats.completedPoints,
      totalPoints: stats.totalPoints,
      issueCountsByStatus: stats.issueCountsByStatus,
      blockedIssues: stats.blockedIssues,
      staleIssues: stats.staleIssues,
      unestimatedIssues: stats.unestimatedIssues,
    })
      .then((res) => { if (!cancelled) setResult(res); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Sprint pace check failed.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stats is recomputed fresh each render from sprint/tickets; re-running per stats identity would refetch on every keystroke elsewhere in the app
  }, [sprint.id]);

  const risk = RISK_META[stats.riskLevel];

  return (
    <div className="bl-overlay" onMouseDown={onClose}>
      <div className="bl-modal sp-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="bl-modal__header">
          <h2 className="bl-modal__title">🩺 Sprint Pace Check — {sprint.name}</h2>
          <button type="button" className="bl-modal__close" onClick={onClose}>✕</button>
        </div>
        <div className="bl-modal__body sp-body">
          <p className="sp-hint sp-hint--scope">
            Schedule pace (points vs. days elapsed) plus basic blocked/stale/unestimated flags below —
            not a root-cause diagnosis. For why something's stuck and a Jira-actionable fix, run AI
            recovery.
          </p>
          <div className="sp-stats">
            <span className={`sp-badge ${risk.className}`}>{risk.label}</span>
            <span className="sp-stat">{stats.completedPoints}/{stats.totalPoints} pts</span>
            {stats.daysRemaining != null && <span className="sp-stat">{stats.daysRemaining} day{stats.daysRemaining !== 1 ? 's' : ''} left</span>}
            {Object.entries(stats.issueCountsByStatus).map(([status, count]) => (
              <span className="sp-stat sp-stat--muted" key={status}>{count} {status}</span>
            ))}
          </div>

          {loading && (
            <div className="sp-loading">
              <span className="sp-spinner" aria-hidden />
              Analyzing sprint — checking blocked/stale/unestimated issues and writing a summary…
            </div>
          )}
          {error && <p className="sp-error">{error}</p>}

          {result && (
            <>
              {result.degraded && (
                <p className="sp-hint sp-hint--warn">
                  AI narrative was unavailable — showing a mechanically-assembled summary instead of a
                  generated one. The stats above are unaffected either way.
                </p>
              )}
              <p className="sp-summary">{result.summary}</p>
              {result.recommendations.length > 0 && (
                <div className="sp-recommendations">
                  <span className="sp-recommendations__label">Recommendations</span>
                  <ul>
                    {result.recommendations.map((rec, i) => <li key={i}>{rec}</li>)}
                  </ul>
                </div>
              )}
              {!result.degraded && (
                <p className="sp-hint sp-hint--cost">
                  {result.inputTokens.toLocaleString()} in / {result.outputTokens.toLocaleString()} out tokens
                  {' · '}
                  {result.estimatedCostUsd > 0 ? `$${result.estimatedCostUsd.toFixed(4)}` : 'free (local model)'}
                </p>
              )}
            </>
          )}

          {(stats.blockedIssues.length > 0 || stats.staleIssues.length > 0 || stats.unestimatedIssues.length > 0) && (
            <div className="sp-flagged">
              {stats.blockedIssues.length > 0 && (
                <div className="sp-flagged__group">
                  <span className="sp-flagged__label">Blocked</span>
                  {stats.blockedIssues.map((i) => (
                    <div className="sp-flagged__row" key={i.issueKey}>
                      <IssueKeyChip issueKey={i.issueKey} size="sm" /> <span>{i.title}</span>
                    </div>
                  ))}
                </div>
              )}
              {stats.staleIssues.length > 0 && (
                <div className="sp-flagged__group">
                  <span className="sp-flagged__label">No recent activity</span>
                  {stats.staleIssues.map((i) => (
                    <div className="sp-flagged__row" key={i.issueKey}>
                      <IssueKeyChip issueKey={i.issueKey} size="sm" /> <span>{i.title}</span>
                      {i.detail && <span className="sp-flagged__detail">({i.detail})</span>}
                    </div>
                  ))}
                </div>
              )}
              {stats.unestimatedIssues.length > 0 && (
                <div className="sp-flagged__group">
                  <span className="sp-flagged__label">No estimate</span>
                  {stats.unestimatedIssues.map((i) => (
                    <div className="sp-flagged__row" key={i.issueKey}>
                      <IssueKeyChip issueKey={i.issueKey} size="sm" /> <span>{i.title}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="bl-modal__footer">
          <button type="button" className="bl-btn bl-btn--primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
