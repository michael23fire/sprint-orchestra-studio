import { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { TicketDetailModal } from '../components/TicketDetailModal';
import { useTickets } from '../context/TicketContext';
import { useSpaces } from '../context/SpaceContext';
import { useCurrentUser } from '../context/UserContext';
import type { Ticket, IssueType, TicketStatus } from '../types/ticket';
import { ISSUE_TYPE_META } from '../types/ticket';
import { getDescendantKeys, resolveEpicKey } from '../utils/ticketHierarchy';
import './Timeline.css';

const DAY_MS = 86400000;
const LABEL_COL = 360; // keep in sync with Timeline.css label/header widths
type Scale = 'weeks' | 'months';
type TimelineStatusCategory = 'planned' | 'in_progress' | 'done';

const SPRINT_STATUS_BADGE: Record<string, { label: string; className: string }> = {
  active: { label: 'Active sprint', className: 'is-active' },
  future: { label: 'Future sprint', className: 'is-future' },
  completed: { label: 'Completed sprint', className: 'is-completed' },
};

const STATUS_OPTIONS: { value: TicketStatus; label: string; color: string }[] = [
  { value: 'planned', label: 'Planned', color: '#8b5cf6' },
  { value: 'in_progress', label: 'In progress', color: '#3b82f6' },
  { value: 'blocked', label: 'Blocked', color: '#ef4444' },
  { value: 'in_review', label: 'In review', color: '#f59e0b' },
  { value: 'done', label: 'Done', color: '#10b981' },
];
const STATUS_CATEGORY_OPTIONS: Array<{ value: TimelineStatusCategory; label: string; color: string }> = [
  { value: 'planned', label: 'Planned', color: '#8b5cf6' },
  { value: 'in_progress', label: 'In progress', color: '#3b82f6' },
  { value: 'done', label: 'Done', color: '#10b981' },
];

function timelineStatusCategory(status: TicketStatus): TimelineStatusCategory {
  if (status === 'done') return 'done';
  if (status === 'planned') return 'planned';
  return 'in_progress';
}
interface TimelineViewSettings {
  showSprints: boolean;
  showIssueType: boolean;
  showIssueKey: boolean;
  showStatus: boolean;
}

function startOfDay(d: Date): Date {
  const t = new Date(d);
  t.setHours(0, 0, 0, 0);
  return t;
}

function parseDate(input?: string): Date | null {
  if (!input) return null;
  // Date-only strings (e.g. "2026-07-08" from <input type="date">) must be
  // parsed as *local* dates; new Date(str) would treat them as UTC midnight,
  // shifting them a day earlier in negative-offset timezones.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  const d = m
    ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    : new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return startOfDay(d);
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateRange(start: Date, end: Date): string {
  return `${formatDate(start)} – ${formatDate(end)}`;
}

function issueBarRange(issue: Ticket): { start: Date; end: Date } | null {
  const start = parseDate(issue.startDate);
  const due = parseDate(issue.dueDate);
  if (start && due) return { start, end: due };
  if (start) return { start, end: new Date(start.getTime() + 7 * DAY_MS) };
  if (due) return { start: due, end: due };
  // No dates at all: like Jira, render no schedule bar.
  return null;
}

/** Jira's default Timeline order is Rank; issue key keeps equal ranks stable. */
function compareTimelineRank(a: Ticket, b: Ticket): number {
  const rankDifference = (a.issueOrder ?? 0) - (b.issueOrder ?? 0);
  if (rankDifference !== 0) return rankDifference;
  return a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: 'base' });
}

