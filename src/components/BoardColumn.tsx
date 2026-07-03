import { useMemo } from 'react';
import { Droppable, Draggable } from '@hello-pangea/dnd';
import type { Ticket } from '../types/ticket';
import { getSameStatusSubtasks } from '../utils/ticketHierarchy';
import { buildFlatDragItems, orderRootsBySaved, type FlatDragItem } from '../utils/boardFlatItems';
import { TicketCard } from './TicketCard';

type BoardGroupMode = 'none' | 'assignee' | 'epic' | 'subtask';
interface BoardViewSettings {
  showIssueKey: boolean;
  showDueDate: boolean;
  showEpic: boolean;
  showAssignee: boolean;
  showWorkType: boolean;
  showPriority: boolean;
}

interface BoardColumnProps {
  droppableId: string;
  title: string;
  tickets: Ticket[];
  allTickets: Ticket[];
  epicLookupTickets?: Ticket[];
  /** Parent issue keys with subtasks folded away. */
  collapsedParents: Set<string>;
  onToggleParentFold: (issueKey: string) => void;
  /** When true, nested subtasks are not shown on the board (only inside issue detail). */
  hideSubtasksOnBoard: boolean;
  viewSettings: BoardViewSettings;
  groupMode?: BoardGroupMode;
  getGroupLabel?: (ticket: Ticket) => string;
  isDone?: boolean;
  onCreateClick: () => void;
  onTicketClick: (ticketId: string) => void;
  /** Persisted draggable order for this column (Group = none only). */
  savedFlatOrder?: string[];
}

function epicKeyForTicket(
  ticket: Ticket,
  epicLookupTickets: Ticket[] | undefined,
  allTickets: Ticket[],
): string | undefined {
  const pool = epicLookupTickets ?? allTickets;
  if (ticket.parentId) {
    const epic = pool.find((t) => t.id === ticket.parentId && t.issueType === 'epic');
    if (epic) return epic.id;
    const parent = allTickets.find((t) => t.id === ticket.parentId);
    if (parent?.parentId) {
      const epicViaParent = pool.find((t) => t.id === parent.parentId && t.issueType === 'epic');
      if (epicViaParent) return epicViaParent.id;
    }
  }
  return undefined;
}

