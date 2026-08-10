import type { Sprint } from '../types/sprint';
import type { Ticket } from '../types/ticket';
import type { SprintRiskLevel } from '../api';

const STALE_DAYS_THRESHOLD = 3;

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

export interface FlaggedIssueStat {
  issueKey: string;
  title: string;
  detail?: string;
}

export interface SprintPaceStats {
  totalPoints: number;
  completedPoints: number;
  committedPoints: number;
  issueCountsByStatus: Record<string, number>;
  daysRemaining: number | null;
  riskLevel: SprintRiskLevel;
  blockedIssues: FlaggedIssueStat[];
  staleIssues: FlaggedIssueStat[];
  unestimatedIssues: FlaggedIssueStat[];
}

/**
 * Deterministic sprint-pace stats — burndown math and "who's blocked/stale/unestimated" are facts,
 * not something to let an LLM guess at (see ai-service/app/sprint_pace/schemas.py's module docstring).
 * Shared by SprintPaceModal (full readout) and the Backlog sprint row (the "Suggested" nudge on the
 * AI recovery button once pace check has something to say).
 */
export function computeSprintPaceStats(sprint: Sprint, sprintTickets: Ticket[]): SprintPaceStats {
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

  const toFlagged = (list: Ticket[], detail: (t: Ticket) => string | undefined): FlaggedIssueStat[] =>
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
}
