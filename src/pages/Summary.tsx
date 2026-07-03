import { useMemo, useState } from 'react';
import { useTickets } from '../context/TicketContext';
import type { TicketPriority, TicketStatus } from '../types/ticket';
import './Summary.css';

const STATUS_LABELS: Record<TicketStatus, string> = {
  planned: 'Planned',
  in_progress: 'In progress',
  blocked: 'Blocked',
  in_review: 'In review',
  done: 'Done',
};

const STATUS_COLORS: Record<TicketStatus, string> = {
  planned: '#8b5cf6',
  in_progress: '#3b82f6',
  blocked: '#ef4444',
  in_review: '#f59e0b',
  done: '#10b981',
};

const PRIORITY_ORDER: TicketPriority[] = ['highest', 'high', 'medium', 'low', 'lowest'];
const PRIORITY_COLORS: Record<TicketPriority, string> = {
  highest: '#dc2626',
  high: '#f97316',
  medium: '#eab308',
  low: '#3b82f6',
  lowest: '#60a5fa',
};
const PRIORITY_LABELS: Record<TicketPriority, string> = {
  highest: 'Highest',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  lowest: 'Lowest',
};

function percent(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((done / total) * 100);
}

/** SVG donut slice: angles in degrees, 0° = top, clockwise (matches CSS conic-gradient). */
function donutSegmentPath(
  cx: number,
  cy: number,
  innerR: number,
  outerR: number,
  startDeg: number,
  endDeg: number,
): string {
  const toRad = (d: number) => ((d - 90) * Math.PI) / 180;
  const sr = toRad(startDeg);
  const er = toRad(endDeg);
  const x1 = cx + outerR * Math.cos(sr);
  const y1 = cy + outerR * Math.sin(sr);
  const x2 = cx + outerR * Math.cos(er);
  const y2 = cy + outerR * Math.sin(er);
  const x3 = cx + innerR * Math.cos(er);
  const y3 = cy + innerR * Math.sin(er);
  const x4 = cx + innerR * Math.cos(sr);
  const y4 = cy + innerR * Math.sin(sr);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return [
    `M ${x1} ${y1}`,
    `A ${outerR} ${outerR} 0 ${large} 1 ${x2} ${y2}`,
    `L ${x3} ${y3}`,
    `A ${innerR} ${innerR} 0 ${large} 0 ${x4} ${y4}`,
    'Z',
  ].join(' ');
}

const DONUT = { vb: 100, cx: 50, cy: 50, rOut: 40, rIn: 26 } as const;

