import { useEffect, useMemo, useRef, useState } from 'react';
import type { IssueType, Ticket, TicketPriority, TicketStatus } from '../types/ticket';
import { ISSUE_TYPE_META, PRIORITY_META } from '../types/ticket';
import { collectToolbarAssigneeNames } from '../utils/assigneeDisplay';
import {
  countActiveIssueFilters,
  EMPTY_ISSUE_FILTERS,
  type IssueFilters,
  toggleIssueFilterValue,
  UNASSIGNED_FILTER,
} from '../utils/issueFilters';
import { useSpaces } from '../context/SpaceContext';
import { effectiveSpaceMemberIds } from '../types/space';
import { AssigneeAvatar } from './AssigneeAvatar';
import './IssueFilterPanel.css';

const STATUS_OPTIONS: { value: TicketStatus; label: string }[] = [
  { value: 'planned', label: 'Planned' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'in_review', label: 'In Review' },
  { value: 'done', label: 'Done' },
];

const TYPE_OPTIONS: IssueType[] = ['story', 'task', 'bug', 'subtask'];
/** Show search once the assignee list gets long enough to scroll awkwardly. */
const ASSIGNEE_SEARCH_THRESHOLD = 8;

interface IssueFilterPanelProps {
  tickets: Ticket[];
  filters: IssueFilters;
  onChange: (next: IssueFilters) => void;
  /** Board already has assignee avatar chips — hide that section. */
  hideAssignee?: boolean;
  /** Button class for the trigger (Backlog vs Board toolbar styles). */
  triggerClassName?: string;
}

