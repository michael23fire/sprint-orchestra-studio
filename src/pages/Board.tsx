import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { DragDropContext, type DropResult } from '@hello-pangea/dnd';
import { BoardAssigneeFilter } from '../components/BoardAssigneeFilter';
import { BoardColumn } from '../components/BoardColumn';
import { CompleteSprintModal } from '../components/CompleteSprintModal';
import { CreateTaskModal } from '../components/CreateTaskModal';
import { IssueFilterPanel } from '../components/IssueFilterPanel';
import { TicketDetailModal } from '../components/TicketDetailModal';
import { AssigneeAvatar } from '../components/AssigneeAvatar';
import { useTickets } from '../context/TicketContext';
import { useSpaces } from '../context/SpaceContext';
import { effectiveSpaceMemberIds } from '../types/space';
import { useCurrentUser } from '../context/UserContext';
import { ISSUE_TYPE_META, type Ticket, type TicketStatus } from '../types/ticket';
import {
  arrayMove,
  buildFlatDragItems,
  countRootsBeforeFlatIndex,
  mergeSavedFlatOrder,
  orderRootsBySaved,
  groupTicketsByBoardColumn,
} from '../utils/boardFlatItems';
import { BOARD_ASSIGNEE_FILTER_UNASSIGNED, collectToolbarAssigneeNames, primaryAssigneeName, ticketMatchesAssigneeFilter } from '../utils/assigneeDisplay';
import {
  EMPTY_ISSUE_FILTERS,
  hasActiveIssueFilters,
  type IssueFilters,
  ticketMatchesIssueFilters,
  withMatchedParents,
  withMatchedChildren,
} from '../utils/issueFilters';
import { resolveEpicKey } from '../utils/ticketHierarchy';
import { formatDueDateWithTime, parseDueDate } from '../utils/dueDate';
import { buildStatusLifecycle } from '../utils/statusLifecycle';
import { historyApi, type IssueHistoryDto } from '../api';
import './Board.css';
import '../components/AssigneeAvatar.css';

const TOOLBAR_ICON_PX = 24;

function IconSprintDetails() {
  return (
    <svg width={TOOLBAR_ICON_PX} height={TOOLBAR_ICON_PX} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path stroke="currentColor" strokeWidth="2" strokeLinecap="round" d="M8 6h13M8 12h13M8 18h13" />
      <circle cx="4" cy="6" r="1.5" fill="currentColor" />
      <circle cx="4" cy="12" r="1.5" fill="currentColor" />
      <circle cx="4" cy="18" r="1.5" fill="currentColor" />
    </svg>
  );
}

function IconSprintInsights() {
  return (
    <svg width={TOOLBAR_ICON_PX} height={TOOLBAR_ICON_PX} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="2" />
      <path stroke="currentColor" strokeWidth="2" d="M15 3v18" />
    </svg>
  );
}

function IconViewSettings() {
  return (
    <svg width={TOOLBAR_ICON_PX} height={TOOLBAR_ICON_PX} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2" />
      <path
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"
      />
    </svg>
  );
}

const BOARD_HIDE_SUBTASKS_KEY = 'jira_board_hide_subtasks';
const BOARD_VIEW_SETTINGS_KEY = 'jira_board_view_settings';
type GroupMode = 'none' | 'assignee' | 'epic' | 'subtask';
const GROUP_MODE_LABELS: Record<GroupMode, string> = {
  none: 'None',
  assignee: 'Assignee',
  epic: 'Epic',
  subtask: 'Subtask',
};
type InsightAttentionTab = 'all' | 'due' | 'stuck' | 'blocked' | 'flagged';
interface BoardViewSettings {
  showIssueKey: boolean;
  showDueDate: boolean;
  showEpic: boolean;
  showAssignee: boolean;
  showWorkType: boolean;
  showPriority: boolean;
  showLabels: boolean;
  showStoryPoints: boolean;
}

const COLUMNS: { status: TicketStatus; title: string; isDone?: boolean }[] = [
  { status: 'planned', title: 'PLANNED' },
  { status: 'in_progress', title: 'IN PROGRESS' },
  { status: 'blocked', title: 'BLOCKED' },
  { status: 'in_review', title: 'IN REVIEW' },
  { status: 'done', title: 'DONE', isDone: true },
];

const ATTENTION_TAB_LABELS: Record<InsightAttentionTab, string> = {
  all: 'All',
  due: 'Due',
  stuck: 'Stuck',
  blocked: 'Blocked',
  flagged: 'Flagged',
};

const DAY_MS = 86_400_000;
const ATTENTION_PAGE_SIZE = 3;
/** 85th-percentile outlier detection needs enough completed visits to a status to be meaningful. */
const MIN_STUCK_HISTORY_SAMPLES = 7;

const ATTENTION_DESCRIPTIONS: Record<InsightAttentionTab, (count: number) => string> = {
  all: (count) => `${count} work item${count === 1 ? '' : 's'} ${count === 1 ? 'is' : 'are'} either overdue, stuck, dependent on other work items, or flagged in the current sprint.`,
  due: (count) => `${count} overdue work item${count === 1 ? '' : 's'} ${count === 1 ? 'needs' : 'need'} attention in the current sprint.`,
  stuck: (count) => `${count} work item${count === 1 ? '' : 's'} ${count === 1 ? 'has' : 'have'} stayed in the same status longer than expected.`,
  blocked: (count) => `${count} work item${count === 1 ? '' : 's'} ${count === 1 ? 'is' : 'are'} dependent on other work items.`,
  flagged: (count) => `${count} work item${count === 1 ? '' : 's'} ${count === 1 ? 'is' : 'are'} flagged in the current sprint.`,
};

function parseFlexibleDate(value?: string): Date | null {
  if (!value) return null;
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const parsed = isoMatch
    ? new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]), 23, 59, 59, 999)
    : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function attentionStatusLabel(status: TicketStatus): string {
  return status.replace('_', ' ').toUpperCase();
}

function stuckDurationLabel(elapsedMs?: number): string {
  if (elapsedMs == null || !Number.isFinite(elapsedMs)) return 'Stuck';
  const safeElapsedMs = Math.max(0, elapsedMs);
  const totalDays = Math.floor(safeElapsedMs / DAY_MS);
  if (totalDays < 1) {
    const hours = Math.max(1, Math.floor(safeElapsedMs / 3_600_000));
    return `Stuck for ${hours}h`;
  }
  const weeks = Math.floor(totalDays / 7);
  const days = totalDays % 7;
  if (weeks > 0 && days > 0) return `Stuck for ${weeks}w ${days}d`;
  if (weeks > 0) return `Stuck for ${weeks}w`;
  return `Stuck for ${totalDays}d`;
}

function isBlockedByRelation(relation: string): boolean {
  const normalized = relation.trim().toLowerCase().replace(/\s+/g, ' ');
  return normalized === 'is blocked by' || normalized === 'blocked by';
}

function isBlocksRelation(relation: string): boolean {
  return relation.trim().toLowerCase().replace(/\s+/g, ' ') === 'blocks';
}

