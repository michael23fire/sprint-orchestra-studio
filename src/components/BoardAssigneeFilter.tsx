import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AssigneeAvatar } from './AssigneeAvatar';
import {
  BOARD_ASSIGNEE_FILTER_UNASSIGNED,
  partitionAssigneesForToolbar,
  toggleAssigneeFilter,
} from '../utils/assigneeDisplay';
import './BoardAssigneeFilter.css';
import './AssigneeAvatar.css';
const MAX_INLINE_ASSIGNEES = 6;

function IconAssigneeAll() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.75" />
      <path stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" d="M5 20v-1c0-2.5 2-4.5 7-4.5s7 2 7 4.5v1" />
    </svg>
  );
}

interface BoardAssigneeFilterProps {
  sortedNames: string[];
  /** @deprecated Always shows Unassigned; kept for call-site compatibility. */
  anyUnassigned?: boolean;
  /** Empty = all assignees. Non-empty = multi-select OR filter. */
  assigneeFilter: string[];
  onAssigneeFilterChange: (next: string[]) => void;
}

export function BoardAssigneeFilter({
  sortedNames,
  assigneeFilter,
  onAssigneeFilterChange,
}: BoardAssigneeFilterProps) {
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  const noneSelected = assigneeFilter.length === 0;
  const unassignedActive = assigneeFilter.includes(BOARD_ASSIGNEE_FILTER_UNASSIGNED);

  const { inline, overflow } = useMemo(
    () => partitionAssigneesForToolbar(sortedNames, MAX_INLINE_ASSIGNEES, assigneeFilter),
    [sortedNames, assigneeFilter],
  );

  const pickerNames = useMemo(() => {
    if (!overflowOpen) return [];
    const q = pickerQuery.trim().toLowerCase();
    if (q) return sortedNames.filter((n) => n.toLowerCase().includes(q));
    return overflow;
  }, [overflowOpen, pickerQuery, sortedNames, overflow]);

  useEffect(() => {
    if (!overflowOpen) setPickerQuery('');
  }, [overflowOpen]);

  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      const el = wrapRef.current;
      if (!el || !overflowOpen) return;
      if (!el.contains(e.target as Node)) setOverflowOpen(false);
    }
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [overflowOpen]);

  const pickAssignee = useCallback(
    (name: string, { keepPickerOpen = false }: { keepPickerOpen?: boolean } = {}) => {
      onAssigneeFilterChange(toggleAssigneeFilter(assigneeFilter, name));
      if (!keepPickerOpen) setOverflowOpen(false);
    },
    [assigneeFilter, onAssigneeFilterChange],
  );

  const overflowCount = overflow.length;

  return (
    <div className="board-toolbar__assignee-filter" role="group" aria-label="Filter by assignee" ref={wrapRef}>
      <span className="hover-tip-host">
        <button
          type="button"
          className={`board-toolbar__assignee-chip board-toolbar__assignee-chip--all ${noneSelected ? 'is-active' : ''}`}
          title="All assignees"
          aria-label="All assignees"
          aria-pressed={noneSelected}
          onClick={() => {
            onAssigneeFilterChange([]);
            setOverflowOpen(false);
          }}
        >
          <IconAssigneeAll />
        </button>
        <span className="hover-tip__popup" role="tooltip">
          All assignees
        </span>
      </span>
      <span className="hover-tip-host">
        <button
          type="button"
          className={`board-toolbar__assignee-chip ${unassignedActive ? 'is-active' : ''}`}
          title="Unassigned"
          aria-label="Unassigned"
          aria-pressed={unassignedActive}
          onClick={() => {
            onAssigneeFilterChange(toggleAssigneeFilter(assigneeFilter, BOARD_ASSIGNEE_FILTER_UNASSIGNED));
            setOverflowOpen(false);
          }}
        >
          <span className="board-toolbar__assignee-chip-inner board-toolbar__assignee-chip-inner--muted">?</span>
        </button>
        <span className="hover-tip__popup" role="tooltip">
          Unassigned
        </span>
      </span>
      {inline.map((name) => {
        const active = assigneeFilter.includes(name);
        return (
          <AssigneeAvatar
            key={name}
            name={name}
            size="toolbar"
            as="button"
            isActive={active}
            aria-pressed={active}
            aria-label={`Assignee ${name}`}
            onClick={() => pickAssignee(name)}
          />
        );
      })}
      {overflowCount > 0 && (
        <div className="board-toolbar__assignee-overflow">
          <button
            type="button"
            className={`board-toolbar__assignee-more ${overflowOpen ? 'is-open' : ''}`}
            aria-expanded={overflowOpen}
            aria-haspopup="listbox"
            title={`${overflowCount} more assignees`}
            onClick={() => setOverflowOpen((o) => !o)}
          >
            +{overflowCount}
          </button>
          {overflowOpen && (
            <div className="board-toolbar__assignee-picker" role="listbox" aria-label="More assignees" aria-multiselectable="true">
              <input
                type="search"
                className="board-toolbar__assignee-picker-search"
                placeholder="Search assignees…"
                aria-label="Search assignees"
                value={pickerQuery}
                onChange={(e) => setPickerQuery(e.target.value)}
                autoFocus
              />
              <div className="board-toolbar__assignee-picker-list">
                {pickerNames.length === 0 && (
                  <p className="board-toolbar__assignee-picker-empty">No matches.</p>
                )}
                {pickerNames.map((name) => {
                  const active = assigneeFilter.includes(name);
                  return (
                    <button
                      key={name}
                      type="button"
                      role="option"
                      aria-selected={active}
                      className={`board-toolbar__assignee-picker-row ${active ? 'is-selected' : ''}`}
                      onClick={() => pickAssignee(name, { keepPickerOpen: true })}
                    >
                      <AssigneeAvatar name={name} size="toolbar" as="div" showHoverTooltip={false} />
                      <span className="board-toolbar__assignee-picker-name">{name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
