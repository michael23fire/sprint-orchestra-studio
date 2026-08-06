import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Link, useSearchParams } from 'react-router-dom';
import { DragDropContext, Droppable, Draggable, type DropResult } from '@hello-pangea/dnd';
import { TicketDetailModal } from '../components/TicketDetailModal';
import type { IssueType, Ticket, TicketStatus } from '../types/ticket';
import { labelColor, labelsForIssueType } from '../types/ticket';
import type { Sprint, SprintStatus, SprintReorderAction } from '../types/sprint';
import { BoardAssigneeFilter } from '../components/BoardAssigneeFilter';
import { CompleteSprintModal } from '../components/CompleteSprintModal';
import { PlanEpicModal } from '../components/PlanEpicModal';
import { RolloutModal } from '../components/RolloutModal';
import { SprintRecoveryModal } from '../components/SprintRecoveryModal';
import { SprintHealthModal } from '../components/SprintHealthModal';
import { IssueFilterPanel } from '../components/IssueFilterPanel';
import { useCurrentUser } from '../context/UserContext';
import { useSpaces } from '../context/SpaceContext';
import { effectiveSpaceMemberIds } from '../types/space';
import { useTickets } from '../context/TicketContext';
import { BOARD_ASSIGNEE_FILTER_UNASSIGNED, collectToolbarAssigneeNames, ticketMatchesAssigneeFilter } from '../utils/assigneeDisplay';
import {
  activeSprintInSpace,
  findOverlappingSprint,
  validateSprintDates,
} from '../utils/sprintConstraints';
import {
  EMPTY_ISSUE_FILTERS,
  hasActiveIssueFilters,
  type IssueFilters,
  ticketMatchesIssueFilters,
  withMatchedParents,
} from '../utils/issueFilters';
import { getDirectChildren, isSubtask } from '../utils/ticketHierarchy';
import './Backlog.css';

/** Jira-style: epics are never sprint-scoped in the UI; they always bucket with backlog. */
function displayBucketKey(t: Ticket): string {
  if (t.issueType === 'epic') return 'backlog';
  return t.sprintId ?? 'backlog';
}

/**
 * Which issues get a top-level row in a sprint/backlog list (matches Board: parent cards are non-subtasks).
 * Subtasks nest under a parent in the *same* bucket; if the parent is in another bucket, the subtask is shown as a root.
 * Non-subtasks always get a row, including stories/tasks that sit under an epic (parentId → epic) — they are no longer
 * "orphaned" from the list when the epic is in the same sprint.
 */
function isBacklogRootRow(t: Ticket, allInSpace: Ticket[]): boolean {
  const k = displayBucketKey(t);
  if (isSubtask(t)) {
    if (!t.parentId) return true;
    const parent = allInSpace.find((p) => p.id === t.parentId);
    if (!parent) return true;
    return displayBucketKey(parent) !== k;
  }
  return true;
}

/** Rank roots: lower issueOrder first; stable by issue key. */
function sortRootTicketsByOrder(roots: Ticket[]): Ticket[] {
  return [...roots].sort((a, b) => {
    const ao = a.issueOrder ?? 0;
    const bo = b.issueOrder ?? 0;
    if (ao !== bo) return ao - bo;
    return a.id.localeCompare(b.id);
  });
}

/** Epics first in the pure backlog bucket, then by rank. */
function sortBacklogRootTickets(roots: Ticket[]): Ticket[] {
  return [...roots].sort((a, b) => {
    const aEp = a.issueType === 'epic' ? 1 : 0;
    const bEp = b.issueType === 'epic' ? 1 : 0;
    if (aEp !== bEp) return bEp - aEp;
    const ao = a.issueOrder ?? 0;
    const bo = b.issueOrder ?? 0;
    if (ao !== bo) return ao - bo;
    return a.id.localeCompare(b.id);
  });
}

/* ─── Constants ─── */

const STATUS_COLORS: Record<TicketStatus, string> = {
  planned:     '#8b5cf6',
  in_progress: '#3b82f6',
  blocked:     '#ef4444',
  in_review:   '#f59e0b',
  done:        '#10b981',
};

const STATUS_LABELS: Record<TicketStatus, string> = {
  planned:     'Planned',
  in_progress: 'In Progress',
  blocked:     'Blocked',
  in_review:   'In Review',
  done:        'Done',
};

/* ─── Small sub-components ─── */

function IssueTypeIcon({ issueType = 'task' }: { issueType?: IssueType }) {
  const MAP: Record<IssueType, { char: string; bg: string; label: string }> = {
    bug:     { char: 'B', bg: '#ef4444', label: 'Bug' },
    story:   { char: 'S', bg: '#10b981', label: 'Story' },
    epic:    { char: 'E', bg: '#6366f1', label: 'Epic' },
    task:    { char: 'T', bg: '#3b82f6', label: 'Task' },
    subtask: { char: '◦', bg: '#64748b', label: 'Subtask' },
  };
  const icon = MAP[issueType];
  return (
    <span className="bl-row__type" style={{ background: icon.bg }} title={icon.label}>
      {icon.char}
    </span>
  );
}

function Avatar({ name }: { name: string }) {
  return <span className="bl-row__avatar" title={name}>{name.charAt(0).toUpperCase()}</span>;
}

/* ─── Ticket row ─── */

interface TicketRowProps {
  ticket: Ticket;
  onClick: () => void;
  nested?: boolean;
  /** Show fold control (root rows with subtasks). */
  foldable?: boolean;
  subtasksExpanded?: boolean;
  onToggleFold?: () => void;
}

function TicketRow({ ticket, onClick, nested, foldable, subtasksExpanded, onToggleFold }: TicketRowProps) {
  const statusColor = STATUS_COLORS[ticket.status];
  const assignees = ticket.assignees ?? (ticket.assignee ? [ticket.assignee] : []);
  const displayLabels = labelsForIssueType(ticket.issueType, ticket.labels);

  /**
   * Real <a> (via Link) so right-click / Cmd-click / middle-click give the browser's
   * native "open in new tab". Only intercept plain-left-clicks to keep the existing
   * in-app modal behavior; everything else is left to the browser.
   */
  function handleLinkClick(e: React.MouseEvent) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onClick();
  }

  return (
    <Link
      to={`/ticket/${ticket.id}`}
      className={`bl-row ${nested ? 'bl-row--nested' : ''}`}
      onClick={handleLinkClick}
    >
      {!nested && foldable && onToggleFold ? (
        <button
          type="button"
          className="bl-row__fold"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onToggleFold();
          }}
          aria-expanded={subtasksExpanded}
          aria-label={subtasksExpanded ? 'Collapse subtasks' : 'Expand subtasks'}
        >
          <span
            className={`bl-row__fold-icon ${subtasksExpanded ? 'bl-row__fold-icon--open' : ''}`}
            aria-hidden
          >
            ▶
          </span>
        </button>
      ) : (
        <span className="bl-row__fold-spacer" aria-hidden />
      )}
      <span className="bl-row__drag" aria-hidden>⠿</span>
      <IssueTypeIcon issueType={ticket.issueType} />
      <span className="bl-row__id">{ticket.id}</span>
      <span className="bl-row__title">{ticket.title}</span>
      <span className="bl-row__labels">
        {displayLabels.slice(0, 2).map((l) => (
          <span key={l} className="bl-row__label" style={{ background: labelColor(l).bg, color: labelColor(l).text }}>{l}</span>
        ))}
        {displayLabels.length > 2 && (
          <span className="bl-row__label bl-row__label--more" title={displayLabels.slice(2).join(', ')}>
            +{displayLabels.length - 2}
          </span>
        )}
      </span>
      <span
        className="bl-row__status"
        style={{ background: statusColor + '18', color: statusColor, borderColor: statusColor + '55' }}
      >
        {STATUS_LABELS[ticket.status]}
      </span>
      <span className="bl-row__assignees">
        {assignees.length > 0 ? assignees.map((a) => <Avatar key={a} name={a} />) : <span className="bl-row__unassigned">—</span>}
      </span>
      <span className="bl-row__points">{ticket.storyPoints ?? <span style={{ opacity: 0.3 }}>—</span>}</span>
    </Link>
  );
}