export function IssueFilterPanel({
  tickets,
  filters,
  onChange,
  hideAssignee = false,
  triggerClassName = 'bl-btn bl-btn--outline',
}: IssueFilterPanelProps) {
  const { currentSpace } = useSpaces();
  const [open, setOpen] = useState(false);
  const [assigneeQuery, setAssigneeQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  const activeCount = useMemo(() => {
    const base = countActiveIssueFilters(filters);
    if (hideAssignee) return base - filters.assignees.length;
    return base;
  }, [filters, hideAssignee]);

  const assigneeOptions = useMemo(() => {
    const { sortedNames, anyUnassigned } = collectToolbarAssigneeNames(tickets, {
      excludeEpics: true,
      spaceMemberIds: effectiveSpaceMemberIds(currentSpace),
    });
    return { sorted: sortedNames, anyUnassigned };
  }, [tickets, currentSpace]);

  const filteredAssigneeNames = useMemo(() => {
    const q = assigneeQuery.trim().toLowerCase();
    if (!q) return assigneeOptions.sorted;
    return assigneeOptions.sorted.filter((n) => n.toLowerCase().includes(q));
  }, [assigneeOptions.sorted, assigneeQuery]);

  const showAssigneeSearch =
    assigneeOptions.sorted.length >= ASSIGNEE_SEARCH_THRESHOLD || assigneeQuery.trim().length > 0;

  const epicOptions = useMemo(
    () =>
      tickets
        .filter((t) => t.issueType === 'epic')
        .map((t) => ({ key: t.id, title: t.title }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    [tickets],
  );

  const priorityOptions = useMemo(() => {
    const present = new Set<TicketPriority>();
    for (const t of tickets) {
      if (t.priority) present.add(t.priority);
    }
    return (Object.keys(PRIORITY_META) as TicketPriority[]).filter((p) => present.has(p));
  }, [tickets]);

  useEffect(() => {
    if (!open) setAssigneeQuery('');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  function clearAll() {
    onChange(hideAssignee ? { ...EMPTY_ISSUE_FILTERS, assignees: filters.assignees } : EMPTY_ISSUE_FILTERS);
  }

  const showUnassignedRow =
    assigneeOptions.anyUnassigned &&
    (!assigneeQuery.trim() || 'unassigned'.includes(assigneeQuery.trim().toLowerCase()));

  return (
    <div className="ifp" ref={rootRef}>
      <button
        type="button"
        className={`${triggerClassName}${activeCount > 0 ? ' ifp__trigger--active' : ''}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
      >
        Filter{activeCount > 0 ? ` (${activeCount})` : ''}
      </button>

      {open && (
        <div className="ifp__panel" role="dialog" aria-label="Issue filters">
          <div className="ifp__header">
            <span className="ifp__title">Filters</span>
            {activeCount > 0 && (
              <button type="button" className="ifp__clear" onClick={clearAll}>
                Clear all
              </button>
            )}
          </div>

          {!hideAssignee && (
            <section className="ifp__section">
              <h3 className="ifp__section-title">
                Assignee
                {filters.assignees.length > 0 && (
                  <span className="ifp__section-count">{filters.assignees.length} selected</span>
                )}
              </h3>
              {showAssigneeSearch && (
                <input
                  type="search"
                  className="ifp__search"
                  placeholder="Search assignees…"
                  aria-label="Search assignees"
                  value={assigneeQuery}
                  onChange={(e) => setAssigneeQuery(e.target.value)}
                />
              )}
              <div className="ifp__list" role="listbox" aria-label="Assignees" aria-multiselectable>
                {showUnassignedRow && (
                  <button
                    type="button"
                    role="option"
                    aria-selected={filters.assignees.includes(UNASSIGNED_FILTER)}
                    className={`ifp__row${filters.assignees.includes(UNASSIGNED_FILTER) ? ' is-on' : ''}`}
                    onClick={() => onChange(toggleIssueFilterValue(filters, 'assignees', UNASSIGNED_FILTER))}
                  >
                    <span className="ifp__row-avatar ifp__row-avatar--muted" aria-hidden>?</span>
                    <span className="ifp__row-name">Unassigned</span>
                  </button>
                )}
                {filteredAssigneeNames.map((name) => {
                  const selected = filters.assignees.includes(name);
                  return (
                    <button
                      key={name}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={`ifp__row${selected ? ' is-on' : ''}`}
                      onClick={() => onChange(toggleIssueFilterValue(filters, 'assignees', name))}
                    >
                      <AssigneeAvatar name={name} size="toolbar" as="div" showHoverTooltip={false} />
                      <span className="ifp__row-name">{name}</span>
                    </button>
                  );
                })}
                {!showUnassignedRow && filteredAssigneeNames.length === 0 && (
                  <span className="ifp__empty">
                    {assigneeOptions.sorted.length === 0 ? 'No assignees yet' : 'No matches'}
                  </span>
                )}
              </div>
            </section>
          )}

          <section className="ifp__section">
            <h3 className="ifp__section-title">Status</h3>
            <div className="ifp__chips">
              {STATUS_OPTIONS.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  className={`ifp__chip${filters.statuses.includes(value) ? ' is-on' : ''}`}
                  onClick={() => onChange(toggleIssueFilterValue(filters, 'statuses', value))}
                >
                  {label}
                </button>
              ))}
            </div>
          </section>

          <section className="ifp__section">
            <h3 className="ifp__section-title">Type</h3>
            <div className="ifp__chips">
              {TYPE_OPTIONS.map((type) => {
                const meta = ISSUE_TYPE_META[type];
                return (
                  <button
                    key={type}
                    type="button"
                    className={`ifp__chip${filters.types.includes(type) ? ' is-on' : ''}`}
                    onClick={() => onChange(toggleIssueFilterValue(filters, 'types', type))}
                  >
                    <span style={{ color: meta.color }} aria-hidden>{meta.icon}</span>
                    {meta.label}
                  </button>
                );
              })}
            </div>
          </section>

          <section className="ifp__section">
            <h3 className="ifp__section-title">Epic</h3>
            <div className="ifp__chips">
              {epicOptions.length === 0 ? (
                <span className="ifp__empty">No epics in this space</span>
              ) : (
                epicOptions.map((epic) => (
                  <button
                    key={epic.key}
                    type="button"
                    className={`ifp__chip ifp__chip--epic${filters.epicKeys.includes(epic.key) ? ' is-on' : ''}`}
                    title={epic.title}
                    onClick={() => onChange(toggleIssueFilterValue(filters, 'epicKeys', epic.key))}
                  >
                    <span style={{ color: ISSUE_TYPE_META.epic.color }} aria-hidden>
                      {ISSUE_TYPE_META.epic.icon}
                    </span>
                    <span className="ifp__epic-key">{epic.key}</span>
                    <span className="ifp__epic-title">{epic.title}</span>
                  </button>
                ))
              )}
            </div>
          </section>

          {priorityOptions.length > 0 && (
            <section className="ifp__section">
              <h3 className="ifp__section-title">Priority</h3>
              <div className="ifp__chips">
                {priorityOptions.map((p) => {
                  const meta = PRIORITY_META[p];
                  return (
                    <button
                      key={p}
                      type="button"
                      className={`ifp__chip${filters.priorities.includes(p) ? ' is-on' : ''}`}
                      onClick={() => onChange(toggleIssueFilterValue(filters, 'priorities', p))}
                    >
                      <span style={{ color: meta.color }} aria-hidden>{meta.icon}</span>
                      {meta.label}
                    </button>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