function renderDraggableCard(
  item: FlatDragItem,
  index: number,
  allTickets: Ticket[],
  epicLookupTickets: Ticket[] | undefined,
  collapsedParents: Set<string>,
  hideSubtasksOnBoard: boolean,
  viewSettings: BoardViewSettings,
  onToggleParentFold: (issueKey: string) => void,
  onTicketClick: (ticketId: string) => void,
) {
  if (item.kind === 'parent') {
    const ticket = item.ticket;
    const nested = getSameStatusSubtasks(ticket, allTickets);
    const epicKey = epicKeyForTicket(ticket, epicLookupTickets, allTickets);
    const subtasksCollapsed = collapsedParents.has(ticket.id);
    const showFold = !hideSubtasksOnBoard && nested.length > 0;
    return (
      <Draggable key={ticket.id} draggableId={ticket.id} index={index}>
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.draggableProps}
            className={snapshot.isDragging ? 'board-column__card-wrapper board-column__card-wrapper--dragging' : 'board-column__card-wrapper'}
            style={provided.draggableProps.style}
          >
            <div className="board-column__parent-row">
              <div className="board-column__fold-slot">
                {showFold ? (
                  <button
                    type="button"
                    className="board-column__fold"
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleParentFold(ticket.id);
                    }}
                    aria-expanded={!subtasksCollapsed}
                    aria-label={subtasksCollapsed ? 'Expand subtasks' : 'Collapse subtasks'}
                  >
                    <span
                      className={`board-column__fold-chevron ${subtasksCollapsed ? '' : 'board-column__fold-chevron--open'}`}
                      aria-hidden
                    >
                      ▶
                    </span>
                  </button>
                ) : null}
              </div>
              <div className="board-column__card-main" {...provided.dragHandleProps}>
                <TicketCard
                  ticket={ticket}
                  variant="parent"
                  hiddenChildCount={hideSubtasksOnBoard && nested.length > 0 ? nested.length : undefined}
                  showIssueKey={viewSettings.showIssueKey}
                  showDueDate={viewSettings.showDueDate}
                  showAssignee={viewSettings.showAssignee}
                  showWorkType={viewSettings.showWorkType}
                  showPriority={viewSettings.showPriority}
                  epicKey={epicKey}
                  showEpic={viewSettings.showEpic}
                  onClick={() => onTicketClick(ticket.id)}
                />
              </div>
            </div>
          </div>
        )}
      </Draggable>
    );
  }

  if (item.kind === 'nested-sub') {
    const sub = item.ticket;
    const epicKey = epicKeyForTicket(sub, epicLookupTickets, allTickets);
    const nestedKids = getSameStatusSubtasks(sub, allTickets);
    const subtasksCollapsed = collapsedParents.has(sub.id);
    const showFold = !hideSubtasksOnBoard && nestedKids.length > 0;
    const depthPx = Math.max(0, item.depth - 1) * 12;
    return (
      <Draggable key={sub.id} draggableId={sub.id} index={index}>
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.draggableProps}
            className={
              snapshot.isDragging
                ? 'board-column__card-wrapper board-column__card-wrapper--dragging board-column__card-wrapper--nested'
                : 'board-column__card-wrapper board-column__card-wrapper--nested'
            }
            style={{
              ...provided.draggableProps.style,
              marginLeft: depthPx > 0 ? depthPx : undefined,
            }}
          >
            <div className="board-column__subtask-row">
              <div className="board-column__fold-slot">
                {showFold ? (
                  <button
                    type="button"
                    className="board-column__fold"
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleParentFold(sub.id);
                    }}
                    aria-expanded={!subtasksCollapsed}
                    aria-label={subtasksCollapsed ? 'Expand subtasks' : 'Collapse subtasks'}
                  >
                    <span
                      className={`board-column__fold-chevron ${subtasksCollapsed ? '' : 'board-column__fold-chevron--open'}`}
                      aria-hidden
                    >
                      ▶
                    </span>
                  </button>
                ) : (
                  <span aria-hidden className="board-column__fold-placeholder" />
                )}
              </div>
              <div className="board-column__subtask-card-wrap" {...provided.dragHandleProps}>
                <TicketCard
                  ticket={sub}
                  variant="subtask"
                  showIssueKey={viewSettings.showIssueKey}
                  showDueDate={viewSettings.showDueDate}
                  showAssignee={viewSettings.showAssignee}
                  showWorkType={viewSettings.showWorkType}
                  showPriority={viewSettings.showPriority}
                  epicKey={epicKey}
                  showEpic={viewSettings.showEpic}
                  onClick={() => onTicketClick(sub.id)}
                />
              </div>
            </div>
          </div>
        )}
      </Draggable>
    );
  }

  const sub = item.ticket;
  const parentKey = sub.parentId ?? '';
  const epicKey = epicKeyForTicket(sub, epicLookupTickets, allTickets);
  return (
    <Draggable key={sub.id} draggableId={sub.id} index={index}>
      {(provided, snapshot) => (
        <div
          ref={provided.innerRef}
          {...provided.draggableProps}
          className={
            snapshot.isDragging
              ? 'board-column__card-wrapper board-column__card-wrapper--dragging board-column__card-wrapper--detached-sub'
              : 'board-column__card-wrapper board-column__card-wrapper--detached-sub'
          }
          style={provided.draggableProps.style}
        >
          <div className="board-column__subtask-row">
            <div className="board-column__fold-slot" aria-hidden />
            <div className="board-column__subtask-card-wrap" {...provided.dragHandleProps}>
              <TicketCard
                ticket={sub}
                variant="subtask"
                parentIssueKey={parentKey || undefined}
                showIssueKey={viewSettings.showIssueKey}
                showDueDate={viewSettings.showDueDate}
                showAssignee={viewSettings.showAssignee}
                showWorkType={viewSettings.showWorkType}
                showPriority={viewSettings.showPriority}
                epicKey={epicKey}
                showEpic={viewSettings.showEpic}
                onClick={() => onTicketClick(sub.id)}
              />
            </div>
          </div>
        </div>
      )}
    </Draggable>
  );
}

