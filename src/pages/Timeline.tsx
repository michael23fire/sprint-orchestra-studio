import { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { useTickets } from '../context/TicketContext';
import type { Ticket, IssueType, TicketStatus } from '../types/ticket';
import { ISSUE_TYPE_META } from '../types/ticket';
import './Timeline.css';

const DAY_MS = 86400000;
const DEFAULT_SPAN_DAYS = 56;
const LABEL_COL = 260; // keep in sync with .timeline-row grid column width
type Scale = 'weeks' | 'months';
interface TimelineViewSettings {
  showSprints: boolean;
  showIssueType: boolean;
  showIssueKey: boolean;
}

function startOfDay(d: Date): Date {
  const t = new Date(d);
  t.setHours(0, 0, 0, 0);
  return t;
}

function parseDate(input?: string): Date | null {
  if (!input) return null;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return startOfDay(d);
}

export function Timeline() {
  const { tickets, sprints } = useTickets();
  const [query, setQuery] = useState('');
  const [epicFilter, setEpicFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState<'all' | IssueType>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | TicketStatus>('all');
  const [scale, setScale] = useState<Scale>('weeks');
  const [collapsedEpics, setCollapsedEpics] = useState<Set<string>>(() => new Set());
  const [viewOpen, setViewOpen] = useState(false);
  const [view, setView] = useState<TimelineViewSettings>({ showSprints: true, showIssueType: true, showIssueKey: true });
  const gridRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const roots = useMemo(() => tickets.filter((t) => t.issueType !== 'subtask'), [tickets]);
  const epics = useMemo(() => tickets.filter((t) => t.issueType === 'epic'), [tickets]);
  const activeScaleDays = scale === 'weeks' ? DEFAULT_SPAN_DAYS : 140;
  const pixelsPerDay = scale === 'weeks' ? 28 : 14;

  const bounds = useMemo(() => {
    const today = startOfDay(new Date());
    const lookback = scale === 'weeks' ? 14 : 30;
    const defaultMin = new Date(today.getTime() - lookback * DAY_MS);
    const defaultMax = new Date(today.getTime() + (activeScaleDays - lookback) * DAY_MS);
    const dates: Date[] = [];
    sprints.forEach((s) => {
      const a = parseDate(s.startDate);
      const b = parseDate(s.endDate);
      if (a) dates.push(a);
      if (b) dates.push(b);
    });
    roots.forEach((t) => {
      const a = parseDate(t.startDate);
      const b = parseDate(t.dueDate);
      if (a) dates.push(a);
      if (b) dates.push(b);
    });
    if (dates.length === 0) return { min: defaultMin, max: defaultMax };
    return { min: startOfDay(defaultMin), max: startOfDay(defaultMax) };
  }, [sprints, roots, activeScaleDays, scale]);

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
  // Full canvas width = label column (260px) + the time-track on its right.
  const canvasWidth = LABEL_COL + trackWidth;

  const sprintItems = useMemo(() => {
    return sprints
      .map((s) => {
        const start = parseDate(s.startDate);
        const end = parseDate(s.endDate);
        return { id: `s-${s.id}`, label: s.name, start, end, hasDates: Boolean(start && end) };
      })
      .sort((a, b) => {
        const at = a.start?.getTime() ?? Number.MAX_SAFE_INTEGER;
        const bt = b.start?.getTime() ?? Number.MAX_SAFE_INTEGER;
        return at - bt;
      });
  }, [sprints]);

  const filteredRoots = useMemo(() => {
    const q = query.trim().toLowerCase();
    return roots.filter((t) => {
      if (epicFilter !== 'all' && (t.parentId ?? 'none') !== epicFilter) return false;
      if (typeFilter !== 'all' && (t.issueType ?? 'task') !== typeFilter) return false;
      if (statusFilter !== 'all' && t.status !== statusFilter) return false;
      if (!q) return true;
      return t.id.toLowerCase().includes(q) || t.title.toLowerCase().includes(q);
    });
  }, [roots, epicFilter, typeFilter, statusFilter, query]);

  const groupedIssues = useMemo(() => {
    const noEpic = filteredRoots.filter((t) => !t.parentId && t.issueType !== 'epic');
    return [
      ...epics.map((epic) => ({
        groupId: epic.id,
        groupLabel: `${epic.id} ${epic.title}`,
        items: filteredRoots.filter((t) => t.parentId === epic.id),
      })),
      {
        groupId: 'no-epic',
        groupLabel: 'No epic',
        items: noEpic,
      },
    ].filter((g) => g.items.length > 0);
  }, [epics, filteredRoots]);

  const totalSpanMs = bounds.max.getTime() - bounds.min.getTime();
  // Returns a pixel offset within the time-track (0..trackWidth).
  // Bars live inside .timeline-row__track which already starts after the
  // 260px label column, so they use this raw value.
  const dateToPx = useCallback((d: Date) => {
    const ratio = totalSpanMs > 0 ? (d.getTime() - bounds.min.getTime()) / totalSpanMs : 0;
    return ratio * trackWidth;
  }, [bounds.min, totalSpanMs, trackWidth]);
  useEffect(() => {
    function onOutside(e: MouseEvent) {
      if (!viewOpen) return;
      const target = e.target as Node;
      if (viewRef.current && !viewRef.current.contains(target)) setViewOpen(false);
    }
    document.addEventListener('mousedown', onOutside);
    return () => document.removeEventListener('mousedown', onOutside);
  }, [viewOpen]);

  const barStyle = useCallback((issue: Ticket) => {
    const start = parseDate(issue.startDate) ?? parseDate(issue.dueDate) ?? bounds.min;
    const end = parseDate(issue.dueDate) ?? new Date(start.getTime() + 7 * DAY_MS);
    const left = dateToPx(start);
    const right = dateToPx(end);
    const width = Math.max(right - left, 14);
    return { left, width };
  }, [dateToPx, bounds.min]);

  const todayLineLeft = useMemo(() => {
    const today = startOfDay(new Date());
    const clamped = new Date(Math.min(Math.max(today.getTime(), bounds.min.getTime()), bounds.max.getTime()));
    // Offset by LABEL_COL because the today line is rendered at the canvas
    // root, but the time scale starts after the label column.
    return LABEL_COL + dateToPx(clamped);
  }, [bounds.min, bounds.max, dateToPx]);

  // Date header tick marks – use absolute positioning with the same
  // LABEL_COL + dateToPx() formula so they line up perfectly with bars.
  const headerTicks = useMemo(() => {
    const stepDays = scale === 'weeks' ? 7 : 14;
    const ticks: { date: Date; left: number }[] = [];
    for (let i = 0; i < days.length; i += stepDays) {
      const d = days[i];
      ticks.push({ date: d, left: LABEL_COL + dateToPx(d) });
    }
    return ticks;
  }, [days, scale, dateToPx]);

  const issueBar = (issue: Ticket) => {
    const { left, width } = barStyle(issue);
    const meta = ISSUE_TYPE_META[issue.issueType ?? 'task'];
    return (
      <div key={issue.id} className="timeline-row">
        <div className="timeline-row__label">
          {view.showIssueType && <span className="timeline-row__type" style={{ color: meta.color }}>{meta.icon}</span>}
          {view.showIssueKey && <span className="timeline-row__key">{issue.id}</span>}
          <span className="timeline-row__title">{issue.title}</span>
        </div>
        <div className="timeline-row__track">
          <div
            className="timeline-row__bar"
            style={{ left: `${left}px`, width: `${width}px` }}
          />
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
        <select className="timeline-toolbar__btn" value={epicFilter} onChange={(e) => setEpicFilter(e.target.value)}>
          <option value="all">Epic</option>
          <option value="none">No epic</option>
          {epics.map((e) => <option key={e.id} value={e.id}>{e.id}</option>)}
        </select>
        <select className="timeline-toolbar__btn" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as 'all' | IssueType)}>
          <option value="all">General</option>
          <option value="epic">Epic</option>
          <option value="story">Story</option>
          <option value="task">Task</option>
          <option value="bug">Bug</option>
          <option value="subtask">Subtask</option>
        </select>
        <select className="timeline-toolbar__btn" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as 'all' | TicketStatus)}>
          <option value="all">Status category</option>
          <option value="planned">Planned</option>
          <option value="in_progress">In progress</option>
          <option value="blocked">Blocked</option>
          <option value="in_review">In review</option>
          <option value="done">Done</option>
        </select>
        <div className="timeline-toolbar__right">
          <div className="timeline-view-wrap" ref={viewRef}>
            <button type="button" className="timeline-toolbar__btn" onClick={() => setViewOpen((v) => !v)}>View settings</button>
            {viewOpen && (
              <div className="timeline-view-menu">
                <label><span>Show sprints</span><input type="checkbox" checked={view.showSprints} onChange={(e) => setView((p) => ({ ...p, showSprints: e.target.checked }))} /></label>
                <label><span>Show issue type</span><input type="checkbox" checked={view.showIssueType} onChange={(e) => setView((p) => ({ ...p, showIssueType: e.target.checked }))} /></label>
                <label><span>Show issue key</span><input type="checkbox" checked={view.showIssueKey} onChange={(e) => setView((p) => ({ ...p, showIssueKey: e.target.checked }))} /></label>
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

            <div className="timeline-grid-header">
              {headerTicks.map((t) => (
                <div
                  key={t.date.toISOString()}
                  className="timeline-grid-header__cell"
                  style={{ left: `${t.left}px` }}
                >
                  {t.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </div>
              ))}
            </div>

            {view.showSprints && sprintItems.length > 0 && (
              <>
                <div className="timeline-section-title">Sprints</div>
                <div className="timeline-sprints">
                  {sprintItems.map((s) => (
                    <div key={s.id} className="timeline-row timeline-row--sprint">
                      <div className="timeline-row__label">
                        <span className="timeline-row__sprint-dot" aria-hidden />
                        <span className="timeline-row__title">{s.label}</span>
                      </div>
                      <div className="timeline-row__track">
                        {s.hasDates && s.start && s.end ? (
                          <div
                            className="timeline-row__bar timeline-row__bar--sprint"
                            style={{
                              left: `${dateToPx(s.start)}px`,
                              width: `${Math.max(dateToPx(s.end) - dateToPx(s.start), 14)}px`,
                            }}
                          />
                        ) : (
                          <span className="timeline-row__nodate">No dates set</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            <div className="timeline-section-title">Work</div>
            <div className="timeline-issues">
              {groupedIssues.map((g) => {
                const collapsed = collapsedEpics.has(g.groupId);
                return (
                  <div key={g.groupId} className="timeline-group">
                    <button
                      type="button"
                      className={`timeline-group__header ${collapsed ? 'is-collapsed' : ''}`}
                      onClick={() => {
                        setCollapsedEpics((prev) => {
                          const next = new Set(prev);
                          if (next.has(g.groupId)) next.delete(g.groupId);
                          else next.add(g.groupId);
                          return next;
                        });
                      }}
                    >
                      <span className={`timeline-group__chev ${collapsed ? '' : 'is-open'}`} aria-hidden>▶</span>
                      <span className="timeline-group__label">{g.groupLabel}</span>
                      <span className="timeline-group__count">{g.items.length}</span>
                    </button>
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
    </div>
  );
}