function TicketRowWithSubtasks({
  root,
  allTickets,
  onTicketClick,
  collapsedParents,
  onToggleParentFold,
}: {
  root: Ticket;
  allTickets: Ticket[];
  onTicketClick: (id: string) => void;
  collapsedParents: Set<string>;
  onToggleParentFold: (issueKey: string) => void;
}) {
  const children = getDirectChildren(root.id, allTickets);
  const collapsed = collapsedParents.has(root.id);
  const expanded = !collapsed;
  return (
    <>
      <TicketRow
        ticket={root}
        onClick={() => onTicketClick(root.id)}
        foldable={children.length > 0}
        subtasksExpanded={expanded}
        onToggleFold={children.length > 0 ? () => onToggleParentFold(root.id) : undefined}
      />
      {expanded &&
        children.map((c) => (
          <TicketRow key={c.id} ticket={c} nested onClick={() => onTicketClick(c.id)} />
        ))}
    </>
  );
}

/* ─── Inline create row ─── */

interface InlineCreateProps {
  onSave: (title: string, storyPoints?: number) => void;
  onCancel: () => void;
  requirePoints?: boolean;
}

function InlineCreate({ onSave, onCancel, requirePoints = false }: InlineCreateProps) {
  const [value, setValue] = useState('');
  const [points, setPoints] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);

  function handleSave() {
    const parsedPoints = Number(points);
    if (value.trim() && (!requirePoints || (Number.isFinite(parsedPoints) && parsedPoints > 0))) {
      onSave(value.trim(), requirePoints ? parsedPoints : undefined);
    }
  }

  return (
    <div className="bl-inline-create">
      <input
        ref={ref}
        className="bl-inline-create__input"
        placeholder="What needs to be done?"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleSave();
          if (e.key === 'Escape') onCancel();
        }}
      />
      {requirePoints && (
        <input
          className="bl-inline-create__points"
          type="number"
          min="1"
          step="1"
          placeholder="Points"
          aria-label="Story points"
          value={points}
          onChange={(event) => setPoints(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') handleSave();
            if (event.key === 'Escape') onCancel();
          }}
        />
      )}
      <button
        type="button"
        className="bl-btn bl-btn--primary"
        onClick={handleSave}
        disabled={!value.trim() || (requirePoints && !(Number(points) > 0))}
      >
        Create
      </button>
      <button type="button" className="bl-btn bl-btn--ghost" onClick={onCancel}>Cancel</button>
    </div>
  );
}

/* ─── Start Sprint Modal ─── */

interface StartSprintModalProps {
  sprint: Sprint;
  tickets: Ticket[];
  allSprints: Sprint[];
  onConfirm: (updates: Pick<Sprint, 'startDate' | 'endDate' | 'goal'>) => void;
  onClose: () => void;
}