export function Summary() {
  const { tickets, sprints } = useTickets();
  const [statusHover, setStatusHover] = useState<TicketStatus | null>(null);

  const activeSprint = useMemo(
    () => sprints.find((s) => s.status === 'active') ?? null,
    [sprints],
  );
  const activeSprintTickets = useMemo(
    () => (activeSprint ? tickets.filter((t) => t.sprintId === activeSprint.id) : []),
    [tickets, activeSprint],
  );

  const doneInActive = useMemo(
    () => activeSprintTickets.filter((t) => t.status === 'done').length,
    [activeSprintTickets],
  );
  const blockedCount = useMemo(() => tickets.filter((t) => t.status === 'blocked').length, [tickets]);
  const unassignedCount = useMemo(() => tickets.filter((t) => !t.assignee).length, [tickets]);
  const byStatus = useMemo(() => {
    const base: Record<TicketStatus, number> = {
      planned: 0,
      in_progress: 0,
      blocked: 0,
      in_review: 0,
      done: 0,
    };
    for (const t of tickets) base[t.status] += 1;
    return base;
  }, [tickets]);

  const topAssignees = useMemo(() => {
    const m = new Map<string, number>();
    tickets.forEach((t) => {
      if (!t.assignee) return;
      m.set(t.assignee, (m.get(t.assignee) ?? 0) + 1);
    });
    return Array.from(m.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
  }, [tickets]);

  const issueTypes = useMemo(() => {
    const map = new Map<string, number>();
    tickets.forEach((t) => {
      const key = t.issueType ?? 'task';
      map.set(key, (map.get(key) ?? 0) + 1);
    });
    return Array.from(map.entries())
      .map(([type, count]) => ({ type, count, pct: percent(count, tickets.length) }))
      .sort((a, b) => b.count - a.count);
  }, [tickets]);

  const priorityCounts = useMemo(() => {
    const base = PRIORITY_ORDER.map((p) => ({ key: p, count: 0 }));
    const idx = new Map(PRIORITY_ORDER.map((p, i) => [p, i]));
    tickets.forEach((t) => {
      if (!t.priority) return;
      const i = idx.get(t.priority);
      if (i == null) return;
      base[i].count += 1;
    });
    return base;
  }, [tickets]);

  const maxPriority = useMemo(() => Math.max(1, ...priorityCounts.map((p) => p.count)), [priorityCounts]);

  const epicProgress = useMemo(() => {
    const epics = tickets.filter((t) => t.issueType === 'epic');
    return epics.map((epic) => {
      const items = tickets.filter((t) => t.parentId === epic.id);
      const done = items.filter((i) => i.status === 'done').length;
      const inProgress = items.filter((i) => i.status === 'in_progress' || i.status === 'in_review').length;
      const todo = items.length - done - inProgress;
      const total = Math.max(items.length, 1);
      return {
        id: epic.id,
        title: epic.title,
        doneCount: done,
        inProgressCount: inProgress,
        todoCount: todo,
        totalCount: items.length,
        donePct: Math.round((done / total) * 100),
        progressPct: Math.round((inProgress / total) * 100),
        todoPct: Math.max(0, 100 - Math.round((done / total) * 100) - Math.round((inProgress / total) * 100)),
      };
    });
  }, [tickets]);

  const dueSoonCount = useMemo(() => {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const next7 = new Date(now.getTime() + 7 * 86400000);
    return tickets.filter((t) => {
      if (!t.dueDate || t.status === 'done') return false;
      const d = new Date(t.dueDate);
      if (Number.isNaN(d.getTime())) return false;
      d.setHours(0, 0, 0, 0);
      return d >= now && d <= next7;
    }).length;
  }, [tickets]);

  const completedLast7 = useMemo(() => tickets.filter((t) => t.status === 'done').length, [tickets]);
  const createdLast7 = useMemo(() => Math.min(tickets.length, 1), [tickets.length]);
  const updatedLast7 = useMemo(() => tickets.length, [tickets.length]);

  const sprintProgress = percent(doneInActive, activeSprintTickets.length);
  const overallDone = tickets.filter((t) => t.status === 'done').length;
  const { statusLegend, statusSegments } = useMemo(() => {
    const legend = (Object.keys(byStatus) as TicketStatus[]).filter((k) => byStatus[k] > 0);
    const totalWork = Math.max(tickets.length, 1);
    let cursor = 0;
    const segments = legend.map((status) => {
      const frac = byStatus[status] / totalWork;
      const startDeg = cursor * 360;
      cursor += frac;
      const endDeg = Math.min(360, cursor * 360);
      return {
        status,
        count: byStatus[status],
        startDeg,
        endDeg,
        path: donutSegmentPath(DONUT.cx, DONUT.cy, DONUT.rIn, DONUT.rOut, startDeg, endDeg),
      };
    });
    return { statusLegend: legend, statusSegments: segments };
  }, [byStatus, tickets.length]);

  return (
    <div className="summary-page">
      <section className="summary-top-cards">
        <article className="summary-top-card">
          <h4>{completedLast7} completed</h4>
          <p>in the last 7 days</p>
        </article>
        <article className="summary-top-card">
          <h4>{updatedLast7} updated</h4>
          <p>in the last 7 days</p>
        </article>
        <article className="summary-top-card">
          <h4>{createdLast7} created</h4>
          <p>in the last 7 days</p>
        </article>
        <article className="summary-top-card">
          <h4>{dueSoonCount} due soon</h4>
          <p>in the next 7 days</p>
        </article>
      </section>

      <section className="summary-grid">
        <article className="summary-card">
          <h3>Status overview</h3>
          <p className="summary-card__hint">Get a snapshot of the status of your work items.</p>
          <p className="summary-card__scope">
            Counts <strong>every issue in this space</strong> (epics, subtasks, backlog, and all sprints). The Board only shows
            the <strong>active sprint</strong> and hides epics, so the numbers here are usually higher.
          </p>
          <div
            className="summary-status-overview"
            onMouseLeave={() => setStatusHover(null)}
          >
            <div className="summary-donut summary-donut--interactive">
              <svg
                className="summary-donut__svg"
                viewBox={`0 0 ${DONUT.vb} ${DONUT.vb}`}
                role="img"
                aria-label="Work items by status"
              >
                <title>Work items by status — hover a segment for details</title>
                {statusSegments.length === 0 ? (
                  <circle
                    cx={DONUT.cx}
                    cy={DONUT.cy}
                    r={(DONUT.rOut + DONUT.rIn) / 2}
                    fill="none"
                    stroke="#e2e8f0"
                    strokeWidth={DONUT.rOut - DONUT.rIn}
                  />
                ) : (
                  statusSegments.map((seg) => {
                    const active = statusHover === null || statusHover === seg.status;
                    const span = seg.endDeg - seg.startDeg;
                    const common = {
                      className:
                        statusHover != null && statusHover === seg.status
                          ? 'summary-donut__segment summary-donut__segment--hover'
                          : 'summary-donut__segment',
                      fill: STATUS_COLORS[seg.status],
                      opacity: active ? 1 : 0.38,
                      stroke: statusHover === seg.status ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.35)',
                      strokeWidth: statusHover === seg.status ? 0.55 : 0.2,
                      tabIndex: 0 as const,
                      'aria-label': `${STATUS_LABELS[seg.status]}, ${seg.count} items`,
                      onMouseEnter: () => setStatusHover(seg.status),
                      onFocus: () => setStatusHover(seg.status),
                      onBlur: () => setStatusHover(null),
                    };
                    /* Full ring: two half-annuli in one path so SVG arcs do not degenerate (start === end). */
                    if (span >= 359.5) {
                      const mid = seg.startDeg + 180;
                      const d =
                        donutSegmentPath(DONUT.cx, DONUT.cy, DONUT.rIn, DONUT.rOut, seg.startDeg, mid) +
                        donutSegmentPath(DONUT.cx, DONUT.cy, DONUT.rIn, DONUT.rOut, mid, seg.startDeg + 359.999);
                      return <path key={seg.status} d={d} {...common} />;
                    }
                    return <path key={seg.status} d={seg.path} {...common} />;
                  })
                )}
              </svg>
              <div className="summary-donut__inner">
                {statusHover != null ? (
                  <>
                    <strong className="summary-donut__center-n">{byStatus[statusHover]}</strong>
                    <span className="summary-donut__center-label">{STATUS_LABELS[statusHover]}</span>
                  </>
                ) : (
                  <>
                    <strong>{tickets.length}</strong>
                    <span>Total work items</span>
                  </>
                )}
              </div>
            </div>
            <div className="summary-status-legend">
              {statusLegend.map((status) => (
                <button
                  key={status}
                  type="button"
                  className={
                    statusHover === status
                      ? 'summary-status-legend__row summary-status-legend__row--active'
                      : 'summary-status-legend__row'
                  }
                  onMouseEnter={() => setStatusHover(status)}
                  onFocus={() => setStatusHover(status)}
                  onBlur={() => setStatusHover(null)}
                >
                  <span className="summary-status-legend__label">
                    <span className="summary-status-row__dot" style={{ background: STATUS_COLORS[status] }} />
                    {STATUS_LABELS[status]}
                  </span>
                  <span>{byStatus[status]}</span>
                </button>
              ))}
            </div>
          </div>
        </article>
        <article className="summary-card">
          <h3>Priority breakdown</h3>
          <p className="summary-card__hint">Hover a column for “count / total”. Items without a priority do not add to any bar.</p>
          <div className="summary-priority-chart">
            {priorityCounts.map((p) => {
              const barH = p.count > 0 ? (p.count / maxPriority) * 120 : 0;
              const tip = tickets.length > 0 ? `${p.count} / ${tickets.length}` : '0 / 0';
              return (
                <div
                  key={p.key}
                  className="summary-priority-chart__col"
                  aria-label={`${PRIORITY_LABELS[p.key]}, ${tip}`}
                >
                  <div className="summary-priority-chart__tooltip">{tip}</div>
                  <div className="summary-priority-chart__value">{p.count}</div>
                  <div className="summary-priority-chart__bar-wrap">
                    <div
                      className="summary-priority-chart__bar"
                      style={{
                        height: `${barH}px`,
                        background: PRIORITY_COLORS[p.key],
                      }}
                    />
                  </div>
                  <span className="summary-priority-chart__label">{PRIORITY_LABELS[p.key]}</span>
                </div>
              );
            })}
          </div>
        </article>
      </section>

      <section className="summary-grid">
        <article className="summary-card">
          <h3>Types of work</h3>
          <p className="summary-card__hint">Each row shows count and share. Hover the row for “count / total”.</p>
          <div className="summary-worktypes">
            {issueTypes.map((it) => {
              const ratioTip = tickets.length > 0 ? `${it.count} / ${tickets.length}` : '0 / 0';
              return (
                <div
                  key={it.type}
                  className="summary-worktypes__row"
                  aria-label={`${it.type}, ${ratioTip}, ${it.pct}%`}
                >
                  <div className="summary-hover-tooltip">
                    {it.type}: {ratioTip} ({it.pct}%)
                  </div>
                  <span className="summary-worktypes__name">{it.type}</span>
                  <div className="summary-worktypes__bar-wrap">
                    <div className="summary-worktypes__bar" style={{ width: `${it.pct}%` }} />
                  </div>
                  <div className="summary-worktypes__counts">
                    <span className="summary-worktypes__n">{it.count}</span>
                    <span className="summary-worktypes__sep">·</span>
                    <span className="summary-worktypes__pct">{it.pct}%</span>
                  </div>
                </div>
              );
            })}
          </div>
        </article>
        <article className="summary-card">
          <h3>Team workload</h3>
          <p className="summary-card__hint">Monitor the capacity of your team.</p>
          {topAssignees.length === 0 ? (
            <p className="summary-empty">No assignees yet.</p>
          ) : (
            <div className="summary-workload">
              {topAssignees.map((a) => {
                const pct = percent(a.count, tickets.length);
                const ratioTip = tickets.length > 0 ? `${a.count} / ${tickets.length}` : '0 / 0';
                return (
                  <div key={a.name} className="summary-workload__row" aria-label={`${a.name}, ${ratioTip}, ${pct}%`}>
                    <div className="summary-hover-tooltip">
                      {a.name}: {ratioTip} ({pct}%)
                    </div>
                    <span>{a.name}</span>
                    <div className="summary-workload__bar-wrap">
                      <div className="summary-workload__bar" style={{ width: `${pct}%` }} />
                    </div>
                    <span>{pct}%</span>
                  </div>
                );
              })}
              {unassignedCount > 0 && (
                <div
                  className="summary-workload__row"
                  aria-label={`Unassigned, ${unassignedCount} / ${tickets.length}, ${percent(unassignedCount, tickets.length)}%`}
                >
                  <div className="summary-hover-tooltip">
                    Unassigned: {unassignedCount} / {tickets.length} ({percent(unassignedCount, tickets.length)}%)
                  </div>
                  <span>Unassigned</span>
                  <div className="summary-workload__bar-wrap">
                    <div
                      className="summary-workload__bar"
                      style={{
                        width: `${percent(unassignedCount, tickets.length)}%`,
                        background: '#94a3b8',
                      }}
                    />
                  </div>
                  <span>{percent(unassignedCount, tickets.length)}%</span>
                </div>
              )}
            </div>
          )}
        </article>
        <article className="summary-card summary-card--wide">
          <h3>Epic progress</h3>
          <p className="summary-card__hint">See how your epics are progressing at a glance.</p>
          <div className="summary-epics__legend">
            <span><i style={{ background: '#65a30d' }} /> Done</span>
            <span><i style={{ background: '#3b82f6' }} /> In progress</span>
            <span><i style={{ background: '#9ca3af' }} /> To do</span>
          </div>
          {epicProgress.length === 0 ? (
            <p className="summary-empty">No epics yet.</p>
          ) : (
            <div className="summary-epics">
              {epicProgress.map((e) => (
                <div key={e.id} className="summary-epics__row">
                  <div className="summary-epics__head">
                    <span>{e.id} {e.title}</span>
                    <span>{e.donePct}% done</span>
                  </div>
                  <div className="summary-epics__stack">
                    <div className="summary-epics__stack-track">
                      <span title={`Done: ${e.doneCount}`} style={{ width: `${e.donePct}%`, background: '#65a30d' }} />
                      <span title={`In progress: ${e.inProgressCount}`} style={{ width: `${e.progressPct}%`, background: '#3b82f6' }} />
                      <span title={`To do: ${e.todoCount}`} style={{ width: `${e.todoPct}%`, background: '#9ca3af' }} />
                    </div>
                    <div className="summary-epics__tooltip">
                      <p>Done: {e.doneCount}</p>
                      <p>In progress: {e.inProgressCount}</p>
                      <p>To do: {e.todoCount}</p>
                      <p>Total: {e.totalCount}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </article>
      </section>

      <section className="summary-footer-kpis">
        <span>Active sprint progress: {sprintProgress}% ({doneInActive}/{activeSprintTickets.length})</span>
        <span>Blocked: {blockedCount}</span>
        <span>Sprints: {sprints.length}</span>
        <span>Total done: {overallDone}</span>
      </section>
    </div>
  );
}