export function Timeline() {
  const { currentUser } = useCurrentUser();
  const { currentSpace } = useSpaces();
  const {
    tickets,
    sprints,
    updateTicket,
    createSubtask,
    deleteTicket,
    addComment,
    editComment,
    deleteComment,
    addIssueLink,
    deleteIssueLink,
    addCodeLink,
    deleteCodeLink,
    refreshCodeLinks,
    hydrateIssueDetail,
  } = useTickets();
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [selectedEpicIds, setSelectedEpicIds] = useState<string[]>([]);
  const [epicMenuOpen, setEpicMenuOpen] = useState(false);
  const [selectedTypes, setSelectedTypes] = useState<IssueType[]>([]);
  const [typeMenuOpen, setTypeMenuOpen] = useState(false);
  const [selectedStatuses, setSelectedStatuses] = useState<TimelineStatusCategory[]>([]);
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const [scale, setScale] = useState<Scale>('weeks');
  const [collapsedEpics, setCollapsedEpics] = useState<Set<string>>(() => new Set());
  const collapseScopeRef = useRef<string | null>(null);
  const initializedCollapseGroupsRef = useRef<Set<string>>(new Set());
  const [viewOpen, setViewOpen] = useState(false);
  const [view, setView] = useState<TimelineViewSettings>({
    showSprints: true,
    showIssueType: true,
    showIssueKey: true,
    showStatus: true,
  });
  const [openSprintId, setOpenSprintId] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const epicFilterRef = useRef<HTMLDivElement>(null);
  const typeFilterRef = useRef<HTMLDivElement>(null);
  const statusFilterRef = useRef<HTMLDivElement>(null);
  const sprintLaneRef = useRef<HTMLDivElement>(null);

  const selectedTicketId = searchParams.get('ticket');
  const selectedTicket = useMemo(
    () => tickets.find((t) => t.id === selectedTicketId) ?? null,
    [tickets, selectedTicketId],
  );

  useEffect(() => {
    if (!selectedTicketId) return;
    void hydrateIssueDetail(selectedTicketId);
  }, [selectedTicketId, hydrateIssueDetail]);

  function openTicket(id: string) {
    setSearchParams({ ticket: id });
  }

  function closeTicket() {
    setSearchParams({});
  }
  const roots = useMemo(() => tickets.filter((t) => t.issueType !== 'subtask'), [tickets]);
  const epics = useMemo(
    () => tickets.filter((t) => t.issueType === 'epic').sort(compareTimelineRank),
    [tickets],
  );
  const pixelsPerDay = scale === 'weeks' ? 28 : 14;

  // Jira's timeline always spans exactly 1 year back and 2 years ahead of
  // today; the whole window is scrollable, anything outside it is not shown.
  const bounds = useMemo(() => {
    const today = startOfDay(new Date());
    return {
      min: startOfDay(new Date(today.getFullYear() - 1, today.getMonth(), today.getDate())),
      max: startOfDay(new Date(today.getFullYear() + 2, today.getMonth(), today.getDate())),
    };
  }, []);

  const days = useMemo(() => {
    const result: Date[] = [];
    const cursor = new Date(bounds.min);
    while (cursor.getTime() <= bounds.max.getTime()) {
      result.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    return result;
  }, [bounds]);
  const totalDays = Math.max(1, Math.round((bounds.max.getTime() - bounds.min.getTime()) / DAY_MS));
  // The "track" portion of the canvas (where bars / today line / dates live).
  const trackWidth = Math.max(800, totalDays * pixelsPerDay);
  // Actual rendered width of one day (differs from pixelsPerDay when the
  // 800px minimum kicks in); keeps header day cells aligned with bars.
  const dayWidth = trackWidth / totalDays;
  // Full canvas width = label column + the time-track on its right.
  const canvasWidth = LABEL_COL + trackWidth;

  const sprintItems = useMemo(() => {
    return sprints
      .map((s) => {
        const start = parseDate(s.startDate);
        const end = parseDate(s.endDate);
        return {
          id: `s-${s.id}`,
          label: s.name,
          goal: s.goal,
          status: s.status,
          start,
          end,
          hasDates: Boolean(start && end),
        };
      })
      .sort((a, b) => {
        const at = a.start?.getTime() ?? Number.MAX_SAFE_INTEGER;
        const bt = b.start?.getTime() ?? Number.MAX_SAFE_INTEGER;
        return at - bt;
      });
  }, [sprints]);

  const filteredRoots = useMemo(() => {
    const q = query.trim().toLowerCase();
    const epicActive = selectedEpicIds.length > 0;
    return roots.filter((t) => {
      if (epicActive) {
        const epicKey = resolveEpicKey(t, tickets);
        if (!epicKey || !selectedEpicIds.includes(epicKey)) return false;
      }
      // Empty type selection = show all types.
      if (selectedTypes.length > 0 && !selectedTypes.includes(t.issueType ?? 'task')) return false;
      // Empty status selection = show all statuses.
      if (selectedStatuses.length > 0 && !selectedStatuses.includes(timelineStatusCategory(t.status))) return false;
      if (!q) return true;
      return t.id.toLowerCase().includes(q) || t.title.toLowerCase().includes(q);
    });
  }, [roots, selectedEpicIds, selectedTypes, selectedStatuses, query, tickets]);

  const groupedIssues = useMemo(() => {
    const visibleEpics =
      selectedEpicIds.length > 0
        ? epics.filter((e) => selectedEpicIds.includes(e.id))
        : epics;
    const noEpic = filteredRoots
      .filter((t) => !resolveEpicKey(t, tickets) && t.issueType !== 'epic')
      .sort(compareTimelineRank);
    return [
      ...visibleEpics.map((epic) => ({
        groupId: epic.id,
        groupKey: epic.id,
        groupTitle: epic.title,
        epic,
        // The group header already represents the epic itself. Only render
        // work items belonging to it as child rows.
        items: filteredRoots
          .filter((t) => t.issueType !== 'epic' && resolveEpicKey(t, tickets) === epic.id)
          .sort(compareTimelineRank),
        descendants: getDescendantKeys(epic.id, tickets)
          .map((id) => tickets.find((t) => t.id === id))
          .filter((t): t is Ticket => Boolean(t)),
      })),
      ...(selectedEpicIds.length === 0
        ? [
            {
              groupId: 'no-epic',
              groupKey: null as string | null,
              groupTitle: 'No epic',
              epic: null as Ticket | null,
              items: noEpic,
              descendants: [] as Ticket[],
            },
          ]
        : []),
    ].filter((g) => g.items.length > 0);
  }, [epics, filteredRoots, selectedEpicIds, tickets]);

  useEffect(() => {
    const groupIds = groupedIssues.map((group) => group.groupId);

    if (collapseScopeRef.current !== currentSpace.id) {
      collapseScopeRef.current = currentSpace.id;
      initializedCollapseGroupsRef.current = new Set(groupIds);
      setCollapsedEpics(new Set(groupIds));
      return;
    }

    // Groups can arrive after the first render while space data is loading.
    // Collapse each group only the first time it appears; later API refreshes
    // must not override a user's manual expand/collapse choice.
    const unseenGroupIds = groupIds.filter(
      (groupId) => !initializedCollapseGroupsRef.current.has(groupId),
    );
    if (unseenGroupIds.length === 0) return;

    unseenGroupIds.forEach((groupId) => initializedCollapseGroupsRef.current.add(groupId));
    setCollapsedEpics((previous) => {
      const next = new Set(previous);
      unseenGroupIds.forEach((groupId) => next.add(groupId));
      return next;
    });
  }, [currentSpace.id, groupedIssues]);

  const totalSpanMs = bounds.max.getTime() - bounds.min.getTime();
  // Returns a pixel offset within the time-track (0..trackWidth).
  // Bars live inside .timeline-row__track which already starts after the
  // LABEL_COL-wide label column, so bars use this raw track-relative value.
  const dateToPx = useCallback((d: Date) => {
    const ratio = totalSpanMs > 0 ? (d.getTime() - bounds.min.getTime()) / totalSpanMs : 0;
    return ratio * trackWidth;
  }, [bounds.min, totalSpanMs, trackWidth]);

  // Right edge of a bar ending on day `d`: each day cell spans [d, d+1), so an
  // inclusive end date must extend to the start of the following day.
  const dateToPxEnd = useCallback(
    (d: Date) => dateToPx(new Date(d.getTime() + DAY_MS)),
    [dateToPx],
  );
  useEffect(() => {
    function onOutside(e: MouseEvent) {
      const target = e.target as Node;
      if (viewOpen && viewRef.current && !viewRef.current.contains(target)) {
        setViewOpen(false);
      }
      if (epicMenuOpen && epicFilterRef.current && !epicFilterRef.current.contains(target)) {
        setEpicMenuOpen(false);
      }
      if (typeMenuOpen && typeFilterRef.current && !typeFilterRef.current.contains(target)) {
        setTypeMenuOpen(false);
      }
      if (statusMenuOpen && statusFilterRef.current && !statusFilterRef.current.contains(target)) {
        setStatusMenuOpen(false);
      }
      if (openSprintId && sprintLaneRef.current && !sprintLaneRef.current.contains(target)) {
        setOpenSprintId(null);
      }
    }
    document.addEventListener('mousedown', onOutside);
    return () => document.removeEventListener('mousedown', onOutside);
  }, [viewOpen, epicMenuOpen, typeMenuOpen, statusMenuOpen, openSprintId]);

  function toggleEpicFilter(epicId: string) {
    setSelectedEpicIds((prev) =>
      prev.includes(epicId) ? prev.filter((id) => id !== epicId) : [...prev, epicId],
    );
  }

  function toggleTypeFilter(type: IssueType) {
    setSelectedTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type],
    );
  }

  function toggleStatusFilter(status: TimelineStatusCategory) {
    setSelectedStatuses((prev) =>
      prev.includes(status) ? prev.filter((s) => s !== status) : [...prev, status],
    );
  }

  const barStyle = useCallback((issue: Ticket) => {
    const range = issueBarRange(issue);
    if (!range) return null;
    const { start, end } = range;
    // Clip to the visible window (Jira hides anything beyond -1y/+2y).
    const rawLeft = dateToPx(start);
    const rawRight = dateToPxEnd(end);
    if (rawRight <= 0 || rawLeft >= trackWidth) return null;
    const left = Math.max(rawLeft, 0);
    const right = Math.min(rawRight, trackWidth);
    const width = Math.max(right - left, 14);
    return { left, width, start, end };
  }, [dateToPx, dateToPxEnd, trackWidth]);

  const todayLineLeft = useMemo(() => {
    const today = startOfDay(new Date());
    const clamped = new Date(Math.min(Math.max(today.getTime(), bounds.min.getTime()), bounds.max.getTime()));
    // Offset by LABEL_COL because the today line is rendered at the canvas
    // root, but the time scale starts after the label column.
    return LABEL_COL + dateToPx(clamped);
  }, [bounds.min, bounds.max, dateToPx]);

  // The canvas now always spans 3 years, so center on today when the page
  // opens (and re-center when the scale changes since widths shift).
  useEffect(() => {
    const container = gridRef.current;
    if (!container) return;
    container.scrollLeft = Math.max(0, Math.round(todayLineLeft - container.clientWidth / 2));
  }, [todayLineLeft]);

  // Header tick marks – use absolute positioning with the same
  // LABEL_COL + dateToPx() formula so they line up perfectly with bars.
  const monthTicks = useMemo(() => {
    const ticks: { key: string; label: string; left: number }[] = [];
    days.forEach((d, i) => {
      if (i === 0 || d.getDate() === 1) {
        ticks.push({
          key: d.toISOString(),
          label: d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
          left: LABEL_COL + dateToPx(d),
        });
      }
    });
    return ticks;
  }, [days, dateToPx]);

  const dayTicks = useMemo(() => {
    // Weeks scale: every single day. Months scale: week starts only (too dense otherwise).
    const step = scale === 'weeks' ? 1 : 7;
    const ticks: { date: Date; left: number }[] = [];
    for (let i = 0; i < days.length; i += step) {
      const d = days[i];
      ticks.push({ date: d, left: LABEL_COL + dateToPx(d) });
    }
    return ticks;
  }, [days, scale, dateToPx]);

  const issueBar = (issue: Ticket) => {
    const bar = barStyle(issue);
    const meta = ISSUE_TYPE_META[issue.issueType ?? 'task'];
    const statusMeta = STATUS_OPTIONS.find((option) => option.value === issue.status)!;
    return (
      <div key={issue.id} className="timeline-row">
        <div className="timeline-row__label">
          {view.showIssueType && <span className="timeline-row__type" style={{ color: meta.color }}>{meta.icon}</span>}
          {view.showIssueKey && (
            <button
              type="button"
              className="timeline-row__key"
              onClick={() => openTicket(issue.id)}
              title={`Open ${issue.id}`}
            >
              {issue.id}
            </button>
          )}
          <button
            type="button"
            className="timeline-row__title"
            onClick={() => openTicket(issue.id)}
            title={issue.title}
          >
            {issue.title}
          </button>
          {view.showStatus && (
            <span
              className="timeline-row__status"
              style={{
                color: statusMeta.color,
                borderColor: `${statusMeta.color}55`,
                background: `${statusMeta.color}12`,
              }}
            >
              {statusMeta.label}
            </span>
          )}
        </div>
        <div className="timeline-row__track">
          {bar && (
            <div
              className="timeline-row__bar"
              style={{ left: `${bar.left}px`, width: `${bar.width}px` }}
              title={`${issue.id}: ${formatDateRange(bar.start, bar.end)}`}
            >
              <div className="timeline-row__bar-tip" role="tooltip">
                <strong>{issue.id}</strong>
                <span>Start: {formatDate(bar.start)}</span>
                <span>Due: {formatDate(bar.end)}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  function jumpToday() {
    if (!gridRef.current) return;
    const container = gridRef.current;
    const maxScroll = Math.max(container.scrollWidth - container.clientWidth, 0);
    if (maxScroll <= 0) return;
    // Center today line in the visible area when possible.
    const target = Math.max(
      0,
      Math.min(maxScroll, Math.round(todayLineLeft - container.clientWidth / 2)),
    );
    container.scrollTo({ left: target, behavior: 'smooth' });
  }

  return (
    <div className="timeline-page">
      <div className="timeline-toolbar">
        <input type="search" className="timeline-toolbar__search" placeholder="Search timeline" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="timeline-epic-filter" ref={epicFilterRef}>
          <button
            type="button"
            className={`timeline-toolbar__btn timeline-epic-filter__trigger${
              epicMenuOpen || selectedEpicIds.length > 0 ? ' is-active' : ''
            }`}
            aria-expanded={epicMenuOpen}
            aria-haspopup="listbox"
            onClick={() => setEpicMenuOpen((o) => !o)}
          >
            Epic
            {selectedEpicIds.length > 0 ? ` · ${selectedEpicIds.length}` : ''}
            <span className="timeline-epic-filter__chev" aria-hidden>▾</span>
          </button>
          {epicMenuOpen && (
            <div className="timeline-epic-filter__menu" role="listbox" aria-multiselectable aria-label="Filter by epic">
              {epics.length === 0 ? (
                <p className="timeline-epic-filter__empty">No epics yet</p>
              ) : (
                epics.map((epic) => {
                  const checked = selectedEpicIds.includes(epic.id);
                  return (
                    <label
                      key={epic.id}
                      className={`timeline-epic-filter__row${checked ? ' is-checked' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleEpicFilter(epic.id)}
                      />
                      <span className="timeline-epic-filter__name" title={`${epic.id} ${epic.title}`}>
                        {epic.title || epic.id}
                      </span>
                    </label>
                  );
                })
              )}
            </div>
          )}
        </div>
        <div className="timeline-epic-filter" ref={typeFilterRef}>
          <button
            type="button"
            className={`timeline-toolbar__btn timeline-epic-filter__trigger${
              typeMenuOpen || selectedTypes.length > 0 ? ' is-active' : ''
            }`}
            aria-expanded={typeMenuOpen}
            aria-haspopup="listbox"
            onClick={() => setTypeMenuOpen((o) => !o)}
          >
            Type
            {selectedTypes.length > 0 ? ` · ${selectedTypes.length}` : ''}
            <span className="timeline-epic-filter__chev" aria-hidden>▾</span>
          </button>
          {typeMenuOpen && (
            <div className="timeline-epic-filter__menu" role="listbox" aria-multiselectable aria-label="Filter by type">
              {(['story', 'task', 'bug'] as IssueType[]).map((type) => {
                const meta = ISSUE_TYPE_META[type];
                const checked = selectedTypes.includes(type);
                return (
                  <label
                    key={type}
                    className={`timeline-epic-filter__row${checked ? ' is-checked' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleTypeFilter(type)}
                    />
                    <span className="timeline-epic-filter__type-icon" style={{ color: meta.color }} aria-hidden>
                      {meta.icon}
                    </span>
                    <span className="timeline-epic-filter__name">{meta.label}</span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
        <div className="timeline-epic-filter" ref={statusFilterRef}>
          <button
            type="button"
            className={`timeline-toolbar__btn timeline-epic-filter__trigger${
              statusMenuOpen || selectedStatuses.length > 0 ? ' is-active' : ''
            }`}
            aria-expanded={statusMenuOpen}
            aria-haspopup="listbox"
            onClick={() => setStatusMenuOpen((o) => !o)}
          >
            Status category
            {selectedStatuses.length > 0 ? ` · ${selectedStatuses.length}` : ''}
            <span className="timeline-epic-filter__chev" aria-hidden>▾</span>
          </button>
          {statusMenuOpen && (
            <div className="timeline-epic-filter__menu" role="listbox" aria-multiselectable aria-label="Filter by status category">
              {STATUS_CATEGORY_OPTIONS.map(({ value, label, color }) => {
                const checked = selectedStatuses.includes(value);
                return (
                  <label
                    key={value}
                    className={`timeline-epic-filter__row${checked ? ' is-checked' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleStatusFilter(value)}
                    />
                    <span className="timeline-epic-filter__status-dot" style={{ background: color }} aria-hidden />
                    <span className="timeline-epic-filter__name">{label}</span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
        <div className="timeline-toolbar__right">
          <div className="timeline-view-wrap" ref={viewRef}>
            <button type="button" className="timeline-toolbar__btn" onClick={() => setViewOpen((v) => !v)}>View settings</button>
            {viewOpen && (
              <div className="timeline-view-menu">
                <label><span>Show sprints</span><input type="checkbox" checked={view.showSprints} onChange={(e) => setView((p) => ({ ...p, showSprints: e.target.checked }))} /></label>
                <label><span>Show issue type</span><input type="checkbox" checked={view.showIssueType} onChange={(e) => setView((p) => ({ ...p, showIssueType: e.target.checked }))} /></label>
                <label><span>Show issue key</span><input type="checkbox" checked={view.showIssueKey} onChange={(e) => setView((p) => ({ ...p, showIssueKey: e.target.checked }))} /></label>
                <label><span>Show stage</span><input type="checkbox" checked={view.showStatus} onChange={(e) => setView((p) => ({ ...p, showStatus: e.target.checked }))} /></label>
              </div>
            )}
          </div>
          <button type="button" className="timeline-toolbar__btn" onClick={jumpToday}>Today</button>
          <button type="button" className={`timeline-toolbar__btn ${scale === 'weeks' ? 'is-active' : ''}`} onClick={() => setScale('weeks')}>Weeks</button>
          <button type="button" className={`timeline-toolbar__btn ${scale === 'months' ? 'is-active' : ''}`} onClick={() => setScale('months')}>Months</button>
        </div>
      </div>

      <div className="timeline-layout">
        <section className="timeline-right" ref={gridRef}>
          <div className="timeline-canvas" style={{ width: `${canvasWidth}px` }}>
            <div className="timeline-today-line" style={{ left: `${todayLineLeft}px` }} aria-hidden>
              <span className="timeline-today-line__tag">Today</span>
            </div>

            <div className={`timeline-grid-header${view.showSprints ? ' timeline-grid-header--with-sprints' : ''}`}>
              {monthTicks.map((t) => (
                <div key={t.key} className="timeline-grid-header__month" style={{ left: `${t.left}px` }}>
                  {t.label}
                </div>
              ))}
              {dayTicks.map((t) => (
                <div
                  key={t.date.toISOString()}
                  className={`timeline-grid-header__day${
                    scale === 'weeks' && (t.date.getDay() === 0 || t.date.getDay() === 6) ? ' is-weekend' : ''
                  }`}
                  style={{ left: `${t.left}px`, width: `${dayWidth * (scale === 'weeks' ? 1 : 7)}px` }}
                >
                  {t.date.getDate()}
                </div>
              ))}
              {view.showSprints && (
                <div className="timeline-sprint-lane" aria-label="Sprints" ref={sprintLaneRef}>
                  <span className="timeline-sprint-lane__side-label">Sprints</span>
                  {sprintItems
                    .filter((s) => s.hasDates && s.start && s.end)
                    // Like Jira: sprints entirely outside the -1y/+2y window are hidden.
                    .filter((s) => dateToPxEnd(s.end!) > 0 && dateToPx(s.start!) < trackWidth)
                    .map((s) => {
                      const badge = SPRINT_STATUS_BADGE[s.status] ?? SPRINT_STATUS_BADGE.future;
                      const isOpen = openSprintId === s.id;
                      const slotLeft = Math.max(dateToPx(s.start!), 0);
                      const slotRight = Math.min(dateToPxEnd(s.end!), trackWidth);
                      return (
                        <div
                          key={s.id}
                          className={`timeline-sprint-lane__slot${isOpen ? ' is-open' : ''}`}
                          style={{
                            left: `${LABEL_COL + slotLeft}px`,
                            width: `${Math.max(slotRight - slotLeft, 24)}px`,
                          }}
                        >
                          <button
                            type="button"
                            className={`timeline-sprint-lane__item${isOpen ? ' is-open' : ''}`}
                            onClick={() => setOpenSprintId(isOpen ? null : s.id)}
                            aria-expanded={isOpen}
                          >
                            <span className="timeline-sprint-lane__name">{s.label}</span>
                          </button>
                          {isOpen && (
                            <div className="timeline-sprint-pop" role="dialog" aria-label={s.label}>
                              <div className="timeline-sprint-pop__title">{s.label}</div>
                              <span className={`timeline-sprint-pop__badge ${badge.className}`}>{badge.label}</span>
                              {s.goal && <p className="timeline-sprint-pop__goal">{s.goal}</p>}
                              <div className="timeline-sprint-pop__dates">
                                <div>
                                  <span className="timeline-sprint-pop__date-label">Sprint start</span>
                                  <span>{formatDate(s.start!)}</span>
                                </div>
                                <div>
                                  <span className="timeline-sprint-pop__date-label">Sprint end</span>
                                  <span>{formatDate(s.end!)}</span>
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                </div>
              )}
            </div>

            <div className="timeline-section-title">Work</div>
            <div className="timeline-issues">
              {groupedIssues.map((g) => {
                const collapsed = collapsedEpics.has(g.groupId);
                const completedCount = g.descendants.filter((t) => t.status === 'done').length;
                const allChildrenDone = g.descendants.length > 0 && completedCount === g.descendants.length;
                return (
                  <div key={g.groupId} className="timeline-group">
                    <div className={`timeline-group__header ${collapsed ? 'is-collapsed' : ''}`}>
                      <button
                        type="button"
                        className="timeline-group__toggle"
                        onClick={() => {
                          setCollapsedEpics((prev) => {
                            const next = new Set(prev);
                            if (next.has(g.groupId)) next.delete(g.groupId);
                            else next.add(g.groupId);
                            return next;
                          });
                        }}
                        aria-expanded={!collapsed}
                      >
                        <span className={`timeline-group__chev ${collapsed ? '' : 'is-open'}`} aria-hidden>▶</span>
                      </button>
                      {g.groupKey ? (
                        <button
                          type="button"
                          className="timeline-group__key"
                          onClick={() => openTicket(g.groupKey!)}
                          title={`Open ${g.groupKey}`}
                        >
                          {g.groupKey}
                        </button>
                      ) : null}
                      <span className="timeline-group__label">{g.groupTitle}</span>
                      <span className="timeline-group__count">{g.items.length}</span>
                      {g.epic && (
                        <div className="timeline-group__epic-controls">
                          <span className={`timeline-group__progress${allChildrenDone ? ' is-complete' : ''}`}>
                            {completedCount}/{g.descendants.length} Done
                          </span>
                          <span
                            className="timeline-group__status timeline-group__status--derived"
                            title="Automatically derived from child work item stages"
                            style={{ color: STATUS_OPTIONS.find((option) => option.value === g.epic!.status)?.color }}
                          >
                            {STATUS_OPTIONS.find((option) => option.value === g.epic!.status)?.label}
                          </span>
                        </div>
                      )}
                    </div>
                    {!collapsed && g.items.map((i) => issueBar(i))}
                  </div>
                );
              })}
              {groupedIssues.length === 0 && (
                <p className="timeline-empty">No issues match the current filters.</p>
              )}
            </div>
          </div>
        </section>
      </div>

      {selectedTicket && (
        <TicketDetailModal
          ticket={selectedTicket}
          allTickets={tickets}
          sprints={sprints}
          onUpdate={updateTicket}
          onCreateSubtask={createSubtask}
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
    </div>
  );
}