function blockedAttentionLabel(ticket: Ticket, allTickets: Ticket[]): string {
  const blocker = (ticket.linkedIssues ?? []).find(
    (link) => isBlockedByRelation(link.relation),
  );
  if (blocker) return `Blocked by ${blocker.linkedIssueKey}`;
  const reverseBlocker = allTickets.find((candidate) =>
    (candidate.linkedIssues ?? []).some(
      (link) => isBlocksRelation(link.relation) && link.linkedIssueKey === ticket.id,
    ),
  );
  return reverseBlocker ? `Blocked by ${reverseBlocker.id}` : 'Blocked';
}

function updatedAtForAttention(ticket: Ticket): Date | null {
  return parseFlexibleDate(ticket.updatedAt) ?? parseFlexibleDate(ticket.createdAt);
}

function collectBlockedIssueIds(tickets: Ticket[]): Set<string> {
  const blockedIds = new Set<string>();
  for (const ticket of tickets) {
    if (ticket.status === 'blocked') blockedIds.add(ticket.id);
    for (const link of ticket.linkedIssues ?? []) {
      if (isBlockedByRelation(link.relation)) blockedIds.add(ticket.id);
      if (isBlocksRelation(link.relation)) blockedIds.add(link.linkedIssueKey);
    }
  }
  return blockedIds;
}

function isDueForAttention(ticket: Ticket): boolean {
  if (ticket.status === 'done') return false;
  const due = parseDueDate(ticket.dueDate);
  return due != null && due.getTime() < Date.now();
}

function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
}

function percentageBreakdown(counts: [number, number, number]): [number, number, number] {
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total === 0) return [0, 0, 0];

  const exact = counts.map((count) => (count / total) * 100);
  const roundedDown = exact.map(Math.floor);
  let remaining = 100 - roundedDown.reduce((sum, value) => sum + value, 0);
  const remainderOrder = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let i = 0; i < remaining; i += 1) {
    roundedDown[remainderOrder[i % remainderOrder.length].index] += 1;
  }
  return roundedDown as [number, number, number];
}

function attentionSortByDue(a: Ticket, b: Ticket): number {
  const ad = parseDueDate(a.dueDate)?.getTime() ?? Number.POSITIVE_INFINITY;
  const bd = parseDueDate(b.dueDate)?.getTime() ?? Number.POSITIVE_INFINITY;
  if (ad !== bd) return ad - bd;
  return a.id.localeCompare(b.id);
}

function attentionSortByUpdated(a: Ticket, b: Ticket): number {
  const au = updatedAtForAttention(a)?.getTime() ?? Number.NEGATIVE_INFINITY;
  const bu = updatedAtForAttention(b)?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (au !== bu) return au - bu;
  return a.id.localeCompare(b.id);
}

function sprintTimeLabel(endDate?: string): string {
  if (!endDate) return 'No end date';
  const end = new Date(endDate);
  if (Number.isNaN(end.getTime())) return 'No end date';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  const diff = Math.ceil((end.getTime() - today.getTime()) / 86400000);
  if (diff > 1) return `${diff} days left`;
  if (diff === 1) return '1 day left';
  if (diff === 0) return 'Ends today';
  if (diff === -1) return 'Ended 1 day ago';
  return `Ended ${Math.abs(diff)} days ago`;
}

