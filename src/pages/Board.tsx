import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DragDropContext, type DropResult } from '@hello-pangea/dnd';
import { BoardAssigneeFilter } from '../components/BoardAssigneeFilter';
import { BoardColumn } from '../components/BoardColumn';
import { CreateTaskModal } from '../components/CreateTaskModal';
import { TicketDetailModal } from '../components/TicketDetailModal';
import { useTickets } from '../context/TicketContext';
import { useSpaces } from '../context/SpaceContext';
import { useCurrentUser } from '../context/UserContext';
import type { Ticket, TicketStatus } from '../types/ticket';
import {
  arrayMove,
  buildFlatDragItems,
  countRootsBeforeFlatIndex,
  mergeSavedFlatOrder,
  orderRootsBySaved,
  groupTicketsByBoardColumn,
} from '../utils/boardFlatItems';
import { primaryAssigneeName, ticketMatchesAssigneeFilter } from '../utils/assigneeDisplay';
import './Board.css';

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
type InsightAttentionTab = 'all' | 'due' | 'stuck' | 'blocked' | 'flagged';
interface BoardViewSettings {
  showIssueKey: boolean;
  showDueDate: boolean;
  showEpic: boolean;
  showAssignee: boolean;
  showWorkType: boolean;
  showPriority: boolean;
}

const COLUMNS: { status: TicketStatus; title: string; isDone?: boolean }[] = [
  { status: 'planned', title: 'PLANNED' },
  { status: 'in_progress', title: 'IN PROGRESS' },
  { status: 'blocked', title: 'BLOCKED' },
  { status: 'in_review', title: 'IN REVIEW' },
  { status: 'done', title: 'DONE', isDone: true },
];

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

