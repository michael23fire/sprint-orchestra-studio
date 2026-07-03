import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DragDropContext, Droppable, Draggable, type DropResult } from '@hello-pangea/dnd';
import { TicketDetailModal } from '../components/TicketDetailModal';
import type { Ticket, TicketStatus, TicketLabel } from '../types/ticket';
import { LABEL_COLORS } from '../types/ticket';
import type { Sprint, SprintStatus } from '../types/sprint';
import { useCurrentUser } from '../context/UserContext';
import { useTickets } from '../context/TicketContext';
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

/** Epics first (Jira backlog treats epics as top-level portfolio rows). */
function sortBacklogRootTickets(roots: Ticket[]): Ticket[] {
  return [...roots].sort((a, b) => {
    const aEp = a.issueType === 'epic' ? 1 : 0;
    const bEp = b.issueType === 'epic' ? 1 : 0;
    if (aEp !== bEp) return bEp - aEp;
    return 0;
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

function IssueTypeIcon({ labels }: { labels?: TicketLabel[] }) {
  const first = labels?.[0];
  const MAP: Partial<Record<TicketLabel, { char: string; bg: string }>> = {
    Bug:         { char: 'B', bg: '#ef4444' },
    Story:       { char: 'S', bg: '#10b981' },
    Epic:        { char: 'E', bg: '#6366f1' },
    Feature:     { char: 'F', bg: '#3b82f6' },
    Improvement: { char: 'I', bg: '#06b6d4' },
  };
  const icon = (first && MAP[first]) ?? { char: 'T', bg: '#64748b' };
  return (
    <span className="bl-row__type" style={{ background: icon.bg }} title={first ?? 'Task'}>
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
  return (
    <div
      className={`bl-row ${nested ? 'bl-row--nested' : ''}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onClick()}
    >
      {!nested && foldable && onToggleFold ? (
        <button
          type="button"
          className="bl-row__fold"
          onClick={(e) => {
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
      <IssueTypeIcon labels={ticket.labels} />
      <span className="bl-row__id">{ticket.id}</span>
      <span className="bl-row__title">{ticket.title}</span>
      <span className="bl-row__labels">
        {(ticket.labels ?? []).slice(0, 2).map((l) => (
          <span key={l} className="bl-row__label" style={{ background: LABEL_COLORS[l].bg, color: LABEL_COLORS[l].text }}>{l}</span>
        ))}
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
    </div>
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
  onSave: (title: string) => void;
  onCancel: () => void;
}

function InlineCreate({ onSave, onCancel }: InlineCreateProps) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);

  function handleSave() {
    if (value.trim()) onSave(value.trim());
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
      <button type="button" className="bl-btn bl-btn--primary" onClick={handleSave} disabled={!value.trim()}>Create</button>
      <button type="button" className="bl-btn bl-btn--ghost" onClick={onCancel}>Cancel</button>
    </div>
  );
}

/* ─── Start Sprint Modal ─── */

interface StartSprintModalProps {
  sprint: Sprint;
  onConfirm: (updates: Pick<Sprint, 'startDate' | 'endDate' | 'goal'>) => void;
  onClose: () => void;
}

function StartSprintModal({ sprint, onConfirm, onClose }: StartSprintModalProps) {
  const today = new Date().toISOString().slice(0, 10);
  const twoWeeks = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(twoWeeks);
  const [goal, setGoal] = useState(sprint.goal ?? '');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

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
              <input className="bl-modal__input" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div className="bl-modal__field">
              <label className="bl-modal__label">End date</label>
              <input className="bl-modal__input" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
          </div>
        </div>
        <div className="bl-modal__footer">
          <button type="button" className="bl-btn bl-btn--ghost" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="bl-btn bl-btn--primary"
            onClick={() => onConfirm({ startDate, endDate, goal: goal || undefined })}
          >
            Start Sprint
          </button>
        </div>
      </div>
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
  onCreateIssue: () => void;
  onTicketClick: (id: string) => void;
  isCreating: boolean;
  onSaveIssue: (title: string) => void;
  onCancelCreate: () => void;
}

const SPRINT_STATUS_META: Record<SprintStatus, { label: string; cls: string }> = {
  active:    { label: 'ACTIVE',    cls: 'bl-sprint__badge--active' },
  future:    { label: 'UPCOMING',  cls: 'bl-sprint__badge--future' },
  completed: { label: 'COMPLETED', cls: 'bl-sprint__badge--completed' },
};

/**
 * Sprint completion %: uses story points when set (>0); each unestimated issue counts as 1
 * so progress matches the visible issue list (avoids 0% when no points are entered).
 */
function sprintCompletionPercent(tickets: Ticket[]): number {
  if (tickets.length === 0) return 0;
  const weight = (t: Ticket) => {
    const p = t.storyPoints;
    return p != null && p > 0 ? p : 1;
  };
  const totalW = tickets.reduce((s, t) => s + weight(t), 0);
  const doneW = tickets.filter((t) => t.status === 'done').reduce((s, t) => s + weight(t), 0);
  return Math.round((doneW / totalW) * 100);
}

function SprintSection({
  sprint, rootTickets, statsTickets, allTickets, collapsedParents, onToggleParentFold, isCollapsed, onToggle,
  onStartSprint, onCompleteSprint, onCreateIssue, onTicketClick,
  isCreating, onSaveIssue, onCancelCreate,
}: SprintSectionProps) {
  const totalPts = statsTickets.reduce((s, t) => s + (t.storyPoints ?? 0), 0);
  const progress = sprintCompletionPercent(statsTickets);
  const meta = SPRINT_STATUS_META[sprint.status];
  const nTotal = statsTickets.length;
  const nTop = rootTickets.length;
  const nNested = nTotal - nTop;

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
          {nTotal} issue{nTotal !== 1 ? 's' : ''}
          {nNested > 0 && (
            <span className="bl-sprint__count-detail">· {nTop} top-level, {nNested} nested</span>
          )}
        </span>
        <span className="bl-sprint__pts">{totalPts} pts</span>
        {statsTickets.length > 0 && (
          <span className="bl-sprint__progress-wrap" onClick={(e) => e.stopPropagation()}>
            <span className="bl-sprint__progress-bar">
              <span className="bl-sprint__progress-fill" style={{ width: `${progress}%` }} />
            </span>
            <span className="bl-sprint__progress-label">{progress}%</span>
          </span>
        )}
        <div className="bl-sprint__actions" onClick={(e) => e.stopPropagation()}>
          {sprint.status === 'future' && (
            <button type="button" className="bl-btn bl-btn--primary bl-btn--sm" onClick={onStartSprint}>Start Sprint</button>
          )}
          {sprint.status === 'active' && (
            <button type="button" className="bl-btn bl-btn--outline bl-btn--sm" onClick={onCompleteSprint}>Complete Sprint</button>
          )}
        </div>
      </div>

      {sprint.goal && !isCollapsed && (
        <p className="bl-sprint__goal">Sprint Goal: {sprint.goal}</p>
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
  onSaveIssue: (title: string) => void;
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
  const totalPts = statsTickets.reduce((s, t) => s + (t.storyPoints ?? 0), 0);
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
        <span className="bl-sprint__pts">{totalPts} pts</span>
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
  const {
    tickets, sprints,
    updateTicket, createSubtask, createIssueInSprint, deleteTicket,
    createSprint: ctxCreateSprint, startSprint, completeSprint,
    addComment, editComment, deleteComment, addIssueLink, deleteIssueLink,
    addCodeLink, deleteCodeLink, refreshCodeLinks, hydrateIssueDetail,
  } = useTickets();
  const [searchParams, setSearchParams] = useSearchParams();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(['completed']));
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [startingSprintId, setStartingSprintId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
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

  const filteredTickets = useMemo(() => {
    const q = search.toLowerCase();
    if (!q) return tickets;
    const match = (t: Ticket) =>
      t.title.toLowerCase().includes(q) || t.id.toLowerCase().includes(q);
    const direct = tickets.filter(match);
    const directIds = new Set(direct.map((t) => t.id));
    const parentKeys = new Set<string>();
    for (const t of direct) {
      if (t.parentId) parentKeys.add(t.parentId);
    }
    const parents = tickets.filter((t) => parentKeys.has(t.id) && !directIds.has(t.id));
    return [...direct, ...parents];
  }, [tickets, search]);

  const statsByBucket = useMemo(() => {
    const map: Record<string, Ticket[]> = {};
    for (const t of filteredTickets) {
      const key = displayBucketKey(t);
      if (!map[key]) map[key] = [];
      map[key].push(t);
    }
    return map;
  }, [filteredTickets]);

  const rootsByBucket = useMemo(() => {
    const map: Record<string, Ticket[]> = {};
    for (const t of filteredTickets) {
      if (!isBacklogRootRow(t, filteredTickets)) continue;
      const key = displayBucketKey(t);
      if (!map[key]) map[key] = [];
      map[key].push(t);
    }
    for (const k of Object.keys(map)) {
      if (k === 'backlog') map[k] = sortBacklogRootTickets(map[k]);
    }
    return map;
  }, [filteredTickets]);

  function toggleCollapse(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function openTicket(id: string) { setSearchParams({ ticket: id }); }
  function closeTicket() { setSearchParams({}); }

  const handleTicketUpdate = useCallback((updated: Ticket) => {
    updateTicket(updated);
  }, [updateTicket]);

  const handleCreateSubtask = useCallback((parentId: string, title: string) => {
    createSubtask(parentId, title);
  }, [createSubtask]);

  const handleMoveIssue = useCallback((ticketId: string, sprintId: string | null) => {
    const t = tickets.find((x) => x.id === ticketId);
    if (!t) return;
    if (t.issueType === 'epic' && sprintId != null) {
      window.alert('In Jira-style workflow, epics are not assigned to sprints. Link stories to the epic and plan those into sprints.');
      return;
    }
    const sprintName = sprintId ? sprints.find((s) => s.id === sprintId)?.name : undefined;
    updateTicket({
      ...t,
      sprintId: sprintId ?? undefined,
      sprint: sprintName,
    });
  }, [tickets, sprints, updateTicket]);

  const onDragEnd = useCallback((result: DropResult) => {
    if (!result.destination) return;
    const { source, destination, draggableId } = result;
    if (source.droppableId === destination.droppableId && source.index === destination.index) return;
    const nextSprintId = destination.droppableId === 'backlog' ? null : destination.droppableId;
    handleMoveIssue(draggableId, nextSprintId);
  }, [handleMoveIssue]);

  function handleCreateIssue(sprintId: string | null, title: string) {
    createIssueInSprint(sprintId, title);
    setCreatingIn(null);
  }

  function handleStartSprint(sprintId: string, updates: Pick<Sprint, 'startDate' | 'endDate' | 'goal'>) {
    startSprint(sprintId, updates);
    setStartingSprintId(null);
  }

  function handleCompleteSprint(sprintId: string) {
    if (!confirm('Complete this sprint? Incomplete issues will move to the backlog.')) return;
    completeSprint(sprintId);
  }

  function handleCreateSprint() {
    ctxCreateSprint();
  }

  const sortedSprints = useMemo(() => [
    ...sprints.filter((s) => s.status === 'active'),
    ...sprints.filter((s) => s.status === 'future'),
    ...sprints.filter((s) => s.status === 'completed'),
  ], [sprints]);

  const startingSprint = startingSprintId ? sprints.find((s) => s.id === startingSprintId) ?? null : null;

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
          onConfirm={(updates) => handleStartSprint(startingSprint.id, updates)}
          onClose={() => setStartingSprintId(null)}
        />
      )}

      <div className="bl-toolbar">
        <input
          type="search"
          className="bl-toolbar__search"
          placeholder="Search backlog"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button type="button" className="bl-btn bl-btn--outline">Filter</button>
        <button type="button" className="bl-btn bl-btn--outline">Epic</button>
        <div style={{ marginLeft: 'auto' }}>
          <button type="button" className="bl-btn bl-btn--primary" onClick={handleCreateSprint}>
            + Create Sprint
          </button>
        </div>
      </div>

      <DragDropContext onDragEnd={onDragEnd}>
        {sortedSprints.map((sprint) => (
          <SprintSection
            key={sprint.id}
            sprint={sprint}
            rootTickets={rootsByBucket[sprint.id] ?? []}
            statsTickets={statsByBucket[sprint.id] ?? []}
            allTickets={filteredTickets}
            collapsedParents={collapsedParents}
            onToggleParentFold={toggleParentFold}
            isCollapsed={collapsed.has(sprint.id)}
            onToggle={() => toggleCollapse(sprint.id)}
            onStartSprint={() => setStartingSprintId(sprint.id)}
            onCompleteSprint={() => handleCompleteSprint(sprint.id)}
            onCreateIssue={() => setCreatingIn(sprint.id)}
            onTicketClick={(id) => openTicket(id)}
            isCreating={creatingIn === sprint.id}
            onSaveIssue={(title) => handleCreateIssue(sprint.id, title)}
            onCancelCreate={() => setCreatingIn(null)}
          />
        ))}

        <BacklogSection
          rootTickets={rootsByBucket['backlog'] ?? []}
          statsTickets={statsByBucket['backlog'] ?? []}
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