function formatSprintDate(input?: string): string {
  if (!input) return 'Not set';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  const date = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : new Date(input);
  if (Number.isNaN(date.getTime())) return 'Not set';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function Board() {
  const {
    tickets, sprints, loading, nextId, addTicket, updateTicket, updateTicketStatus, createSubtask,
    completeSprint, deleteTicket, addComment, editComment, deleteComment, addIssueLink, deleteIssueLink,
    addCodeLink, deleteCodeLink, refreshCodeLinks, hydrateIssueDetail, applyBacklogRank,
  } = useTickets();
  const { currentUser } = useCurrentUser();
  const { currentSpace } = useSpaces();
  const activeSprint = useMemo(() => sprints.find((s) => s.status === 'active') ?? null, [sprints]);
  const boardTickets = useMemo(
    () => (activeSprint
      ? tickets.filter((t) => t.sprintId === activeSprint.id && t.issueType !== 'epic')
      : []),
    [tickets, activeSprint],
  );
  const fullTicketsByStatus = useMemo(() => groupTicketsByBoardColumn(boardTickets), [boardTickets]);
  const [assigneeFilter, setAssigneeFilter] = useState<string[]>([]);
  const [boardSearch, setBoardSearch] = useState('');
  const [issueFilters, setIssueFilters] = useState<IssueFilters>(EMPTY_ISSUE_FILTERS);
  const [completeSprintOpen, setCompleteSprintOpen] = useState(false);
  const boardAssigneeNames = useMemo(
    () =>
      collectToolbarAssigneeNames(boardTickets, {
        spaceMemberIds: effectiveSpaceMemberIds(currentSpace),
      }),
    [boardTickets, currentSpace],
  );
  useEffect(() => {
    setAssigneeFilter([]);
    setIssueFilters(EMPTY_ISSUE_FILTERS);
  }, [activeSprint?.id]);
  useEffect(() => {
    setAssigneeFilter((prev) => {
      const next = prev.filter(
        (f) => f === BOARD_ASSIGNEE_FILTER_UNASSIGNED || boardAssigneeNames.sortedNames.includes(f),
      );
      return next.length === prev.length ? prev : next;
    });
  }, [boardAssigneeNames.sortedNames]);
  const filteredBoardTickets = useMemo(() => {
    const byAssignee = boardTickets.filter((t) => ticketMatchesAssigneeFilter(t, assigneeFilter));
    const useFilters = hasActiveIssueFilters(issueFilters);
    const q = boardSearch.trim().toLowerCase();
    const match = (t: Ticket) => {
      // Assignee chips already applied; skip assignee dimension in the panel filters.
      if (useFilters && !ticketMatchesIssueFilters(t, issueFilters, { skipAssignee: true, allTickets: tickets })) return false;
      if (!q) return true;
      return (
        t.title.toLowerCase().includes(q) ||
        t.id.toLowerCase().includes(q) ||
        (primaryAssigneeName(t) ?? '').toLowerCase().includes(q)
      );
    };
    // Always re-attach subtasks of visible parents from the full sprint set so Hide/nest
    // still works when assignee chips would otherwise drop unassigned children.
    if (!q && !useFilters) return withMatchedChildren(byAssignee, boardTickets);
    const direct = byAssignee.filter(match);
    // Keep parents of matched subtasks so cards still nest correctly on the board.
    return withMatchedChildren(withMatchedParents(direct, boardTickets), boardTickets);
  }, [boardTickets, assigneeFilter, boardSearch, issueFilters, tickets]);
  const displayTicketsByStatus = useMemo(
    () => groupTicketsByBoardColumn(filteredBoardTickets),
    [filteredBoardTickets],
  );
  /** Per-column flat draggable id order (localStorage when Group = none). */
  const [columnFlatOrders, setColumnFlatOrders] = useState<Record<TicketStatus, string[]>>(() => ({} as Record<TicketStatus, string[]>));
  /** Issue keys whose subtasks are collapsed (hidden). */
  const [collapsedParents, setCollapsedParents] = useState<Set<string>>(() => new Set());
  const toggleParentFold = useCallback((issueKey: string) => {
    setCollapsedParents((prev) => {
      const next = new Set(prev);
      if (next.has(issueKey)) next.delete(issueKey);
      else next.add(issueKey);
      return next;
    });
  }, []);
  const [hideSubtasksOnBoard, setHideSubtasksOnBoard] = useState(() => {
    try {
      return localStorage.getItem(BOARD_HIDE_SUBTASKS_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [viewSettings, setViewSettings] = useState<BoardViewSettings>(() => {
    try {
      const raw = localStorage.getItem(BOARD_VIEW_SETTINGS_KEY);
      if (!raw) return { showIssueKey: true, showDueDate: true, showEpic: true, showAssignee: true, showWorkType: true, showPriority: true, showLabels: true, showStoryPoints: true };
      const parsed = JSON.parse(raw) as Partial<BoardViewSettings>;
      return {
        showIssueKey: parsed.showIssueKey ?? true,
        showDueDate: parsed.showDueDate ?? true,
        showEpic: parsed.showEpic ?? true,
        showAssignee: parsed.showAssignee ?? true,
        showWorkType: parsed.showWorkType ?? true,
        showPriority: parsed.showPriority ?? true,
        showLabels: parsed.showLabels ?? true,
        showStoryPoints: parsed.showStoryPoints ?? true,
      };
    } catch {
      return { showIssueKey: true, showDueDate: true, showEpic: true, showAssignee: true, showWorkType: true, showPriority: true, showLabels: true, showStoryPoints: true };
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(BOARD_HIDE_SUBTASKS_KEY, hideSubtasksOnBoard ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [hideSubtasksOnBoard]);
  useEffect(() => {
    try {
      localStorage.setItem(BOARD_VIEW_SETTINGS_KEY, JSON.stringify(viewSettings));
    } catch {
      /* ignore */
    }
  }, [viewSettings]);
  const [modalStatus, setModalStatus] = useState<TicketStatus | null>(null);
  const [groupMode, setGroupMode] = useState<GroupMode>('none');
  const [groupMenuOpen, setGroupMenuOpen] = useState(false);
  const [sprintDetailOpen, setSprintDetailOpen] = useState(false);
  const [sprintInsightsOpen, setSprintInsightsOpen] = useState(false);
  const [sprintProgressExpanded, setSprintProgressExpanded] = useState(true);
  const [epicProgressExpanded, setEpicProgressExpanded] = useState(true);
  const [viewSettingsOpen, setViewSettingsOpen] = useState(false);
  const [attentionTab, setAttentionTab] = useState<InsightAttentionTab>('all');
  const [attentionPage, setAttentionPage] = useState(0);
  const [attentionHistories, setAttentionHistories] = useState<Record<string, IssueHistoryDto[] | null>>({});
  const [stuckAnalysisLoading, setStuckAnalysisLoading] = useState(false);
  // Status changes are optimistic, so `historyRequestKey` can fire once before
  // the backend has committed the matching history row. Bump this only after a
  // successful save to guarantee a second, authoritative history refresh.
  const [insightsHistoryRefreshVersion, setInsightsHistoryRefreshVersion] = useState(0);
  const groupMenuRef = useRef<HTMLDivElement>(null);
  const sprintDetailRef = useRef<HTMLDivElement>(null);
  const viewSettingsRef = useRef<HTMLDivElement>(null);
  const prevBoardOrderSprintKeyRef = useRef<string>('');
  const boardOrderSprintKey = activeSprint ? `${currentSpace.id}:${activeSprint.id}` : '';
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedTicketId = searchParams.get('ticket');
  const selectedTicket = useMemo(() => tickets.find((t) => t.id === selectedTicketId) ?? null, [tickets, selectedTicketId]);

  useEffect(() => {
    if (!selectedTicketId) return;
    void hydrateIssueDetail(selectedTicketId);
  }, [selectedTicketId, hydrateIssueDetail]);
  const activeSprintIssues = useMemo(
    () => (activeSprint ? tickets.filter((t) => t.sprintId === activeSprint.id) : []),
    [tickets, activeSprint],
  );
  const activeSprintIssueKeys = activeSprintIssues.map((ticket) => ticket.id).sort().join('|');
  useEffect(() => {
    if (!sprintInsightsOpen) return;
    for (const issueKey of activeSprintIssueKeys.split('|').filter(Boolean)) {
      void hydrateIssueDetail(issueKey);
    }
  }, [activeSprintIssueKeys, hydrateIssueDetail, sprintInsightsOpen]);

  const historyRequestKey = tickets
    .filter((ticket) => ticket.dbId != null)
    .map((ticket) => `${ticket.id}:${ticket.dbId}:${ticket.status}:${ticket.updatedAt ?? ''}`)
    .sort()
    .join('|');
  useEffect(() => {
    if (!sprintInsightsOpen) return;
    const issuesWithHistory = tickets.filter((ticket) => ticket.dbId != null);
    if (issuesWithHistory.length === 0) {
      setAttentionHistories({});
      setStuckAnalysisLoading(false);
      return;
    }

    let cancelled = false;
    setStuckAnalysisLoading(true);
    void Promise.all(
      issuesWithHistory.map(async (ticket) => {
        try {
          const history = await historyApi.getByIssue(ticket.dbId!);
          return [ticket.id, history] as const;
        } catch {
          return [ticket.id, null] as const;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      setAttentionHistories((previous) => Object.fromEntries(
        entries.map(([issueKey, history]) => [
          issueKey,
          // A transient failure must not blank every Stuck result. Keep the
          // last valid snapshot until this issue can be refreshed successfully.
          history ?? previous[issueKey] ?? null,
        ]),
      ));
      setStuckAnalysisLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [historyRequestKey, insightsHistoryRefreshVersion, sprintInsightsOpen]);

  const stuckAnalysis = useMemo(() => {
    const currentDurationByIssue = new Map<string, number>();
    const completedDurationsByStatus = new Map<TicketStatus, number[]>();

    for (const ticket of tickets) {
      if (!ticket.createdAt) continue;
      const history = ticket.dbId == null ? [] : attentionHistories[ticket.id];
      // A failed or not-yet-loaded history request must not create a false Stuck result.
      if (history == null) continue;

      const lifecycle = buildStatusLifecycle(history, ticket.createdAt, ticket.status);
      for (const segment of lifecycle) {
        if (segment.isOngoing || segment.status === 'done' || segment.durationMs <= 0) continue;
        const status = segment.status as TicketStatus;
        const completedSamples = completedDurationsByStatus.get(status) ?? [];
        completedSamples.push(segment.durationMs);
        completedDurationsByStatus.set(status, completedSamples);
      }

      if (ticket.status === 'done') continue;
      const currentSegment = [...lifecycle]
        .reverse()
        .find((segment) => segment.isOngoing && segment.status === ticket.status);
      if (!currentSegment) continue;

      currentDurationByIssue.set(ticket.id, currentSegment.durationMs);
    }

    const thresholdByStatus = new Map<TicketStatus, number>();
    for (const status of ['planned', 'in_progress', 'blocked', 'in_review'] as TicketStatus[]) {
      const completed = completedDurationsByStatus.get(status) ?? [];
      // With fewer than seven samples, a single short transition can make an
      // issue look stuck after only a few hours. Wait for a stable distribution.
      if (completed.length < MIN_STUCK_HISTORY_SAMPLES) continue;
      const threshold = percentile(completed, 0.85);
      if (threshold != null) thresholdByStatus.set(status, threshold);
    }

    const issueIds = new Set<string>();
    for (const ticket of tickets) {
      if (ticket.status === 'done') continue;
      const duration = currentDurationByIssue.get(ticket.id);
      const threshold = thresholdByStatus.get(ticket.status);
      if (duration != null && threshold != null && duration > threshold) {
        issueIds.add(ticket.id);
      }
    }

    return { issueIds, currentDurationByIssue };
  }, [attentionHistories, tickets]);
  const dueIssues = useMemo(
    () => activeSprintIssues
      .filter(isDueForAttention)
      .sort(attentionSortByDue),
    [activeSprintIssues],
  );
  const blockedIssueIds = useMemo(() => collectBlockedIssueIds(tickets), [tickets]);
  const blockedIssues = useMemo(
    () => activeSprintIssues
      .filter((t) => t.status !== 'done' && blockedIssueIds.has(t.id))
      .sort(attentionSortByUpdated),
    [activeSprintIssues, blockedIssueIds],
  );
  const stuckIssues = useMemo(
    () => activeSprintIssues
      .filter((t) => stuckAnalysis.issueIds.has(t.id))
      .sort((a, b) => (
        (stuckAnalysis.currentDurationByIssue.get(b.id) ?? 0) -
        (stuckAnalysis.currentDurationByIssue.get(a.id) ?? 0)
      )),
    [activeSprintIssues, stuckAnalysis],
  );
  const flaggedIssues = useMemo(
    () => activeSprintIssues
      .filter((t) => t.status !== 'done' && t.flagged === true)
      .sort(attentionSortByUpdated),
    [activeSprintIssues],
  );
  const attentionIssues = useMemo(() => {
    if (attentionTab === 'all') {
      const attentionIds = new Set([
        ...dueIssues.map((t) => t.id),
        ...stuckIssues.map((t) => t.id),
        ...blockedIssues.map((t) => t.id),
        ...flaggedIssues.map((t) => t.id),
      ]);
      return activeSprintIssues
        .filter((t) => attentionIds.has(t.id))
        .sort((a, b) => {
          const rank = (ticket: Ticket): number => {
            if (isDueForAttention(ticket)) return 0;
            if (blockedIssueIds.has(ticket.id)) return 1;
            if (stuckAnalysis.issueIds.has(ticket.id)) return 2;
            if (ticket.flagged) return 3;
            return 3;
          };
          const diff = rank(a) - rank(b);
          if (diff !== 0) return diff;
          return attentionSortByUpdated(a, b);
        });
    }
    if (attentionTab === 'due') return dueIssues;
    if (attentionTab === 'blocked') return blockedIssues;
    if (attentionTab === 'stuck') return stuckIssues;
    return flaggedIssues;
  }, [attentionTab, activeSprintIssues, blockedIssueIds, blockedIssues, dueIssues, flaggedIssues, stuckAnalysis.issueIds, stuckIssues]);
  const attentionPageCount = Math.max(1, Math.ceil(attentionIssues.length / ATTENTION_PAGE_SIZE));
  const pagedAttentionIssues = useMemo(
    () => attentionIssues.slice(
      attentionPage * ATTENTION_PAGE_SIZE,
      (attentionPage + 1) * ATTENTION_PAGE_SIZE,
    ),
    [attentionIssues, attentionPage],
  );
  useEffect(() => {
    setAttentionPage((page) => Math.min(page, attentionPageCount - 1));
  }, [attentionPageCount]);
  const sprintProgress = useMemo(() => {
    const done = activeSprintIssues.filter((ticket) => ticket.status === 'done').length;
    const inProgress = activeSprintIssues.filter((ticket) => (
      ticket.status === 'in_progress' || ticket.status === 'blocked' || ticket.status === 'in_review'
    )).length;
    const notStarted = activeSprintIssues.filter((ticket) => ticket.status === 'planned').length;
    const [donePercent, inProgressPercent, notStartedPercent] = percentageBreakdown([
      done,
      inProgress,
      notStarted,
    ]);
    return {
      done,
      inProgress,
      notStarted,
      donePercent,
      inProgressPercent,
      notStartedPercent,
    };
  }, [activeSprintIssues]);
  const burndownPoints = useMemo(
    () => activeSprintIssues.reduce(
      (totals, ticket) => {
        const points = ticket.storyPoints ?? 0;
        if (ticket.status === 'done') totals.done += points;
        else totals.toGo += points;
        return totals;
      },
      { done: 0, toGo: 0 },
    ),
    [activeSprintIssues],
  );
  const epicProgress = useMemo(() => {
    const grouped = new Map<string, Ticket[]>();
    for (const ticket of activeSprintIssues) {
      if (ticket.issueType === 'epic') continue;
      const epicKey = resolveEpicKey(ticket, tickets);
      if (!epicKey) continue;
      const issues = grouped.get(epicKey) ?? [];
      issues.push(ticket);
      grouped.set(epicKey, issues);
    }

    return Array.from(grouped, ([epicKey, issues]) => {
      const epic = tickets.find((ticket) => ticket.id === epicKey && ticket.issueType === 'epic');
      const done = issues.filter((ticket) => ticket.status === 'done').length;
      return {
        epicKey,
        title: epic?.title ?? epicKey,
        percentDone: issues.length > 0 ? Math.round((done / issues.length) * 100) : 0,
      };
    });
  }, [activeSprintIssues, tickets]);

  useEffect(() => {
    if (!activeSprint) {
      setColumnFlatOrders({} as Record<TicketStatus, string[]>);
      prevBoardOrderSprintKeyRef.current = '';
      return;
    }
    if (groupMode !== 'none') return;

    const sprintChanged = prevBoardOrderSprintKeyRef.current !== boardOrderSprintKey;
    prevBoardOrderSprintKeyRef.current = boardOrderSprintKey;

    let fromDisk: Partial<Record<TicketStatus, string[]>> = {};
    if (sprintChanged) {
      try {
        const raw = localStorage.getItem(`boardFlatOrder:${currentSpace.id}:${activeSprint.id}`);
        if (raw) fromDisk = JSON.parse(raw) as Partial<Record<TicketStatus, string[]>>;
      } catch {
        /* ignore */
      }
    }

    setColumnFlatOrders((prev) => {
      const next = { ...prev } as Record<TicketStatus, string[]>;
      for (const { status } of COLUMNS) {
        const roots = fullTicketsByStatus[status];
        const rootIds = roots.map((t) => t.id);
        const base = sprintChanged ? (fromDisk[status] ?? []) : (prev[status] ?? []);
        const baseRoots = base.filter((id) => rootIds.includes(id));
        next[status] = mergeSavedFlatOrder(baseRoots, rootIds);
      }
      return next;
    });
  }, [boardOrderSprintKey, activeSprint, currentSpace.id, fullTicketsByStatus, boardTickets, collapsedParents, hideSubtasksOnBoard, groupMode]);

  useEffect(() => {
    if (!activeSprint || groupMode !== 'none') return;
    if (Object.keys(columnFlatOrders).length === 0) return;
    try {
      localStorage.setItem(`boardFlatOrder:${currentSpace.id}:${activeSprint.id}`, JSON.stringify(columnFlatOrders));
    } catch {
      /* ignore */
    }
  }, [activeSprint?.id, currentSpace.id, columnFlatOrders, groupMode]);

  function openTicketModal(id: string) {
    setSearchParams({ ticket: id }, { replace: false });
  }

  function ticketHref(id: string): string {
    const next = new URLSearchParams(searchParams);
    next.set('ticket', id);
    return `?${next.toString()}`;
  }

  function closeTicketModal() {
    setSearchParams({}, { replace: false });
  }

  useEffect(() => {
    if (loading) return;
    const param = searchParams.get('ticket');
    // Epic progress links target epics that intentionally do not appear as
    // active-sprint board cards. Validate against the full space ticket list.
    if (param && !tickets.find((t) => t.id === param)) {
      setSearchParams({}, { replace: true });
    }
  }, [loading, searchParams, tickets, setSearchParams]);

  useEffect(() => {
    function onOutsideClick(e: MouseEvent) {
      const target = e.target as Node;
      if (groupMenuOpen && groupMenuRef.current && !groupMenuRef.current.contains(target)) {
        setGroupMenuOpen(false);
      }
      if (sprintDetailOpen && sprintDetailRef.current && !sprintDetailRef.current.contains(target)) {
        setSprintDetailOpen(false);
      }
      if (viewSettingsOpen && viewSettingsRef.current && !viewSettingsRef.current.contains(target)) {
        setViewSettingsOpen(false);
      }
    }
    document.addEventListener('mousedown', onOutsideClick);
    return () => document.removeEventListener('mousedown', onOutsideClick);
  }, [groupMenuOpen, sprintDetailOpen, viewSettingsOpen]);

  const groupLabelForTicket = useCallback((ticket: Ticket): string => {
    if (groupMode === 'assignee') return ticket.assignee ?? 'Unassigned';
    if (groupMode === 'epic') {
      const epicKey = resolveEpicKey(ticket, tickets);
      return epicKey ?? 'No epic';
    }
    if (groupMode === 'subtask') {
      const subCount = boardTickets.filter((t) => t.parentId === ticket.id && t.issueType === 'subtask').length;
      return subCount > 0 ? 'Has subtasks' : 'No subtasks';
    }
    return '';
  }, [groupMode, tickets, boardTickets]);

  const onDragEnd = useCallback((result: DropResult) => {
    if (!result.destination) return;
    const { source, destination, draggableId } = result;
    if (source.droppableId === destination.droppableId && source.index === destination.index) return;

    const srcCol = source.droppableId as TicketStatus;
    const destCol = destination.droppableId as TicketStatus;

    if (srcCol !== destCol) {
      const moving = boardTickets.find((t) => t.id === draggableId);
      const cascadeSubtasks = Boolean(
        moving &&
          moving.issueType !== 'subtask' &&
          collapsedParents.has(draggableId),
      );

      // Jira-style rank: changing status and placing the card are one action.
      // Without this, status changes first and reconciliation appends the new
      // card to the bottom of the destination column.
      if (groupMode === 'none' && activeSprint) {
        const sourceRootIds = orderRootsBySaved(
          fullTicketsByStatus[srcCol],
          columnFlatOrders[srcCol],
        )
          .map((ticket) => ticket.id)
          .filter((id) => id !== draggableId);
        const destinationRootIds = orderRootsBySaved(
          fullTicketsByStatus[destCol],
          columnFlatOrders[destCol],
        )
          .map((ticket) => ticket.id)
          .filter((id) => id !== draggableId);

        // destination.index belongs to the visible flat list. Resolve its
        // neighboring visible root cards, then insert between those neighbors
        // in the complete (possibly filtered) destination order.
        const visibleDestinationRoots = orderRootsBySaved(
          displayTicketsByStatus[destCol],
          columnFlatOrders[destCol],
        ).filter((ticket) => ticket.id !== draggableId);
        const visibleDestinationFlat = buildFlatDragItems(
          visibleDestinationRoots,
          filteredBoardTickets,
          collapsedParents,
          hideSubtasksOnBoard,
        );
        const visibleInsertIndex = countRootsBeforeFlatIndex(
          visibleDestinationFlat,
          destination.index,
        );
        const beforeId = visibleDestinationRoots[visibleInsertIndex - 1]?.id;
        const afterId = visibleDestinationRoots[visibleInsertIndex]?.id;

        let insertAt = destinationRootIds.length;
        if (beforeId) {
          const beforeIndex = destinationRootIds.indexOf(beforeId);
          if (beforeIndex >= 0) insertAt = beforeIndex + 1;
        } else if (afterId) {
          const afterIndex = destinationRootIds.indexOf(afterId);
          if (afterIndex >= 0) insertAt = afterIndex;
        } else if (destination.index === 0) {
          insertAt = 0;
        }
        destinationRootIds.splice(insertAt, 0, draggableId);

        setColumnFlatOrders((prev) => ({
          ...prev,
          [srcCol]: sourceRootIds,
          [destCol]: destinationRootIds,
        }));

        const rankUpdates = [
          ...sourceRootIds.map((ticketId, issueOrder) => ({ ticketId, issueOrder })),
          ...destinationRootIds.map((ticketId, issueOrder) => ({ ticketId, issueOrder })),
        ];
        updateTicketStatus(draggableId, destCol, { cascadeSubtasks, rankUpdates });
      } else {
        updateTicketStatus(draggableId, destCol, { cascadeSubtasks });
      }
      return;
    }

    if (groupMode !== 'none' || !activeSprint) return;
    if (assigneeFilter.length > 0) return;

    const roots = fullTicketsByStatus[srcCol];
    const orderedRoots = orderRootsBySaved(roots, columnFlatOrders[srcCol]);
    const flat = buildFlatDragItems(orderedRoots, boardTickets, collapsedParents, hideSubtasksOnBoard);
    const rootIds = orderedRoots.map((t) => t.id);
    const sourceRootIdx = rootIds.indexOf(draggableId);
    if (sourceRootIdx === -1) return;

    const destRootIdx = countRootsBeforeFlatIndex(flat, destination.index);
    const newRootIds = arrayMove(rootIds, sourceRootIdx, destRootIdx);
    setColumnFlatOrders((prev) => ({ ...prev, [srcCol]: newRootIds }));
    applyBacklogRank(newRootIds.map((ticketId, issueOrder) => ({ ticketId, issueOrder })));
  }, [updateTicketStatus, applyBacklogRank, groupMode, activeSprint, assigneeFilter, fullTicketsByStatus, displayTicketsByStatus, filteredBoardTickets, boardTickets, collapsedParents, hideSubtasksOnBoard, columnFlatOrders]);

  const handleCreateConfirm = useCallback((ticket: Ticket) => {
    addTicket(ticket);
    setModalStatus(null);
  }, [addTicket]);

  const handleTicketUpdate = useCallback(
    async (updated: Ticket) => {
      const saved = await updateTicket(updated);
      if (saved && sprintInsightsOpen) {
        setInsightsHistoryRefreshVersion((version) => version + 1);
      }
      return saved;
    },
    [sprintInsightsOpen, updateTicket],
  );

  const handleCreateSubtask = useCallback((parentId: string, title: string) => {
    createSubtask(parentId, title);
  }, [createSubtask]);

  const handleCompleteSprint = useCallback(() => {
    const active = sprints.find((s) => s.status === 'active');
    if (!active) {
      alert('No active sprint to complete. Start a sprint from Backlog first.');
      return;
    }
    setCompleteSprintOpen(true);
  }, [sprints]);

  const futureSprintsForComplete = useMemo(
    () => sprints.filter((s) => s.status === 'future'),
    [sprints],
  );

  return (
    <>
      {modalStatus !== null && (
        <CreateTaskModal
          initialStatus={modalStatus}
          nextId={nextId}
          allowedIssueTypes={['story', 'task', 'bug']}
          sprintId={activeSprint?.id}
          sprintName={activeSprint?.name}
          onConfirm={handleCreateConfirm}
          onClose={() => setModalStatus(null)}
        />
      )}

      {completeSprintOpen && activeSprint && (
        <CompleteSprintModal
          sprint={activeSprint}
          tickets={tickets}
          futureSprints={futureSprintsForComplete}
          onConfirm={(options) => {
            completeSprint(activeSprint.id, options);
            setCompleteSprintOpen(false);
          }}
          onClose={() => setCompleteSprintOpen(false)}
        />
      )}
      {selectedTicket !== null && (
        <TicketDetailModal
          ticket={selectedTicket}
          allTickets={tickets}
          sprints={sprints}
          onUpdate={handleTicketUpdate}
          onCreateSubtask={handleCreateSubtask}
          onDeleteTicket={deleteTicket}
          onAddComment={addComment}
          onEditComment={editComment}
          onDeleteComment={deleteComment}
          onAddIssueLink={addIssueLink}
          onDeleteIssueLink={deleteIssueLink}
          onAddCodeLink={addCodeLink}
          onDeleteCodeLink={deleteCodeLink}
          onRefreshCodeLinks={refreshCodeLinks}
          currentUserId={Number(currentUser.id)}
          onOpenTicket={(id) => openTicketModal(id)}
          onClose={closeTicketModal}
        />
      )}
      <div className={`board-page ${sprintInsightsOpen ? 'board-page--insights-open' : ''}`}>
        <div className="board-toolbar">
          <input
            type="search"
            placeholder="Search board"
            className="board-toolbar__search"
            aria-label="Search board"
            value={boardSearch}
            onChange={(e) => setBoardSearch(e.target.value)}
          />
          <BoardAssigneeFilter
            sortedNames={boardAssigneeNames.sortedNames}
            anyUnassigned={boardAssigneeNames.anyUnassigned}
            assigneeFilter={assigneeFilter}
            onAssigneeFilterChange={setAssigneeFilter}
          />
          <IssueFilterPanel
            tickets={tickets}
            filters={issueFilters}
            onChange={setIssueFilters}
            hideAssignee
            triggerClassName="board-toolbar__filter"
          />
          <label className="board-toolbar__hide-subtasks">
            <input
              type="checkbox"
              checked={hideSubtasksOnBoard}
              onChange={(e) => setHideSubtasksOnBoard(e.target.checked)}
            />
            <span>Hide subtasks on board</span>
          </label>
          <div className="board-toolbar__right">
            <button type="button" className="board-toolbar__complete" onClick={handleCompleteSprint}>Complete sprint</button>
            <div className="board-toolbar__sprint-detail-wrap" ref={sprintDetailRef}>
              <span className="hover-tip-host">
                <button
                  type="button"
                  className="board-toolbar__icon"
                  aria-label="Sprint details"
                  aria-expanded={sprintDetailOpen}
                  onClick={() => setSprintDetailOpen((v) => !v)}
                >
                  <IconSprintDetails />
                </button>
                <span className="hover-tip__popup" role="tooltip">
                  Sprint details
                </span>
              </span>
              {sprintDetailOpen && (
                <div className="board-sprint-detail" role="dialog" aria-label="Current sprint details">
                  {activeSprint ? (
                    <>
                      <p className="board-sprint-detail__name">{activeSprint.name}</p>
                      <p className="board-sprint-detail__remaining">{sprintTimeLabel(activeSprint.endDate)}</p>
                      <div className="board-sprint-detail__dates">
                        <div>
                          <span>Start date</span>
                          <strong>{formatSprintDate(activeSprint.startDate)}</strong>
                        </div>
                        <div>
                          <span>End date</span>
                          <strong>{formatSprintDate(activeSprint.endDate)}</strong>
                        </div>
                      </div>
                    </>
                  ) : (
                    <p className="board-sprint-detail__empty">No active sprint.</p>
                  )}
                </div>
              )}
            </div>
            <div className="board-toolbar__group-wrap" ref={groupMenuRef}>
              <button
                type="button"
                className={`board-toolbar__group ${groupMode !== 'none' ? 'is-active' : ''}`}
                onClick={() => setGroupMenuOpen((v) => !v)}
                aria-expanded={groupMenuOpen}
                aria-label={`Group board by: ${GROUP_MODE_LABELS[groupMode]}`}
              >
                <span>Group: {GROUP_MODE_LABELS[groupMode]}</span>
                <span className="board-toolbar__group-chevron" aria-hidden>▾</span>
              </button>
              {groupMenuOpen && (
                <div className="board-toolbar__group-menu">
                  <button type="button" className={`board-toolbar__group-item ${groupMode === 'none' ? 'is-active' : ''}`} onClick={() => { setGroupMode('none'); setGroupMenuOpen(false); }}>None</button>
                  <button type="button" className={`board-toolbar__group-item ${groupMode === 'assignee' ? 'is-active' : ''}`} onClick={() => { setGroupMode('assignee'); setGroupMenuOpen(false); }}>Assignee</button>
                  <button type="button" className={`board-toolbar__group-item ${groupMode === 'epic' ? 'is-active' : ''}`} onClick={() => { setGroupMode('epic'); setGroupMenuOpen(false); }}>Epic</button>
                  <button type="button" className={`board-toolbar__group-item ${groupMode === 'subtask' ? 'is-active' : ''}`} onClick={() => { setGroupMode('subtask'); setGroupMenuOpen(false); }}>Subtask</button>
                </div>
              )}
            </div>
            <span className="hover-tip-host">
              <button
                type="button"
                className={`board-toolbar__icon ${sprintInsightsOpen ? 'board-toolbar__icon--active' : ''}`}
                aria-label="Sprint insights"
                onClick={() => setSprintInsightsOpen((v) => !v)}
              >
                <IconSprintInsights />
              </button>
              <span className="hover-tip__popup" role="tooltip">
                Sprint insights
              </span>
            </span>
            <div className="board-toolbar__view-settings-wrap" ref={viewSettingsRef}>
              <span className="hover-tip-host">
                <button
                  type="button"
                  className={`board-toolbar__icon ${viewSettingsOpen ? 'board-toolbar__icon--active' : ''}`}
                  aria-label="View settings"
                  onClick={() => setViewSettingsOpen((v) => !v)}
                >
                  <IconViewSettings />
                </button>
                <span className="hover-tip__popup" role="tooltip">
                  View settings
                </span>
              </span>
              {viewSettingsOpen && (
                <div className="board-view-settings">
                  <div className="board-view-settings__header">
                    <h4>View settings</h4>
                    <button type="button" onClick={() => setViewSettingsOpen(false)}>✕</button>
                  </div>
                  <label className="board-view-settings__item">
                    <span>Show issue key</span>
                    <input type="checkbox" checked={viewSettings.showIssueKey} onChange={(e) => setViewSettings((p) => ({ ...p, showIssueKey: e.target.checked }))} />
                  </label>
                  <label className="board-view-settings__item">
                    <span>Show due date</span>
                    <input type="checkbox" checked={viewSettings.showDueDate} onChange={(e) => setViewSettings((p) => ({ ...p, showDueDate: e.target.checked }))} />
                  </label>
                  <label className="board-view-settings__item">
                    <span>Show epic</span>
                    <input type="checkbox" checked={viewSettings.showEpic} onChange={(e) => setViewSettings((p) => ({ ...p, showEpic: e.target.checked }))} />
                  </label>
                  <label className="board-view-settings__item">
                    <span>Show assignee</span>
                    <input type="checkbox" checked={viewSettings.showAssignee} onChange={(e) => setViewSettings((p) => ({ ...p, showAssignee: e.target.checked }))} />
                  </label>
                  <label className="board-view-settings__item">
                    <span>Show work type</span>
                    <input type="checkbox" checked={viewSettings.showWorkType} onChange={(e) => setViewSettings((p) => ({ ...p, showWorkType: e.target.checked }))} />
                  </label>
                  <label className="board-view-settings__item">
                    <span>Show priority</span>
                    <input type="checkbox" checked={viewSettings.showPriority} onChange={(e) => setViewSettings((p) => ({ ...p, showPriority: e.target.checked }))} />
                  </label>
                  <label className="board-view-settings__item">
                    <span>Show labels</span>
                    <input type="checkbox" checked={viewSettings.showLabels} onChange={(e) => setViewSettings((p) => ({ ...p, showLabels: e.target.checked }))} />
                  </label>
                  <label className="board-view-settings__item">
                    <span>Show story points</span>
                    <input type="checkbox" checked={viewSettings.showStoryPoints} onChange={(e) => setViewSettings((p) => ({ ...p, showStoryPoints: e.target.checked }))} />
                  </label>
                  <label className="board-view-settings__item">
                    <span>Hide subtasks on board</span>
                    <input type="checkbox" checked={hideSubtasksOnBoard} onChange={(e) => setHideSubtasksOnBoard(e.target.checked)} />
                  </label>
                </div>
              )}
            </div>
          </div>
        </div>
        <DragDropContext onDragEnd={onDragEnd}>
          <div className="board">
          {COLUMNS.map(({ status, title, isDone }) => (
            <BoardColumn
              key={status}
              droppableId={status}
              title={title}
              tickets={displayTicketsByStatus[status]}
              allTickets={filteredBoardTickets}
              epicLookupTickets={tickets}
              collapsedParents={collapsedParents}
              onToggleParentFold={toggleParentFold}
              hideSubtasksOnBoard={hideSubtasksOnBoard}
              viewSettings={viewSettings}
              groupMode={groupMode}
              getGroupLabel={groupLabelForTicket}
              isDone={isDone}
              onCreateClick={() => setModalStatus(status)}
              onTicketClick={(id) => openTicketModal(id)}
              savedFlatOrder={groupMode === 'none' ? columnFlatOrders[status] : undefined}
            />
          ))}
        </div>
        {!activeSprint && (
          <p className="board-page__hint">
            No active sprint. Start a sprint in Backlog to show issues on this board.
          </p>
        )}
        </DragDropContext>
        {sprintInsightsOpen && (
          <aside className="board-insights">
            <div className="board-insights__header">
              <div>
                <h3 className="board-insights__title">Sprint insights</h3>
                <p className="board-insights__subtitle">View your sprint health and progress towards goals.</p>
              </div>
              <button type="button" className="board-insights__close" onClick={() => setSprintInsightsOpen(false)}>✕</button>
            </div>
            <p className="board-insights__sprint">
              Sprint: <strong>{activeSprint?.name ?? 'No active sprint'}</strong>
            </p>
            <section className="board-insights__card board-insights__card--attention">
              <div className="board-insights__attention-header">
                <h4>Work items for attention</h4>
              </div>
              <div className="board-insights__tabs">
                {(['all', 'due', 'stuck', 'blocked', 'flagged'] as InsightAttentionTab[]).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    className={`board-insights__tab ${attentionTab === tab ? 'is-active' : ''}`}
                    onClick={() => {
                      setAttentionTab(tab);
                      setAttentionPage(0);
                    }}
                  >
                    {ATTENTION_TAB_LABELS[tab]}
                  </button>
                ))}
              </div>
              <p className="board-insights__note">
                {ATTENTION_DESCRIPTIONS[attentionTab](attentionIssues.length)}
                {stuckAnalysisLoading && (attentionTab === 'all' || attentionTab === 'stuck') && (
                  <span className="board-insights__analysis-loading"> Analyzing status history…</span>
                )}
              </p>
              <div className="board-insights__list">
                {attentionIssues.length === 0 && <p className="board-insights__empty">No items.</p>}
                {pagedAttentionIssues.map((t) => {
                  const isDue = isDueForAttention(t);
                  const isStuck = stuckAnalysis.issueIds.has(t.id);
                  const isBlocked = blockedIssueIds.has(t.id);
                  const isFlagged = t.flagged === true;
                  const typeMeta = ISSUE_TYPE_META[t.issueType ?? 'task'];
                  const assignee = t.assignees?.[0] ?? t.assignee;
                  return (
                  <button
                    key={t.id}
                    type="button"
                    className="board-insights__item"
                    onClick={() => openTicketModal(t.id)}
                    aria-label={`Open issue ${t.id} ${t.title}`}
                  >
                    <span className="board-insights__item-body">
                      <span className="board-insights__item-status">
                        <span className="board-insights__item-type" style={{ color: typeMeta.color }} aria-hidden>{typeMeta.icon}</span>
                        {attentionStatusLabel(t.status)}
                      </span>
                      <span className="board-insights__item-title">{t.title}</span>
                      <span className="board-insights__item-footer">
                        <span className="board-insights__reasons">
                          {isDue && (attentionTab === 'all' || attentionTab === 'due') && (
                            <span className="board-insights__reason board-insights__reason--due" title={formatDueDateWithTime(t.dueDate)}>
                              <span aria-hidden>▣</span> Due on {formatDueDateWithTime(t.dueDate)}
                            </span>
                          )}
                          {isStuck && (attentionTab === 'all' || attentionTab === 'stuck') && (
                            <span className="board-insights__reason board-insights__reason--stuck">
                              <span aria-hidden>◷</span> {stuckDurationLabel(stuckAnalysis.currentDurationByIssue.get(t.id))}
                            </span>
                          )}
                          {isBlocked && (attentionTab === 'all' || attentionTab === 'blocked') && (
                            <span className="board-insights__reason board-insights__reason--blocked">
                              <span aria-hidden>＝</span> {blockedAttentionLabel(t, tickets)}
                            </span>
                          )}
                          {isFlagged && (attentionTab === 'all' || attentionTab === 'flagged') && (
                            <span className="board-insights__reason board-insights__reason--flagged">
                              <span aria-hidden>⚑</span> Flagged
                            </span>
                          )}
                        </span>
                        {assignee && <AssigneeAvatar name={assignee} size="card" className="board-insights__assignee" />}
                      </span>
                    </span>
                  </button>
                  );
                })}
              </div>
              {attentionIssues.length > 0 && (
                <nav className="board-insights__pagination" aria-label="Work items for attention pages">
                  <button
                    type="button"
                    className="board-insights__page-button"
                    disabled={attentionPage === 0}
                    onClick={() => setAttentionPage((page) => Math.max(0, page - 1))}
                  >
                    Prev
                  </button>
                  <span className="board-insights__page-dots" aria-label={`Page ${attentionPage + 1} of ${attentionPageCount}`}>
                    {Array.from({ length: attentionPageCount }, (_, page) => (
                      <button
                        key={page}
                        type="button"
                        className={`board-insights__page-dot ${page === attentionPage ? 'is-active' : ''}`}
                        aria-label={`Go to page ${page + 1}`}
                        aria-current={page === attentionPage ? 'page' : undefined}
                        onClick={() => setAttentionPage(page)}
                      />
                    ))}
                  </span>
                  <button
                    type="button"
                    className="board-insights__page-button"
                    disabled={attentionPage >= attentionPageCount - 1}
                    onClick={() => setAttentionPage((page) => Math.min(attentionPageCount - 1, page + 1))}
                  >
                    Next
                  </button>
                </nav>
              )}
            </section>
            <section className="board-insights__card board-insights__card--progress">
              <div className="board-insights__progress-header">
                <h4>Sprint progress</h4>
                <span className="board-insights__progress-actions">
                  <button
                    type="button"
                    className={`board-insights__collapse ${sprintProgressExpanded ? 'is-expanded' : ''}`}
                    aria-label={sprintProgressExpanded ? 'Collapse sprint progress' : 'Expand sprint progress'}
                    aria-expanded={sprintProgressExpanded}
                    onClick={() => setSprintProgressExpanded((expanded) => !expanded)}
                  >
                    ⌄
                  </button>
                </span>
              </div>
              {sprintProgressExpanded && (
                <div className="board-insights__progress-content">
                  <div className="board-insights__progress-summary">
                    <div
                      className="board-insights__progress-bar"
                      role="img"
                      aria-label={`${sprintProgress.donePercent}% done, ${sprintProgress.inProgressPercent}% in progress, ${sprintProgress.notStartedPercent}% not started`}
                    >
                      <span className="board-insights__progress-segment board-insights__progress-segment--done" style={{ width: `${sprintProgress.donePercent}%` }} />
                      <span className="board-insights__progress-segment board-insights__progress-segment--in-progress" style={{ width: `${sprintProgress.inProgressPercent}%` }} />
                      <span className="board-insights__progress-segment board-insights__progress-segment--not-started" style={{ width: `${sprintProgress.notStartedPercent}%` }} />
                    </div>
                    <strong className="board-insights__progress-done">{sprintProgress.donePercent}% done</strong>
                  </div>
                  <div className="board-insights__progress-stats">
                    <div>
                      <span>Done</span>
                      <strong className="board-insights__progress-value--done">{sprintProgress.donePercent}%</strong>
                    </div>
                    <div>
                      <span>In progress</span>
                      <strong>{sprintProgress.inProgressPercent}%</strong>
                    </div>
                    <div>
                      <span>Not started</span>
                      <strong>{sprintProgress.notStartedPercent}%</strong>
                    </div>
                  </div>
                </div>
              )}
            </section>
            <section className="board-insights__card">
              <h4>Sprint burndown</h4>
              <p className="board-insights__metric">{burndownPoints.done} points done, {burndownPoints.toGo} points to go</p>
            </section>
            <section className="board-insights__card board-insights__card--epic-progress">
              <div className="board-insights__epic-header">
                <h4>Epic progress</h4>
                <button
                  type="button"
                  className={`board-insights__collapse ${epicProgressExpanded ? 'is-expanded' : ''}`}
                  aria-label={epicProgressExpanded ? 'Collapse epic progress' : 'Expand epic progress'}
                  aria-expanded={epicProgressExpanded}
                  onClick={() => setEpicProgressExpanded((expanded) => !expanded)}
                >
                  ⌄
                </button>
              </div>
              {epicProgressExpanded && (
                <div className="board-insights__epic-content">
                  <p className="board-insights__epic-summary">
                    This sprint is working towards <strong>{epicProgress.length} epic{epicProgress.length === 1 ? '' : 's'}</strong>
                  </p>
                  {epicProgress.length === 0 ? (
                    <p className="board-insights__empty">No work items in this sprint are linked to an epic.</p>
                  ) : (
                    <div className="board-insights__epic-list">
                      {epicProgress.map((epic) => (
                        <div key={epic.epicKey} className="board-insights__epic-item">
                          <div className="board-insights__epic-row">
                            <Link
                              className="board-insights__epic-link"
                              to={ticketHref(epic.epicKey)}
                              title={`Open epic ${epic.epicKey}`}
                            >
                              {epic.epicKey} {epic.title}
                            </Link>
                            <span>{epic.percentDone}% done</span>
                          </div>
                          <div
                            className="board-insights__epic-bar"
                            role="img"
                            aria-label={`${epic.epicKey} is ${epic.percentDone}% done`}
                          >
                            <span style={{ width: `${epic.percentDone}%` }} />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </section>
          </aside>
        )}
      </div>
    </>
  );
}