export function Board() {
  const {
    tickets, sprints, nextId, addTicket, updateTicket, updateTicketStatus, createSubtask,
    completeSprint, deleteTicket, addComment, editComment, deleteComment, addIssueLink, deleteIssueLink,
    addCodeLink, deleteCodeLink, refreshCodeLinks, hydrateIssueDetail,
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
  const [assigneeFilter, setAssigneeFilter] = useState<string | null>(null);
  useEffect(() => {
    setAssigneeFilter(null);
  }, [activeSprint?.id]);
  const filteredBoardTickets = useMemo(
    () => boardTickets.filter((t) => ticketMatchesAssigneeFilter(t, assigneeFilter)),
    [boardTickets, assigneeFilter],
  );
  const displayTicketsByStatus = useMemo(
    () => groupTicketsByBoardColumn(filteredBoardTickets),
    [filteredBoardTickets],
  );
  const boardAssigneeNames = useMemo(() => {
    const names = new Set<string>();
    let anyUnassigned = false;
    for (const t of boardTickets) {
      const p = primaryAssigneeName(t);
      if (p) names.add(p);
      else anyUnassigned = true;
    }
    const sorted = Array.from(names).sort((a, b) => a.localeCompare(b));
    return { sortedNames: sorted, anyUnassigned };
  }, [boardTickets]);
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
      if (!raw) return { showIssueKey: true, showDueDate: true, showEpic: true, showAssignee: true, showWorkType: true, showPriority: true };
      const parsed = JSON.parse(raw) as Partial<BoardViewSettings>;
      return {
        showIssueKey: parsed.showIssueKey ?? true,
        showDueDate: parsed.showDueDate ?? true,
        showEpic: parsed.showEpic ?? true,
        showAssignee: parsed.showAssignee ?? true,
        showWorkType: parsed.showWorkType ?? true,
        showPriority: parsed.showPriority ?? true,
      };
    } catch {
      return { showIssueKey: true, showDueDate: true, showEpic: true, showAssignee: true, showWorkType: true, showPriority: true };
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
  const [viewSettingsOpen, setViewSettingsOpen] = useState(false);
  const [attentionTab, setAttentionTab] = useState<InsightAttentionTab>('all');
  const groupMenuRef = useRef<HTMLDivElement>(null);
  const sprintDetailRef = useRef<HTMLDivElement>(null);
  const viewSettingsRef = useRef<HTMLDivElement>(null);
  const prevBoardOrderSprintKeyRef = useRef<string>('');
  const boardOrderSprintKey = activeSprint ? `${currentSpace.id}:${activeSprint.id}` : '';
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedTicketId = searchParams.get('ticket');
  const selectedTicket = useMemo(() => boardTickets.find((t) => t.id === selectedTicketId) ?? null, [boardTickets, selectedTicketId]);

  useEffect(() => {
    if (!selectedTicketId) return;
    void hydrateIssueDetail(selectedTicketId);
  }, [selectedTicketId, hydrateIssueDetail]);
  const sprintSummaries = useMemo(() => {
    const ordered = [
      ...sprints.filter((s) => s.status === 'active'),
      ...sprints.filter((s) => s.status === 'future'),
      ...sprints.filter((s) => s.status === 'completed'),
    ];
    return ordered.map((sprint) => ({
      ...sprint,
      issueCount: tickets.filter((t) => t.sprintId === sprint.id).length,
      timeLabel: sprint.status === 'completed' ? 'Completed' : sprintTimeLabel(sprint.endDate),
    }));
  }, [sprints, tickets]);
  const activeSprintIssues = useMemo(
    () => (activeSprint ? tickets.filter((t) => t.sprintId === activeSprint.id) : []),
    [tickets, activeSprint],
  );
  const overdueIssues = useMemo(() => {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    return activeSprintIssues.filter((t) => {
      if (!t.dueDate || t.status === 'done') return false;
      const d = new Date(t.dueDate);
      if (Number.isNaN(d.getTime())) return false;
      d.setHours(0, 0, 0, 0);
      return d < now;
    });
  }, [activeSprintIssues]);
  const attentionIssues = useMemo(() => {
    if (attentionTab === 'all') return overdueIssues;
    if (attentionTab === 'due') return overdueIssues;
    if (attentionTab === 'blocked') return activeSprintIssues.filter((t) => t.status === 'blocked');
    if (attentionTab === 'stuck') return activeSprintIssues.filter((t) => t.status === 'in_review');
    return activeSprintIssues.filter((t) => (t.labels ?? []).includes('Bug'));
  }, [attentionTab, overdueIssues, activeSprintIssues]);
  const doneCount = useMemo(
    () => activeSprintIssues.filter((t) => t.status === 'done').length,
    [activeSprintIssues],
  );
  const estimatedCount = useMemo(
    () => activeSprintIssues.filter((t) => (t.storyPoints ?? 0) > 0).length,
    [activeSprintIssues],
  );
  const epicLinkedCount = useMemo(
    () => activeSprintIssues.filter((t) => Boolean(t.parentId)).length,
    [activeSprintIssues],
  );

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

  function closeTicketModal() {
    setSearchParams({}, { replace: false });
  }

  useEffect(() => {
    const param = searchParams.get('ticket');
    if (param && !boardTickets.find((t) => t.id === param)) {
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, boardTickets, setSearchParams]);

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
      const epic = ticket.parentId ? tickets.find((t) => t.id === ticket.parentId && t.issueType === 'epic') : null;
      return epic ? `${epic.id}` : 'No epic';
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
      updateTicketStatus(draggableId, destCol);
      return;
    }

    if (groupMode !== 'none' || !activeSprint) return;
    if (assigneeFilter !== null) return;

    const roots = fullTicketsByStatus[srcCol];
    const orderedRoots = orderRootsBySaved(roots, columnFlatOrders[srcCol]);
    const flat = buildFlatDragItems(orderedRoots, boardTickets, collapsedParents, hideSubtasksOnBoard);
    const rootIds = orderedRoots.map((t) => t.id);
    const sourceRootIdx = rootIds.indexOf(draggableId);
    if (sourceRootIdx === -1) return;

    const destRootIdx = countRootsBeforeFlatIndex(flat, destination.index);
    const newRootIds = arrayMove(rootIds, sourceRootIdx, destRootIdx);
    setColumnFlatOrders((prev) => ({ ...prev, [srcCol]: newRootIds }));
  }, [updateTicketStatus, groupMode, activeSprint, assigneeFilter, fullTicketsByStatus, boardTickets, collapsedParents, hideSubtasksOnBoard, columnFlatOrders]);

  const handleCreateConfirm = useCallback((ticket: Ticket) => {
    addTicket(ticket);
    setModalStatus(null);
  }, [addTicket]);

  const handleTicketUpdate = useCallback((updated: Ticket) => {
    updateTicket(updated);
  }, [updateTicket]);

  const handleCreateSubtask = useCallback((parentId: string, title: string) => {
    createSubtask(parentId, title);
  }, [createSubtask]);

  const handleCompleteSprint = useCallback(() => {
    const activeSprint = sprints.find((s) => s.status === 'active');
    if (!activeSprint) {
      alert('No active sprint to complete. Start a sprint from Backlog first.');
      return;
    }
    if (!confirm(`Complete ${activeSprint.name}? Incomplete issues will move to the backlog.`)) return;
    completeSprint(activeSprint.id);
  }, [sprints, completeSprint]);

  return (
    <>
      {modalStatus !== null && (
        <CreateTaskModal
          initialStatus={modalStatus}
          nextId={nextId}
          allowedIssueTypes={['story', 'task', 'bug']}
          onConfirm={handleCreateConfirm}
          onClose={() => setModalStatus(null)}
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
          <input type="search" placeholder="Search board" className="board-toolbar__search" aria-label="Search board" />
          <BoardAssigneeFilter
            sortedNames={boardAssigneeNames.sortedNames}
            anyUnassigned={boardAssigneeNames.anyUnassigned}
            assigneeFilter={assigneeFilter}
            onAssigneeFilterChange={setAssigneeFilter}
          />
          <button type="button" className="board-toolbar__filter">Filter</button>
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
              <button
                type="button"
                className="board-toolbar__icon"
                aria-label="Sprint details"
                title="Sprint details"
                aria-expanded={sprintDetailOpen}
                onClick={() => setSprintDetailOpen((v) => !v)}
              >
                <IconSprintDetails />
              </button>
              {sprintDetailOpen && (
              <div className="board-sprint-detail">
                <p className="board-sprint-detail__title">Sprints {sprintSummaries.length} total</p>
                <div className="board-sprint-detail__list">
                  {sprintSummaries.length === 0 && (
                    <p className="board-sprint-detail__empty">No sprints yet.</p>
                  )}
                  {sprintSummaries.map((sprint) => (
                    <div key={sprint.id} className="board-sprint-detail__item">
                      <div className="board-sprint-detail__name-row">
                        <span className="board-sprint-detail__name">{sprint.name}</span>
                        <span className={`board-sprint-detail__status board-sprint-detail__status--${sprint.status}`}>
                          {sprint.status}
                        </span>
                      </div>
                      <p className="board-sprint-detail__meta">{sprint.timeLabel}</p>
                      <p className="board-sprint-detail__meta">{sprint.issueCount} issue{sprint.issueCount !== 1 ? 's' : ''}</p>
                    </div>
                  ))}
                </div>
              </div>
              )}
            </div>
            <div className="board-toolbar__group-wrap" ref={groupMenuRef}>
              <button
                type="button"
                className="board-toolbar__group"
                onClick={() => setGroupMenuOpen((v) => !v)}
                aria-expanded={groupMenuOpen}
              >
                Group ▾
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
            <button
              type="button"
              className={`board-toolbar__icon ${sprintInsightsOpen ? 'board-toolbar__icon--active' : ''}`}
              aria-label="Sprint insights"
              title="Sprint insights"
              onClick={() => setSprintInsightsOpen((v) => !v)}
            >
              <IconSprintInsights />
            </button>
            <div className="board-toolbar__view-settings-wrap" ref={viewSettingsRef}>
              <button
                type="button"
                className={`board-toolbar__icon ${viewSettingsOpen ? 'board-toolbar__icon--active' : ''}`}
                aria-label="View settings"
                title="View settings"
                onClick={() => setViewSettingsOpen((v) => !v)}
              >
                <IconViewSettings />
              </button>
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
          <button type="button" className="board__add-column" aria-label="Add column">+</button>
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
            <section className="board-insights__card">
              <h4>Work items for attention</h4>
              <div className="board-insights__tabs">
                {(['all', 'due', 'stuck', 'blocked', 'flagged'] as InsightAttentionTab[]).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    className={`board-insights__tab ${attentionTab === tab ? 'is-active' : ''}`}
                    onClick={() => setAttentionTab(tab)}
                  >
                    {tab}
                  </button>
                ))}
              </div>
              <p className="board-insights__note">{attentionIssues.length} work item(s) match this filter.</p>
              <div className="board-insights__list">
                {attentionIssues.length === 0 && <p className="board-insights__empty">No items.</p>}
                {attentionIssues.slice(0, 4).map((t) => (
                  <div key={t.id} className="board-insights__item">
                    <span className="board-insights__item-key">{t.id}</span>
                    <span className="board-insights__item-title">{t.title}</span>
                  </div>
                ))}
              </div>
            </section>
            <section className="board-insights__card">
              <h4>Sprint progress</h4>
              <p className="board-insights__metric">{doneCount}/{activeSprintIssues.length} done</p>
            </section>
            <section className="board-insights__card">
              <h4>Sprint burndown</h4>
              <p className="board-insights__metric">{estimatedCount} estimated, {activeSprintIssues.length - estimatedCount} unestimated</p>
            </section>
            <section className="board-insights__card">
              <h4>Epic progress</h4>
              <p className="board-insights__metric">{epicLinkedCount} issue(s) linked to an epic</p>
            </section>
          </aside>
        )}
      </div>
    </>
  );
}