function StartSprintModal({ sprint, tickets, allSprints, onConfirm, onClose }: StartSprintModalProps) {
  const toLocalIsoDate = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = toLocalIsoDate(new Date());
  const twoWeeksDate = new Date();
  twoWeeksDate.setDate(twoWeeksDate.getDate() + 14);
  const twoWeeks = toLocalIsoDate(twoWeeksDate);
  const [startDate, setStartDate] = useState(sprint.startDate || today);
  const [endDate, setEndDate] = useState(sprint.endDate || twoWeeks);
  const [goal, setGoal] = useState(sprint.goal ?? '');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  function handleStart() {
    const missingPoints = tickets.filter((ticket) =>
      ticket.issueType !== 'epic'
      && ticket.issueType !== 'subtask'
      && !(ticket.storyPoints != null && ticket.storyPoints > 0));
    if (missingPoints.length > 0) {
      setError(`Add story points before starting: ${missingPoints.map((ticket) => ticket.id).join(', ')}`);
      return;
    }
    const dateErr = validateSprintDates(startDate, endDate);
    if (dateErr) { setError(dateErr); return; }
    const active = activeSprintInSpace(allSprints, sprint.id);
    if (active) {
      setError(`There can only be one active sprint. Complete "${active.name}" first.`);
      return;
    }
    const overlap = findOverlappingSprint(allSprints, startDate, endDate, sprint.id);
    if (overlap) {
      setError(`Dates overlap with "${overlap.name}" (${overlap.startDate} – ${overlap.endDate}).`);
      return;
    }
    onConfirm({ startDate, endDate, goal: goal || undefined });
  }

  return (
    <div className="bl-overlay" onMouseDown={onClose}>
      <div className="bl-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="bl-modal__header">
          <h2 className="bl-modal__title">Start {sprint.name}</h2>
          <button type="button" className="bl-modal__close" onClick={onClose}>✕</button>
        </div>
        <div className="bl-modal__body">
          <div className="bl-modal__field">
            <label className="bl-modal__label">Sprint goal</label>
            <input className="bl-modal__input" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="What's the goal of this sprint?" />
          </div>
          <div className="bl-modal__row">
            <div className="bl-modal__field">
              <label className="bl-modal__label">Start date</label>
              <input className="bl-modal__input" type="date" value={startDate} onChange={(e) => { setStartDate(e.target.value); setError(null); }} />
            </div>
            <div className="bl-modal__field">
              <label className="bl-modal__label">End date</label>
              <input className="bl-modal__input" type="date" value={endDate} onChange={(e) => { setEndDate(e.target.value); setError(null); }} />
            </div>
          </div>
          {error && <p className="bl-modal__error">{error}</p>}
        </div>
        <div className="bl-modal__footer">
          <button type="button" className="bl-btn bl-btn--ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="bl-btn bl-btn--primary" onClick={handleStart}>
            Start sprint
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Edit Sprint Modal ─── */

interface EditSprintModalProps {
  sprint: Sprint;
  allSprints: Sprint[];
  onConfirm: (updates: Partial<Pick<Sprint, 'name' | 'goal' | 'startDate' | 'endDate'>>) => void;
  onClose: () => void;
}

function EditSprintModal({ sprint, allSprints, onConfirm, onClose }: EditSprintModalProps) {
  const [name, setName] = useState(sprint.name);
  const [goal, setGoal] = useState(sprint.goal ?? '');
  const [startDate, setStartDate] = useState(sprint.startDate ?? '');
  const [endDate, setEndDate] = useState(sprint.endDate ?? '');
  const [error, setError] = useState<string | null>(null);
  const datesDisabled = sprint.status === 'completed';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  function handleSave() {
    if (!name.trim()) return;
    if (!datesDisabled && (startDate || endDate)) {
      const dateErr = validateSprintDates(startDate, endDate);
      if (dateErr) { setError(dateErr); return; }
      const overlap = findOverlappingSprint(allSprints, startDate, endDate, sprint.id);
      if (overlap) {
        setError(`Dates overlap with "${overlap.name}" (${overlap.startDate} – ${overlap.endDate}).`);
        return;
      }
    }
    onConfirm({
      name: name.trim(),
      goal: goal || undefined,
      ...(datesDisabled ? {} : { startDate, endDate }),
    });
  }

  return (
    <div className="bl-overlay" onMouseDown={onClose}>
      <div className="bl-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="bl-modal__header">
          <h2 className="bl-modal__title">Edit sprint</h2>
          <button type="button" className="bl-modal__close" onClick={onClose}>✕</button>
        </div>
        <div className="bl-modal__body">
          <div className="bl-modal__field">
            <label className="bl-modal__label">Sprint name</label>
            <input
              className="bl-modal__input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Sprint name"
              autoFocus
            />
          </div>
          <div className="bl-modal__field">
            <label className="bl-modal__label">Sprint goal</label>
            <input className="bl-modal__input" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="What's the goal of this sprint?" />
          </div>
          <div className="bl-modal__row">
            <div className="bl-modal__field">
              <label className="bl-modal__label">Start date</label>
              <input
                className="bl-modal__input"
                type="date"
                value={startDate}
                onChange={(e) => { setStartDate(e.target.value); setError(null); }}
                disabled={datesDisabled}
              />
            </div>
            <div className="bl-modal__field">
              <label className="bl-modal__label">End date</label>
              <input
                className="bl-modal__input"
                type="date"
                value={endDate}
                onChange={(e) => { setEndDate(e.target.value); setError(null); }}
                disabled={datesDisabled}
              />
            </div>
          </div>
          {error && <p className="bl-modal__error">{error}</p>}
        </div>
        <div className="bl-modal__footer">
          <button type="button" className="bl-btn bl-btn--ghost" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="bl-btn bl-btn--primary"
            onClick={handleSave}
            disabled={!name.trim()}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Sprint more menu (⋯) ─── */

interface SprintMoreMenuProps {
  onEditSprint: () => void;
  onDeleteSprint: () => void;
  /** Future sprints only: Jira-style reorder among planned sprints. */
  onReorderSprint?: (action: SprintReorderAction) => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
}

function SprintMoreMenu({
  onEditSprint,
  onDeleteSprint,
  onReorderSprint,
  canMoveUp,
  canMoveDown,
}: SprintMoreMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onOutside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onOutside);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="bl-sprint-more" ref={ref}>
      <button
        type="button"
        className="bl-btn bl-btn--outline bl-btn--sm bl-sprint-more__btn"
        onClick={() => setOpen((v) => !v)}
        aria-label="More sprint actions"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        ⋯
      </button>
      {open && (
        <div className="bl-sprint-more__menu" role="menu">
          {onReorderSprint && (
            <>
              <button
                type="button"
                className="bl-sprint-more__item"
                role="menuitem"
                disabled={!canMoveUp}
                onClick={() => { setOpen(false); onReorderSprint('move_up'); }}
              >
                Move sprint up
              </button>
              <button
                type="button"
                className="bl-sprint-more__item"
                role="menuitem"
                disabled={!canMoveDown}
                onClick={() => { setOpen(false); onReorderSprint('move_down'); }}
              >
                Move sprint down
              </button>
              <button
                type="button"
                className="bl-sprint-more__item"
                role="menuitem"
                disabled={!canMoveUp}
                onClick={() => { setOpen(false); onReorderSprint('move_to_top'); }}
              >
                Move sprint to top
              </button>
              <button
                type="button"
                className="bl-sprint-more__item"
                role="menuitem"
                disabled={!canMoveDown}
                onClick={() => { setOpen(false); onReorderSprint('move_to_bottom'); }}
              >
                Move sprint to bottom
              </button>
              <div className="bl-sprint-more__divider" role="separator" />
            </>
          )}
          <button
            type="button"
            className="bl-sprint-more__item"
            role="menuitem"
            onClick={() => { setOpen(false); onEditSprint(); }}
          >
            Edit sprint
          </button>
          <button
            type="button"
            className="bl-sprint-more__item bl-sprint-more__item--danger"
            role="menuitem"
            onClick={() => { setOpen(false); onDeleteSprint(); }}
          >
            Delete sprint
          </button>
        </div>
      )}
    </div>
  );
}

/* ─── Sprint section ─── */

interface SprintSectionProps {
  sprint: Sprint;
  /** Top-level rows: same rule as Board parent cards (non-subtasks + orphan subtasks). Subtasks in-bucket under parent nest. */
  rootTickets: Ticket[];
  /** All issues in this sprint/backlog bucket (for counts & progress). */
  statsTickets: Ticket[];
  allTickets: Ticket[];
  collapsedParents: Set<string>;
  onToggleParentFold: (issueKey: string) => void;
  isCollapsed: boolean;
  onToggle: () => void;
  onStartSprint: () => void;
  onCompleteSprint: () => void;
  onHealthCheck?: () => void;
  onRecoveryCheck?: () => void;
  onEditSprint: () => void;
  onDeleteSprint: () => void;
  onReorderSprint?: (action: SprintReorderAction) => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  /** When another sprint is already active, Start is disabled (Jira default). */
  startDisabledReason?: string | null;
  onCreateIssue: () => void;
  onTicketClick: (id: string) => void;
  isCreating: boolean;
  onSaveIssue: (title: string, storyPoints?: number) => void;
  onCancelCreate: () => void;
}

const SPRINT_STATUS_META: Record<SprintStatus, { label: string; cls: string }> = {
  active:    { label: 'ACTIVE',    cls: 'bl-sprint__badge--active' },
  future:    { label: 'UPCOMING',  cls: 'bl-sprint__badge--future' },
  completed: { label: 'COMPLETED', cls: 'bl-sprint__badge--completed' },
};

function sprintCompletionPercent(sprint: Sprint, tickets: Ticket[]): number | null {
  if (sprint.status === 'completed') {
    return sprint.finalScopeCompletionPercent ?? null;
  }
  const estimated = tickets.filter((ticket) => (ticket.storyPoints ?? 0) > 0);
  const total = estimated.reduce((sum, ticket) => sum + (ticket.storyPoints ?? 0), 0);
  if (total <= 0) return 0;
  const done = estimated
    .filter((ticket) => ticket.status === 'done')
    .reduce((sum, ticket) => sum + (ticket.storyPoints ?? 0), 0);
  return Math.round((done / total) * 100);
}

/**
 * Jira backlog estimate lozenges: story points by board column category.
 * Grey = first column (Planned), green = last (Done), blue = everything in between.
 */
function sprintEstimateByCategory(tickets: Ticket[]): {
  todo: number;
  inProgress: number;
  done: number;
  total: number;
  todoIssues: number;
  inProgressIssues: number;
  doneIssues: number;
} {
  let todo = 0;
  let inProgress = 0;
  let done = 0;
  let todoIssues = 0;
  let inProgressIssues = 0;
  let doneIssues = 0;
  for (const t of tickets) {
    const pts = t.storyPoints ?? 0;
    if (t.status === 'done') {
      doneIssues += 1;
      if (pts > 0) done += pts;
    } else if (t.status === 'planned') {
      todoIssues += 1;
      if (pts > 0) todo += pts;
    } else {
      inProgressIssues += 1;
      if (pts > 0) inProgress += pts;
    }
  }
  return {
    todo,
    inProgress,
    done,
    total: todo + inProgress + done,
    todoIssues,
    inProgressIssues,
    doneIssues,
  };
}

function SprintEstimateBadges({ tickets }: { tickets: Ticket[] }) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null);
  const { todo, inProgress, done, total, todoIssues, inProgressIssues, doneIssues } =
    sprintEstimateByCategory(tickets);

  const updateCoords = useCallback(() => {
    const el = hostRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setCoords({ left: r.left + r.width / 2, top: r.top });
  }, []);

  useEffect(() => {
    if (!open) return;
    updateCoords();
    const onScrollOrResize = () => updateCoords();
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [open, updateCoords]);

  const popup = open && coords
    ? createPortal(
        <div
          className="bl-sprint__estimate-popup"
          role="tooltip"
          style={{ left: coords.left, top: coords.top }}
        >
          <span className="bl-sprint__estimate-popup-title">Estimate (story points)</span>
          <span className="bl-sprint__estimate-popup-row">
            <i className="bl-sprint__estimate-dot bl-sprint__estimate-dot--todo" />
            <span>To do</span>
            <strong>{todo} pts</strong>
            <em>{todoIssues} issue{todoIssues !== 1 ? 's' : ''}</em>
          </span>
          <span className="bl-sprint__estimate-popup-row">
            <i className="bl-sprint__estimate-dot bl-sprint__estimate-dot--progress" />
            <span>In progress</span>
            <strong>{inProgress} pts</strong>
            <em>{inProgressIssues} issue{inProgressIssues !== 1 ? 's' : ''}</em>
          </span>
          <span className="bl-sprint__estimate-popup-row">
            <i className="bl-sprint__estimate-dot bl-sprint__estimate-dot--done" />
            <span>Done</span>
            <strong>{done} pts</strong>
            <em>{doneIssues} issue{doneIssues !== 1 ? 's' : ''}</em>
          </span>
          <span className="bl-sprint__estimate-popup-foot">
            Grey = Planned · Blue = In progress / Blocked / In review · Green = Done
          </span>
        </div>,
        document.body,
      )
    : null;

  return (
    <span
      ref={hostRef}
      className="bl-sprint__estimates"
      onClick={(e) => e.stopPropagation()}
      onMouseEnter={() => { updateCoords(); setOpen(true); }}
      onMouseLeave={() => setOpen(false)}
    >
      <span className="bl-sprint__estimate bl-sprint__estimate--todo" aria-hidden>{todo}</span>
      <span className="bl-sprint__estimate bl-sprint__estimate--progress" aria-hidden>{inProgress}</span>
      <span className="bl-sprint__estimate bl-sprint__estimate--done" aria-hidden>{done}</span>
      {total > 0 && <span className="bl-sprint__estimate-total">{total} pts</span>}
      {popup}
    </span>
  );
}

function SprintSection({
  sprint, rootTickets, statsTickets, allTickets, collapsedParents, onToggleParentFold, isCollapsed, onToggle,
  onStartSprint, onCompleteSprint, onHealthCheck, onRecoveryCheck, onEditSprint, onDeleteSprint, onReorderSprint, canMoveUp, canMoveDown,
  startDisabledReason, onCreateIssue, onTicketClick,
  isCreating, onSaveIssue, onCancelCreate,
}: SprintSectionProps) {
  const progress = sprintCompletionPercent(sprint, statsTickets);
  const meta = SPRINT_STATUS_META[sprint.status];
  const nTotal = sprint.status === 'completed'
    ? (sprint.finalIssueCount ?? statsTickets.length)
    : statsTickets.length;
  const nTop = rootTickets.length;
  const nNested = sprint.status === 'completed' ? 0 : nTotal - nTop;
  const completedHistoricalIssues = sprint.completedIssueCount ?? 0;
  const carriedOverIssues = sprint.status === 'completed'
    ? Math.max(0, (sprint.finalIssueCount ?? 0) - completedHistoricalIssues)
    : 0;
  const historyTitle = sprint.status === 'completed' && sprint.finalScopeCompletionPercent != null
    ? [
        `Initial commitment: ${sprint.initialCompletedPoints ?? 0}/${sprint.initialCommittedPoints ?? 0} points (${sprint.commitmentCompletionPercent ?? 0}%)`,
        `Final scope: ${sprint.completedPoints ?? 0}/${sprint.finalScopePoints ?? 0} points (${sprint.finalScopeCompletionPercent ?? 0}%)`,
        `Completed issues: ${sprint.completedIssueCount ?? 0}/${sprint.finalIssueCount ?? 0}`,
        `Unestimated issues: ${sprint.unestimatedIssueCount ?? 0}`,
      ].join('\n')
    : undefined;

  return (
    <section className="bl-sprint">
      <div className="bl-sprint__header" onClick={onToggle}>
        <span className={`bl-sprint__chevron ${isCollapsed ? '' : 'bl-sprint__chevron--open'}`}>▶</span>
        <span className="bl-sprint__name">{sprint.name}</span>
        <span className={`bl-sprint__badge ${meta.cls}`}>{meta.label}</span>
        <span className="bl-sprint__dates">{sprint.startDate} – {sprint.endDate}</span>
        <span
          className="bl-sprint__count"
          title="All issues in this sprint. Epics stay in the backlog bucket only (Jira-style). The Board hides epics. Same parent-card rule: non-subtasks are top-level rows; subtasks nest when their parent is in the same sprint."
        >
          {sprint.status === 'completed' ? (
            <>
              {nTotal} historical issue{nTotal !== 1 ? 's' : ''}
              <span className="bl-sprint__count-detail">
                · {completedHistoricalIssues} completed · {carriedOverIssues} carried over
              </span>
            </>
          ) : (
            <>{nTotal} issue{nTotal !== 1 ? 's' : ''}</>
          )}
          {sprint.status !== 'completed' && nNested > 0 && (
            <span className="bl-sprint__count-detail">· {nTop} top-level, {nNested} nested</span>
          )}
        </span>
        {sprint.status === 'completed' ? (
          <span className="bl-sprint__history-points" title={historyTitle}>
            {progress == null
              ? 'Historical metrics unavailable'
              : `${sprint.completedPoints ?? 0}/${sprint.finalScopePoints ?? 0} pts`}
          </span>
        ) : (
          <SprintEstimateBadges tickets={statsTickets} />
        )}
        {nTotal > 0 && progress != null && (
          <span className="bl-sprint__progress-wrap" title={historyTitle} onClick={(e) => e.stopPropagation()}>
            <span className="bl-sprint__progress-bar">
              <span className="bl-sprint__progress-fill" style={{ width: `${progress}%` }} />
            </span>
            <span className="bl-sprint__progress-label">{progress}% pts</span>
          </span>
        )}
        <div className="bl-sprint__actions" onClick={(e) => e.stopPropagation()}>
          {sprint.status === 'future' && (
            <button
              type="button"
              className="bl-btn bl-btn--primary bl-btn--sm"
              onClick={onStartSprint}
              disabled={Boolean(startDisabledReason)}
              title={startDisabledReason ?? undefined}
            >
              Start sprint
            </button>
          )}
          {sprint.status === 'active' && onHealthCheck && (
            <button type="button" className="bl-btn bl-btn--outline bl-btn--sm" onClick={onHealthCheck}>
              🩺 AI health check
            </button>
          )}
          {sprint.status === 'active' && onRecoveryCheck && (
            <button type="button" className="bl-btn bl-btn--outline bl-btn--sm" onClick={onRecoveryCheck}>
              🚑 AI recovery
            </button>
          )}
          {sprint.status === 'active' && (
            <button type="button" className="bl-btn bl-btn--default bl-btn--sm" onClick={onCompleteSprint}>
              Complete sprint
            </button>
          )}
          <SprintMoreMenu
            onEditSprint={onEditSprint}
            onDeleteSprint={onDeleteSprint}
            onReorderSprint={sprint.status === 'future' ? onReorderSprint : undefined}
            canMoveUp={canMoveUp}
            canMoveDown={canMoveDown}
          />
        </div>
      </div>

      {sprint.goal && !isCollapsed && (
        <p className="bl-sprint__goal">Sprint Goal: {sprint.goal}</p>
      )}
      {!isCollapsed && sprint.status === 'completed' && carriedOverIssues > 0 && (
        <p className="bl-sprint__history-note">
          {carriedOverIssues} incomplete issue{carriedOverIssues !== 1 ? 's were' : ' was'} carried forward.
          The rows below are completed work retained on this sprint; carried-over work now appears in its destination sprint.
        </p>
      )}

      {!isCollapsed && (
        <Droppable droppableId={sprint.id}>
          {(provided, snapshot) => (
            <div
              className={`bl-sprint__body ${snapshot.isDraggingOver ? 'bl-sprint__body--drag-over' : ''}`}
              ref={provided.innerRef}
              {...provided.droppableProps}
            >
              {rootTickets.length === 0 && !isCreating && (
                <p className="bl-sprint__empty">Plan your sprint. Drag issues here or create new ones.</p>
              )}
              {rootTickets.map((t, index) => (
                <Draggable key={t.id} draggableId={t.id} index={index}>
                  {(dragProvided, dragSnapshot) => (
                    <div
                      ref={dragProvided.innerRef}
                      {...dragProvided.draggableProps}
                      {...dragProvided.dragHandleProps}
                      className={dragSnapshot.isDragging ? 'bl-row-wrap bl-row-wrap--dragging' : 'bl-row-wrap'}
                    >
                      <TicketRowWithSubtasks
                        root={t}
                        allTickets={allTickets}
                        onTicketClick={onTicketClick}
                        collapsedParents={collapsedParents}
                        onToggleParentFold={onToggleParentFold}
                      />
                    </div>
                  )}
                </Draggable>
              ))}
              {provided.placeholder}
              {isCreating
                ? <InlineCreate onSave={onSaveIssue} onCancel={onCancelCreate} requirePoints />
                : <button type="button" className="bl-create-btn" onClick={onCreateIssue}>+ Create issue</button>
              }
            </div>
          )}
        </Droppable>
      )}
    </section>
  );
}

/* ─── Backlog section ─── */

interface BacklogSectionProps {
  rootTickets: Ticket[];
  statsTickets: Ticket[];
  allTickets: Ticket[];
  collapsedParents: Set<string>;
  onToggleParentFold: (issueKey: string) => void;
  isCollapsed: boolean;
  onToggle: () => void;
  onTicketClick: (id: string) => void;
  isCreating: boolean;
  onCreateIssue: () => void;
  onSaveIssue: (title: string, storyPoints?: number) => void;
  onCancelCreate: () => void;
}

function BacklogSection({
  rootTickets,
  statsTickets,
  allTickets,
  collapsedParents,
  onToggleParentFold,
  isCollapsed,
  onToggle,
  onTicketClick,
  isCreating,
  onCreateIssue,
  onSaveIssue,
  onCancelCreate,
}: BacklogSectionProps) {
  const nTotal = statsTickets.length;
  const nTop = rootTickets.length;
  const nNested = nTotal - nTop;
  return (
    <section className="bl-sprint bl-sprint--backlog">
      <div className="bl-sprint__header" onClick={onToggle}>
        <span className={`bl-sprint__chevron ${isCollapsed ? '' : 'bl-sprint__chevron--open'}`}>▶</span>
        <span className="bl-sprint__name">Backlog</span>
        <span
          className="bl-sprint__count"
          title="All issues in the backlog bucket. Top-level rows follow the same rule as the Board parent cards (non-subtasks + subtasks whose parent is not in the backlog)."
        >
          {nTotal} issue{nTotal !== 1 ? 's' : ''}
          {nNested > 0 && (
            <span className="bl-sprint__count-detail">· {nTop} top-level, {nNested} nested</span>
          )}
        </span>
        <SprintEstimateBadges tickets={statsTickets} />
      </div>
      {!isCollapsed && (
        <Droppable droppableId="backlog">
          {(provided, snapshot) => (
            <div
              className={`bl-sprint__body ${snapshot.isDraggingOver ? 'bl-sprint__body--drag-over' : ''}`}
              ref={provided.innerRef}
              {...provided.droppableProps}
            >
              {rootTickets.length === 0 && !isCreating && (
                <p className="bl-sprint__empty">Your backlog is empty.</p>
              )}
              {rootTickets.map((t, index) => (
                <Draggable key={t.id} draggableId={t.id} index={index}>
                  {(dragProvided, dragSnapshot) => (
                    <div
                      ref={dragProvided.innerRef}
                      {...dragProvided.draggableProps}
                      {...dragProvided.dragHandleProps}
                      className={dragSnapshot.isDragging ? 'bl-row-wrap bl-row-wrap--dragging' : 'bl-row-wrap'}
                    >
                      <TicketRowWithSubtasks
                        root={t}
                        allTickets={allTickets}
                        onTicketClick={onTicketClick}
                        collapsedParents={collapsedParents}
                        onToggleParentFold={onToggleParentFold}
                      />
                    </div>
                  )}
                </Draggable>
              ))}
              {provided.placeholder}
              {isCreating
                ? <InlineCreate onSave={onSaveIssue} onCancel={onCancelCreate} />
                : <button type="button" className="bl-create-btn" onClick={onCreateIssue}>+ Create issue</button>
              }
            </div>
          )}
        </Droppable>
      )}
    </section>
  );
}

/* ─── Main Backlog page ─── */

export function Backlog() {
  const { currentUser } = useCurrentUser();
  const { currentSpace } = useSpaces();
  const {
    tickets, sprints,
    updateTicket, createSubtask, createIssueInSprint, deleteTicket,
    createSprint: ctxCreateSprint, startSprint, completeSprint, reorderSprint, updateSprint, deleteSprint,
    applyBacklogRank,
    addComment, editComment, deleteComment, addIssueLink, deleteIssueLink,
    addCodeLink, deleteCodeLink, refreshCodeLinks, hydrateIssueDetail,
    refreshData,
  } = useTickets();
  const [searchParams, setSearchParams] = useSearchParams();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(['completed']));
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [startingSprintId, setStartingSprintId] = useState<string | null>(null);
  const [editingSprintId, setEditingSprintId] = useState<string | null>(null);
  const [completingSprintId, setCompletingSprintId] = useState<string | null>(null);
  const [showPlanEpicModal, setShowPlanEpicModal] = useState(false);
  const [showRolloutModal, setShowRolloutModal] = useState(false);
  const [healthCheckSprintId, setHealthCheckSprintId] = useState<string | null>(null);
  const [recoveryCheckSprintId, setRecoveryCheckSprintId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [topLevelOnly, setTopLevelOnly] = useState(false);
  const [assigneeFilter, setAssigneeFilter] = useState<string[]>([]);
  const [issueFilters, setIssueFilters] = useState<IssueFilters>(EMPTY_ISSUE_FILTERS);
  /** Parent issue keys with subtasks folded (hidden). */
  const [collapsedParents, setCollapsedParents] = useState<Set<string>>(() => new Set());
  const toggleParentFold = useCallback((issueKey: string) => {
    setCollapsedParents((prev) => {
      const next = new Set(prev);
      if (next.has(issueKey)) next.delete(issueKey);
      else next.add(issueKey);
      return next;
    });
  }, []);

  const selectedTicketId = searchParams.get('ticket');
  const selectedTicket = useMemo(() => tickets.find((t) => t.id === selectedTicketId) ?? null, [tickets, selectedTicketId]);

  useEffect(() => {
    if (!selectedTicketId) return;
    void hydrateIssueDetail(selectedTicketId);
  }, [selectedTicketId, hydrateIssueDetail]);

  const backlogAssigneeNames = useMemo(
    () =>
      collectToolbarAssigneeNames(tickets, {
        excludeEpics: true,
        spaceMemberIds: effectiveSpaceMemberIds(currentSpace),
      }),
    [tickets, currentSpace],
  );

  useEffect(() => {
    setAssigneeFilter((prev) => {
      const next = prev.filter(
        (f) => f === BOARD_ASSIGNEE_FILTER_UNASSIGNED || backlogAssigneeNames.sortedNames.includes(f),
      );
      return next.length === prev.length ? prev : next;
    });
  }, [backlogAssigneeNames.sortedNames]);

  const filteredTickets = useMemo(() => {
    const byHierarchy = topLevelOnly
      ? tickets.filter((ticket) => ticket.issueType !== 'subtask')
      : tickets;
    const byAssignee = byHierarchy.filter((t) => ticketMatchesAssigneeFilter(t, assigneeFilter));
    const q = search.trim().toLowerCase();
    const useFilters = hasActiveIssueFilters(issueFilters);
    const match = (t: Ticket) => {
      // Assignee chips already applied; skip assignee dimension in the panel filters.
      if (useFilters && !ticketMatchesIssueFilters(t, issueFilters, { skipAssignee: true, allTickets: tickets })) {
        return false;
      }
      if (!q) return true;
      return (
        t.title.toLowerCase().includes(q) ||
        t.id.toLowerCase().includes(q) ||
        (t.assignee ?? '').toLowerCase().includes(q)
      );
    };
    if (!q && !useFilters) return byAssignee;
    const direct = byAssignee.filter(match);
    return withMatchedParents(direct, byAssignee);
  }, [tickets, search, issueFilters, assigneeFilter, topLevelOnly]);

  /** Metrics are never filter-dependent; search/filter only changes visible rows. */
  const allStatsByBucket = useMemo(() => {
    const map: Record<string, Ticket[]> = {};
    for (const ticket of tickets) {
      if (ticket.issueType === 'epic') continue;
      const key = displayBucketKey(ticket);
      if (!map[key]) map[key] = [];
      map[key].push(ticket);
    }
    return map;
  }, [tickets]);

  const rootsByBucket = useMemo(() => {
    const map: Record<string, Ticket[]> = {};
    for (const t of filteredTickets) {
      if (t.issueType === 'epic') continue;
      if (!isBacklogRootRow(t, filteredTickets)) continue;
      const key = displayBucketKey(t);
      if (!map[key]) map[key] = [];
      map[key].push(t);
    }
    for (const k of Object.keys(map)) {
      map[k] = k === 'backlog' ? sortBacklogRootTickets(map[k]) : sortRootTicketsByOrder(map[k]);
    }
    return map;
  }, [filteredTickets]);

  /** Unfiltered roots — used so rank updates don't clobber hidden issues when filters are on. */
  const allRootsByBucket = useMemo(() => {
    const map: Record<string, Ticket[]> = {};
    for (const t of tickets) {
      if (t.issueType === 'epic') continue;
      if (!isBacklogRootRow(t, tickets)) continue;
      const key = displayBucketKey(t);
      if (!map[key]) map[key] = [];
      map[key].push(t);
    }
    for (const k of Object.keys(map)) {
      map[k] = k === 'backlog' ? sortBacklogRootTickets(map[k]) : sortRootTicketsByOrder(map[k]);
    }
    return map;
  }, [tickets]);

  function toggleCollapse(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function openTicket(id: string) { setSearchParams({ ticket: id }); }
  function closeTicket() { setSearchParams({}); }

  const handleTicketUpdate = useCallback(
    (updated: Ticket) => updateTicket(updated),
    [updateTicket],
  );

  const handleCreateSubtask = useCallback((parentId: string, title: string) => {
    createSubtask(parentId, title);
  }, [createSubtask]);

  const onDragEnd = useCallback((result: DropResult) => {
    if (!result.destination) return;
    const { source, destination, draggableId } = result;
    if (source.droppableId === destination.droppableId && source.index === destination.index) return;

    const destBucket = destination.droppableId;
    const sourceBucket = source.droppableId;
    const nextSprintId = destBucket === 'backlog' ? null : destBucket;
    const moved = tickets.find((t) => t.id === draggableId);
    if (!moved) return;
    if (moved.issueType === 'epic' && nextSprintId != null) {
      window.alert('In Jira-style workflow, epics are not assigned to sprints. Link stories to the epic and plan those into sprints.');
      return;
    }
    if (
      nextSprintId != null
      && moved.issueType !== 'subtask'
      && !(moved.storyPoints != null && moved.storyPoints > 0)
    ) {
      window.alert(`Add story points to ${moved.id} before moving it into a sprint.`);
      return;
    }

    const visibleDest = rootsByBucket[destBucket] ?? [];
    const fullDest = [...(allRootsByBucket[destBucket] ?? [])];
    const sameBucket = sourceBucket === destBucket;

    // Place among the full list using the visible drop neighbors (Jira-style when filtered).
    const visibleWithout = visibleDest.filter((t) => t.id !== draggableId);
    const beforeId =
      destination.index > 0 ? visibleWithout[destination.index - 1]?.id : undefined;
    const afterId = visibleWithout[destination.index]?.id;

    const destWithout = fullDest.filter((t) => t.id !== draggableId);
    let insertAt = destWithout.length;
    if (beforeId) {
      const bi = destWithout.findIndex((t) => t.id === beforeId);
      insertAt = bi === -1 ? destWithout.length : bi + 1;
    } else if (afterId) {
      const ai = destWithout.findIndex((t) => t.id === afterId);
      insertAt = ai === -1 ? 0 : ai;
    } else if (sameBucket && destination.index === 0) {
      insertAt = 0;
    }
    destWithout.splice(insertAt, 0, moved);

    const updates: Array<{ ticketId: string; issueOrder: number; sprintId?: string | null }> =
      destWithout.map((t, index) => {
        const base = { ticketId: t.id, issueOrder: index };
        if (t.id === draggableId && !sameBucket) return { ...base, sprintId: nextSprintId };
        return base;
      });

    if (!sameBucket) {
      const sourceFull = (allRootsByBucket[sourceBucket] ?? []).filter((t) => t.id !== draggableId);
      sourceFull.forEach((t, index) => {
        updates.push({ ticketId: t.id, issueOrder: index });
      });
    }

    applyBacklogRank(updates);
  }, [tickets, rootsByBucket, allRootsByBucket, applyBacklogRank]);

  function handleCreateIssue(sprintId: string | null, title: string, storyPoints?: number) {
    createIssueInSprint(sprintId, title, storyPoints);
    setCreatingIn(null);
  }

  function handleStartSprint(sprintId: string, updates: Pick<Sprint, 'startDate' | 'endDate' | 'goal'>) {
    startSprint(sprintId, updates);
    setStartingSprintId(null);
  }

  function handleCompleteSprint(
    sprintId: string,
    options?: {
      incompleteDestination?: 'backlog' | 'future_sprint' | 'new_sprint';
      moveToSprintId?: string;
      newSprintName?: string;
    },
  ) {
    completeSprint(sprintId, options);
    setCompletingSprintId(null);
  }

  function handleCreateSprint() {
    ctxCreateSprint();
  }

  function handleEditSprint(sprintId: string, updates: Partial<Pick<Sprint, 'name' | 'goal' | 'startDate' | 'endDate'>>) {
    updateSprint(sprintId, updates);
    setEditingSprintId(null);
  }

  function handleDeleteSprint(sprintId: string) {
    const sprint = sprints.find((s) => s.id === sprintId);
    if (!sprint) return;
    const nextSprint = sprints.find((s) => s.status === 'future' && s.id !== sprintId);
    const destinationLabel = nextSprint ? nextSprint.name : 'Backlog';
    if (!confirm(`Delete "${sprint.name}"? Issues will move to ${destinationLabel}.`)) return;
    deleteSprint(sprintId);
  }

  // Jira backlog order: closed → active → future → backlog
  const completedSprints = useMemo(
    () => sprints.filter((s) => s.status === 'completed'),
    [sprints],
  );
  const openSprints = useMemo(
    () => [
      ...sprints.filter((s) => s.status === 'active'),
      ...sprints.filter((s) => s.status === 'future'),
    ],
    [sprints],
  );
  const futureSprints = useMemo(
    () => openSprints.filter((s) => s.status === 'future'),
    [openSprints],
  );
  const closedCollapsed = collapsed.has('completed');
  const allClosedSprintsCollapsed = completedSprints.every((sprint) => collapsed.has(sprint.id));

  function toggleAllClosedSprints() {
    const shouldExpand = closedCollapsed || allClosedSprintsCollapsed;
    setCollapsed((prev) => {
      const next = new Set(prev);
      // The bulk control always reveals the Closed sprints container so its
      // result is immediately visible.
      next.delete('completed');
      for (const sprint of completedSprints) {
        if (shouldExpand) next.delete(sprint.id);
        else next.add(sprint.id);
      }
      return next;
    });
  }

  const startingSprint = startingSprintId ? sprints.find((s) => s.id === startingSprintId) ?? null : null;
  const editingSprint = editingSprintId ? sprints.find((s) => s.id === editingSprintId) ?? null : null;
  const completingSprint = completingSprintId ? sprints.find((s) => s.id === completingSprintId) ?? null : null;
  const futureSprintsForComplete = useMemo(
    () => sprints.filter((s) => s.status === 'future' && s.id !== completingSprintId),
    [sprints, completingSprintId],
  );
  const existingActiveSprint = useMemo(() => activeSprintInSpace(sprints), [sprints]);
  const startDisabledReason = existingActiveSprint
    ? `There can only be one active sprint. Complete "${existingActiveSprint.name}" first.`
    : null;

  function renderSprintSection(sprint: Sprint) {
    const futureIndex = futureSprints.findIndex((s) => s.id === sprint.id);
    const isFuture = sprint.status === 'future';
    return (
      <SprintSection
        key={sprint.id}
        sprint={sprint}
        rootTickets={rootsByBucket[sprint.id] ?? []}
        statsTickets={allStatsByBucket[sprint.id] ?? []}
        allTickets={filteredTickets}
        collapsedParents={collapsedParents}
        onToggleParentFold={toggleParentFold}
        isCollapsed={collapsed.has(sprint.id)}
        onToggle={() => toggleCollapse(sprint.id)}
        onStartSprint={() => setStartingSprintId(sprint.id)}
        onCompleteSprint={() => setCompletingSprintId(sprint.id)}
        onHealthCheck={sprint.status === 'active' ? () => setHealthCheckSprintId(sprint.id) : undefined}
        onRecoveryCheck={sprint.status === 'active' ? () => setRecoveryCheckSprintId(sprint.id) : undefined}
        onEditSprint={() => setEditingSprintId(sprint.id)}
        onDeleteSprint={() => handleDeleteSprint(sprint.id)}
        onReorderSprint={isFuture ? (action) => reorderSprint(sprint.id, action) : undefined}
        canMoveUp={isFuture && futureIndex > 0}
        canMoveDown={isFuture && futureIndex >= 0 && futureIndex < futureSprints.length - 1}
        startDisabledReason={isFuture ? startDisabledReason : null}
        onCreateIssue={() => setCreatingIn(sprint.id)}
        onTicketClick={(id) => openTicket(id)}
        isCreating={creatingIn === sprint.id}
        onSaveIssue={(title) => handleCreateIssue(sprint.id, title)}
        onCancelCreate={() => setCreatingIn(null)}
      />
    );
  }

  return (
    <div className="backlog-page">
      {selectedTicket && (
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
          onOpenTicket={(id) => openTicket(id)}
          onClose={closeTicket}
        />
      )}

      {startingSprint && (
        <StartSprintModal
          sprint={startingSprint}
          tickets={tickets.filter((ticket) => ticket.sprintId === startingSprint.id)}
          allSprints={sprints}
          onConfirm={(updates) => handleStartSprint(startingSprint.id, updates)}
          onClose={() => setStartingSprintId(null)}
        />
      )}

      {editingSprint && (
        <EditSprintModal
          sprint={editingSprint}
          allSprints={sprints}
          onConfirm={(updates) => handleEditSprint(editingSprint.id, updates)}
          onClose={() => setEditingSprintId(null)}
        />
      )}

      {completingSprint && (
        <CompleteSprintModal
          sprint={completingSprint}
          tickets={tickets}
          futureSprints={futureSprintsForComplete}
          onConfirm={(options) => handleCompleteSprint(completingSprint.id, options)}
          onClose={() => setCompletingSprintId(null)}
        />
      )}

      {showPlanEpicModal && (
        <PlanEpicModal
          spaceId={Number(currentSpace.id)}
          sprints={sprints}
          onCommitted={() => refreshData()}
          onClose={() => setShowPlanEpicModal(false)}
        />
      )}

      {showRolloutModal && (
        <RolloutModal
          spaceId={Number(currentSpace.id)}
          onCommitted={() => refreshData()}
          onClose={() => setShowRolloutModal(false)}
        />
      )}

      {healthCheckSprintId && (() => {
        const healthSprint = sprints.find((s) => s.id === healthCheckSprintId);
        return healthSprint ? (
          <SprintHealthModal
            sprint={healthSprint}
            tickets={tickets}
            onClose={() => setHealthCheckSprintId(null)}
          />
        ) : null;
      })()}

      {recoveryCheckSprintId && (() => {
        const recoverySprint = sprints.find((s) => s.id === recoveryCheckSprintId);
        return recoverySprint ? (
          <SprintRecoveryModal
            spaceId={Number(currentSpace.id)}
            sprintId={Number(recoverySprint.id)}
            sprintName={recoverySprint.name}
            onClose={() => setRecoveryCheckSprintId(null)}
          />
        ) : null;
      })()}

      <div className="bl-toolbar">
        <input
          type="search"
          className="bl-toolbar__search"
          placeholder="Search backlog"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <BoardAssigneeFilter
          sortedNames={backlogAssigneeNames.sortedNames}
          anyUnassigned={backlogAssigneeNames.anyUnassigned}
          assigneeFilter={assigneeFilter}
          onAssigneeFilterChange={setAssigneeFilter}
        />
        <IssueFilterPanel
          tickets={tickets}
          filters={issueFilters}
          onChange={setIssueFilters}
          hideAssignee
        />
        <div
          className="bl-toolbar__view-control"
          title="Changes which rows are shown. Sprint issue and point totals stay unchanged."
        >
          <span className="bl-toolbar__view-label">View</span>
          <button
            type="button"
            className="bl-toolbar__subtask-switch"
            role="switch"
            aria-checked={!topLevelOnly}
            onClick={() => setTopLevelOnly((current) => !current)}
          >
            <span className={`bl-toolbar__switch-track${topLevelOnly ? '' : ' is-on'}`} aria-hidden>
              <span className="bl-toolbar__switch-thumb" />
            </span>
            <span>Show subtasks</span>
          </button>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem' }}>
          <button type="button" className="bl-btn bl-btn--outline" onClick={() => setShowPlanEpicModal(true)}>
            ✨ Plan Epic with AI
          </button>
          <button type="button" className="bl-btn bl-btn--outline" onClick={() => setShowRolloutModal(true)}>
            🔒 Epic rollout (durable)
          </button>
          <button type="button" className="bl-btn bl-btn--primary" onClick={handleCreateSprint}>
            + Create Sprint
          </button>
        </div>
      </div>

      <DragDropContext onDragEnd={onDragEnd}>
        {completedSprints.length > 0 && (
          <section className="bl-closed">
            <div className={`bl-closed__header-row ${closedCollapsed ? '' : 'bl-closed__header-row--open'}`}>
              <button
                type="button"
                className="bl-closed__header"
                onClick={() => toggleCollapse('completed')}
                aria-expanded={!closedCollapsed}
              >
                <span className={`bl-sprint__chevron ${closedCollapsed ? '' : 'bl-sprint__chevron--open'}`}>▶</span>
                <span className="bl-closed__title">Closed sprints</span>
                <span className="bl-closed__count">{completedSprints.length}</span>
              </button>
              <button
                type="button"
                className="bl-closed__toggle-all"
                onClick={toggleAllClosedSprints}
                aria-label={closedCollapsed || allClosedSprintsCollapsed ? 'Expand all closed sprints' : 'Collapse all closed sprints'}
                title={closedCollapsed || allClosedSprintsCollapsed ? 'Expand all closed sprints' : 'Collapse all closed sprints'}
              >
                <span aria-hidden="true">{closedCollapsed || allClosedSprintsCollapsed ? '⇊' : '⇈'}</span>
                {closedCollapsed || allClosedSprintsCollapsed ? 'Expand all' : 'Collapse all'}
              </button>
            </div>
            {!closedCollapsed && (
              <div className="bl-closed__body">
                {completedSprints.map((sprint) => renderSprintSection(sprint))}
              </div>
            )}
          </section>
        )}

        {openSprints.map((sprint) => renderSprintSection(sprint))}

        <BacklogSection
          rootTickets={rootsByBucket['backlog'] ?? []}
          statsTickets={allStatsByBucket['backlog'] ?? []}
          allTickets={filteredTickets}
          collapsedParents={collapsedParents}
          onToggleParentFold={toggleParentFold}
          isCollapsed={collapsed.has('backlog')}
          onToggle={() => toggleCollapse('backlog')}
          onTicketClick={(id) => openTicket(id)}
          isCreating={creatingIn === 'backlog'}
          onCreateIssue={() => setCreatingIn('backlog')}
          onSaveIssue={(title) => handleCreateIssue(null, title)}
          onCancelCreate={() => setCreatingIn(null)}
        />
      </DragDropContext>
    </div>
  );
}
