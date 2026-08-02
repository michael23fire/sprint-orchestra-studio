import { useEffect, useMemo, useState } from 'react';
import type { Sprint } from '../types/sprint';
import type { Ticket } from '../types/ticket';
import { aiApi } from '../api';
import type { FlaggedIssueDto, SprintHealthResponseDto, SprintRiskLevel } from '../api';
import { IssueKeyChip } from './IssueKeyChip';
import './SprintHealthModal.css';

interface SprintHealthModalProps {
  sprint: Sprint;
  tickets: Ticket[];
  onClose: () => void;
}

const STALE_DAYS_THRESHOLD = 3;

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

const RISK_META: Record<SprintRiskLevel, { label: string; className: string }> = {
  on_track: { label: 'On track', className: 'sh-badge--ok' },
  at_risk: { label: 'At risk', className: 'sh-badge--warn' },
  behind: { label: 'Behind', className: 'sh-badge--danger' },
};

export function SprintHealthModal({ sprint, tickets, onClose }: SprintHealthModalProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SprintHealthResponseDto | null>(null);

  const sprintTickets = useMemo(() => tickets.filter((t) => t.sprintId === sprint.id), [tickets, sprint.id]);

  // Everything below is deterministic — computed here, not by the model (see
  // ai-service/app/sprint_health/schemas.py's module docstring for why: burndown math and
  // "who's blocked/stale/unestimated" are facts, not something to let an LLM guess at).
  const stats = useMemo(() => {
    const totalPoints = sprintTickets.reduce((sum, t) => sum + (t.storyPoints ?? 0), 0);
    const completedPoints = sprintTickets
      .filter((t) => t.status === 'done')
      .reduce((sum, t) => sum + (t.storyPoints ?? 0), 0);
    const committedPoints = sprint.initialCommittedPoints ?? totalPoints;

    const issueCountsByStatus: Record<string, number> = {};
    for (const t of sprintTickets) {
      issueCountsByStatus[t.status] = (issueCountsByStatus[t.status] ?? 0) + 1;
    }

    const now = new Date();
    let daysRemaining: number | null = null;
    let riskLevel: SprintRiskLevel = 'on_track';
    if (sprint.startDate && sprint.endDate) {
      const start = new Date(sprint.startDate);
      const end = new Date(sprint.endDate);
      const totalDays = Math.max(daysBetween(start, end), 1);
      daysRemaining = Math.max(daysBetween(now, end), 0);
      const elapsedDays = Math.min(Math.max(daysBetween(start, now), 0), totalDays);
      const expectedProgress = elapsedDays / totalDays;
      const actualProgress = totalPoints > 0 ? completedPoints / totalPoints : 1;
      if (actualProgress >= expectedProgress - 0.1) riskLevel = 'on_track';
      else if (actualProgress >= expectedProgress - 0.25) riskLevel = 'at_risk';
      else riskLevel = 'behind';
    }

    const toFlagged = (list: Ticket[], detail: (t: Ticket) => string | undefined): FlaggedIssueDto[] =>
      list.map((t) => ({ issueKey: t.id, title: t.title, detail: detail(t) }));

    const blockedIssues = toFlagged(
      sprintTickets.filter((t) => t.status === 'blocked'),
      () => undefined,
    );
    const staleIssues = toFlagged(
      sprintTickets.filter((t) => {
        if (t.status === 'done' || !t.updatedAt) return false;
        return daysBetween(new Date(t.updatedAt), now) > STALE_DAYS_THRESHOLD;
      }),
      (t) => `no activity in ${daysBetween(new Date(t.updatedAt as string), now)} days`,
    );
    const unestimatedIssues = toFlagged(
      sprintTickets.filter((t) => t.status !== 'done' && t.storyPoints == null),
      () => undefined,
    );

    return {
      totalPoints, completedPoints, committedPoints, issueCountsByStatus,
      daysRemaining, riskLevel, blockedIssues, staleIssues, unestimatedIssues,
    };
  }, [sprintTickets, sprint]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    aiApi.sprintHealth({
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
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Sprint health check failed.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stats is recomputed fresh each render from sprint/tickets; re-running per stats identity would refetch on every keystroke elsewhere in the app
  }, [sprint.id]);

  const risk = RISK_META[stats.riskLevel];

  return (
    <div className="bl-overlay" onMouseDown={onClose}>
      <div className="bl-modal sh-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="bl-modal__header">
          <h2 className="bl-modal__title">🩺 Sprint Health — {sprint.name}</h2>
          <button type="button" className="bl-modal__close" onClick={onClose}>✕</button>
        </div>
        <div className="bl-modal__body sh-body">
          <div className="sh-stats">
            <span className={`sh-badge ${risk.className}`}>{risk.label}</span>
            <span className="sh-stat">{stats.completedPoints}/{stats.totalPoints} pts</span>
            {stats.daysRemaining != null && <span className="sh-stat">{stats.daysRemaining} day{stats.daysRemaining !== 1 ? 's' : ''} left</span>}
            {Object.entries(stats.issueCountsByStatus).map(([status, count]) => (
              <span className="sh-stat sh-stat--muted" key={status}>{count} {status}</span>
            ))}
          </div>

          {loading && (
            <div className="sh-loading">
              <span className="sh-spinner" aria-hidden />
              Analyzing sprint — checking blocked/stale/unestimated issues and writing a summary…
            </div>
          )}
          {error && <p className="sh-error">{error}</p>}

          {result && (
            <>
              {result.degraded && (
                <p className="sh-hint sh-hint--warn">
                  AI narrative was unavailable — showing a mechanically-assembled summary instead of a
                  generated one. The stats above are unaffected either way.
                </p>
              )}
              <p className="sh-summary">{result.summary}</p>
              {result.recommendations.length > 0 && (
                <div className="sh-recommendations">
                  <span className="sh-recommendations__label">Recommendations</span>
                  <ul>
                    {result.recommendations.map((rec, i) => <li key={i}>{rec}</li>)}
                  </ul>
                </div>
              )}
            </>
          )}

          {(stats.blockedIssues.length > 0 || stats.staleIssues.length > 0 || stats.unestimatedIssues.length > 0) && (
            <div className="sh-flagged">
              {stats.blockedIssues.length > 0 && (
                <div className="sh-flagged__group">
                  <span className="sh-flagged__label">Blocked</span>
                  {stats.blockedIssues.map((i) => (
                    <div className="sh-flagged__row" key={i.issueKey}>
                      <IssueKeyChip issueKey={i.issueKey} size="sm" /> <span>{i.title}</span>
                    </div>
                  ))}
                </div>
              )}
              {stats.staleIssues.length > 0 && (
                <div className="sh-flagged__group">
                  <span className="sh-flagged__label">No recent activity</span>
                  {stats.staleIssues.map((i) => (
                    <div className="sh-flagged__row" key={i.issueKey}>
                      <IssueKeyChip issueKey={i.issueKey} size="sm" /> <span>{i.title}</span>
                      {i.detail && <span className="sh-flagged__detail">({i.detail})</span>}
                    </div>
                  ))}
                </div>
              )}
              {stats.unestimatedIssues.length > 0 && (
                <div className="sh-flagged__group">
                  <span className="sh-flagged__label">No estimate</span>
                  {stats.unestimatedIssues.map((i) => (
                    <div className="sh-flagged__row" key={i.issueKey}>
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