export function BoardColumn({
  droppableId,
  title,
  tickets,
  allTickets,
  epicLookupTickets,
  collapsedParents,
  onToggleParentFold,
  hideSubtasksOnBoard,
  viewSettings,
  groupMode = 'none',
  getGroupLabel,
  isDone,
  onCreateClick,
  onTicketClick,
  savedFlatOrder,
}: BoardColumnProps) {
  const sections = useMemo(() => {
    if (groupMode === 'none' || !getGroupLabel) return [{ label: '', tickets }];
    const map = new Map<string, Ticket[]>();
    for (const ticket of tickets) {
      const label = getGroupLabel(ticket);
      const arr = map.get(label) ?? [];
      arr.push(ticket);
      map.set(label, arr);
    }
    const entries = Array.from(map.entries());
    if (groupMode === 'assignee') {
      entries.sort(([a], [b]) => {
        const aUnassigned = a.toLowerCase() === 'unassigned';
        const bUnassigned = b.toLowerCase() === 'unassigned';
        if (aUnassigned && !bUnassigned) return 1;
        if (!aUnassigned && bUnassigned) return -1;
        return a.localeCompare(b);
      });
    } else if (groupMode === 'subtask') {
      entries.sort(([a], [b]) => {
        const aNoSubtasks = a.toLowerCase() === 'no subtasks';
        const bNoSubtasks = b.toLowerCase() === 'no subtasks';
        if (aNoSubtasks && !bNoSubtasks) return 1;
        if (!aNoSubtasks && bNoSubtasks) return -1;
        return a.localeCompare(b);
      });
    }
    return entries.map(([label, ts]) => ({ label, tickets: ts }));
  }, [tickets, groupMode, getGroupLabel]);

  const sectionOrderedFlats = useMemo(() => {
    return sections.map((section) => {
      const orderedRoots = orderRootsBySaved(section.tickets, savedFlatOrder);
      return buildFlatDragItems(orderedRoots, allTickets, collapsedParents, hideSubtasksOnBoard);
    });
  }, [sections, allTickets, collapsedParents, hideSubtasksOnBoard, savedFlatOrder]);

  const sectionOffsets = useMemo(() => {
    const offsets: number[] = [];
    let acc = 0;
    for (let i = 0; i < sectionOrderedFlats.length; i++) {
      offsets.push(acc);
      acc += sectionOrderedFlats[i].length;
    }
    return offsets;
  }, [sectionOrderedFlats]);

  return (
    <section className="board-column" data-status={droppableId}>
      <h2 className="board-column__title">
        {title}
        {isDone && <span className="board-column__done-mark" aria-hidden>✓</span>}
      </h2>
      <Droppable droppableId={droppableId}>
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            className={`board-column__cards ${snapshot.isDraggingOver ? 'board-column__cards--dragging' : ''}`}
          >
            {sections.map((section, sectionIdx) => {
              const flatItems = sectionOrderedFlats[sectionIdx];
              const offset = sectionOffsets[sectionIdx];
              return (
                <div key={section.label || `section-${sectionIdx}`}>
                  {section.label && <p className="board-column__group-label">{section.label}</p>}
                  {flatItems.map((item, i) =>
                    renderDraggableCard(
                      item,
                      offset + i,
                      allTickets,
                      epicLookupTickets,
                      collapsedParents,
                      hideSubtasksOnBoard,
                      viewSettings,
                      onToggleParentFold,
                      onTicketClick,
                    ),
                  )}
                </div>
              );
            })}
            {provided.placeholder}
            <button type="button" className="board-column__create" onClick={onCreateClick}>
              + Create
            </button>
          </div>
        )}
      </Droppable>
    </section>
  );
}
