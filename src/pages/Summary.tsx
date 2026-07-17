import { useMemo, useState } from 'react';
import { useTickets } from '../context/TicketContext';
import { useSpaces } from '../context/SpaceContext';
import { effectiveSpaceMemberIds } from '../types/space';
import { useCurrentUser } from '../context/UserContext';
import type { IssueType, TicketPriority, TicketStatus } from '../types/ticket';
import { ISSUE_TYPE_META } from '../types/ticket';
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

const EPIC_PROGRESS_STATUSES: TicketStatus[] = ['planned', 'in_progress', 'done'];

type PriorityChartKey = TicketPriority | 'none';
const PRIORITY_ORDER: PriorityChartKey[] = ['highest', 'high', 'medium', 'low', 'lowest', 'none'];
const PRIORITY_COLORS: Record<PriorityChartKey, string> = {
  highest: '#dc2626',
  high: '#f97316',
  medium: '#eab308',
  low: '#3b82f6',
  lowest: '#60a5fa',
  none: '#94a3b8',
};
const PRIORITY_LABELS: Record<PriorityChartKey, string> = {
  highest: 'Highest',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  lowest: 'Lowest',
  none: 'None',
};

function percent(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((done / total) * 100);
}

/** Start of local day, then subtract `days` (inclusive window for “last N days”). */
function daysAgoStart(days: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return d;
}

function parseInstant(iso: string | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isWithinLastDays(iso: string | undefined, days: number): boolean {
  const d = parseInstant(iso);
  if (!d) return false;
  return d >= daysAgoStart(days);
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
  const { tickets } = useTickets();
  const { currentSpace } = useSpaces();
  const { users } = useCurrentUser();
  const [statusHover, setStatusHover] = useState<TicketStatus | null>(null);

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

  const spaceMemberIds = useMemo(
    () => new Set(effectiveSpaceMemberIds(currentSpace)),
    [currentSpace],
  );

  const spaceMemberById = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of users) {
      if (spaceMemberIds.has(String(u.id))) m.set(String(u.id), u.name);
    }
    return m;
  }, [users, spaceMemberIds]);

  const topAssignees = useMemo(() => {
    const m = new Map<string, { name: string; count: number }>();
    for (const [id, name] of spaceMemberById) {
      m.set(id, { name, count: 0 });
    }
    for (const t of tickets) {
      if (t.assigneeId == null) continue;
      const id = String(t.assigneeId);
      if (!spaceMemberIds.has(id)) continue;
      const name = spaceMemberById.get(id) ?? t.assignee ?? id;
      const prev = m.get(id);
      m.set(id, { name, count: (prev?.count ?? 0) + 1 });
    }
    return Array.from(m.entries())
      .map(([id, v]) => ({ id, name: v.name, count: v.count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, 8);
  }, [tickets, spaceMemberIds, spaceMemberById]);

  const issueTypes = useMemo(() => {
    const map = new Map<string, number>();
    tickets.forEach((t) => {
      const key = t.issueType ?? 'task';
      map.set(key, (map.get(key) ?? 0) + 1);
    });
    return Array.from(map.entries())
      .map(([type, count]) => ({
        type: type as IssueType,
        count,
        pct: percent(count, tickets.length),
        meta: ISSUE_TYPE_META[type as IssueType] ?? ISSUE_TYPE_META.task,
      }))
      .sort((a, b) => b.count - a.count || a.meta.label.localeCompare(b.meta.label));
  }, [tickets]);

  const priorityCounts = useMemo(() => {
    const base = PRIORITY_ORDER.map((p) => ({ key: p, count: 0 }));
    const idx = new Map(PRIORITY_ORDER.map((p, i) => [p, i]));
    tickets.forEach((t) => {
      const key: PriorityChartKey = t.priority ?? 'none';
      const i = idx.get(key);
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
      const total = items.length;
      const counts: Record<TicketStatus, number> = {
        planned: items.filter((item) => item.status === 'planned').length,
        in_progress: items.filter((item) => (
          item.status === 'in_progress' || item.status === 'blocked' || item.status === 'in_review'
        )).length,
        blocked: 0,
        in_review: 0,
        done: items.filter((item) => item.status === 'done').length,
      };
      const activeStatuses = EPIC_PROGRESS_STATUSES.filter((status) => counts[status] > 0);
      // Largest-remainder so the bar sums to 100% without inventing empty stages.
      const floors = activeStatuses.map((status) => {
        const exact = total === 0 ? 0 : (counts[status] / total) * 100;
        return { status, floor: Math.floor(exact), frac: exact - Math.floor(exact) };
      });
      let remain = total === 0 ? 0 : 100 - floors.reduce((sum, s) => sum + s.floor, 0);
      floors
        .slice()
        .sort((a, b) => b.frac - a.frac)
        .forEach((s) => {
          if (remain <= 0) return;
          s.floor += 1;
          remain -= 1;
        });
      const pctByStatus = Object.fromEntries(floors.map((s) => [s.status, s.floor])) as Partial<
        Record<TicketStatus, number>
      >;
      const segments = activeStatuses.map((status) => ({
        status,
        count: counts[status],
        pct: pctByStatus[status] ?? 0,
      }));
      return {
        id: epic.id,
        title: epic.title,
        totalCount: total,
        donePct: total === 0 ? 0 : Math.round((counts.done / total) * 100),
        segments,
      };
    });
  }, [tickets]);

  const dueSoonCount = useMemo(() => {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const next7 = new Date(now);
    next7.setDate(now.getDate() + 7);
    return tickets.filter((t) => {
      if (!t.dueDate || t.status === 'done') return false;
      const d = new Date(t.dueDate);
      if (Number.isNaN(d.getTime())) return false;
      d.setHours(0, 0, 0, 0);
      return d >= now && d <= next7;
    }).length;
  }, [tickets]);

  // Approx: done issues whose row was last touched in the window (no bulk “completed at” field yet).
  const completedLast7 = useMemo(
    () =>
      tickets.filter(
        (t) => t.status === 'done' && isWithinLastDays(t.updatedAt ?? t.createdAt, 7),
      ).length,
    [tickets],
  );
  const createdLast7 = useMemo(
    () => tickets.filter((t) => isWithinLastDays(t.createdAt, 7)).length,
    [tickets],
  );
  const updatedLast7 = useMemo(
    () => tickets.filter((t) => isWithinLastDays(t.updatedAt ?? t.createdAt, 7)).length,
    [tickets],
  );

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
          <p className="summary-card__hint">Hover a column for “count / total”. “None” is issues without a priority.</p>
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
          <p className="summary-card__hint">Get a breakdown of work items by their types.</p>
          <div className="summary-worktypes__header" aria-hidden>
            <span>Type</span>
            <span>Distribution</span>
          </div>
          <div className="summary-worktypes">
            {issueTypes.map((it) => {
              const ratioTip = tickets.length > 0 ? `${it.count} / ${tickets.length}` : '0 / 0';
              return (
                <div
                  key={it.type}
                  className="summary-worktypes__row"
                  aria-label={`${it.meta.label}, ${ratioTip}, ${it.pct}%`}
                >
                  <div className="summary-hover-tooltip">
                    {it.meta.label}: {ratioTip} ({it.pct}%)
                  </div>
                  <span className="summary-worktypes__name">
                    <span
                      className="summary-worktypes__icon"
                      style={{ background: it.meta.color }}
                      aria-hidden
                    >
                      {it.meta.icon}
                    </span>
                    {it.meta.label}
                  </span>
                  <div className="summary-worktypes__bar-wrap">
                    <div
                      className="summary-worktypes__bar"
                      style={{ width: `${it.pct}%`, background: it.meta.color }}
                    >
                      {it.pct >= 10 && <span>{it.pct}%</span>}
                    </div>
                    {it.pct > 0 && it.pct < 10 && (
                      <span className="summary-worktypes__small-value">{it.pct}%</span>
                    )}
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
                  <div key={a.id} className="summary-workload__row" aria-label={`${a.name}, ${ratioTip}, ${pct}%`}>
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
            {EPIC_PROGRESS_STATUSES.map((status) => (
              <span key={status}>
                <i style={{ background: STATUS_COLORS[status] }} /> {STATUS_LABELS[status]}
              </span>
            ))}
          </div>
          {epicProgress.length === 0 ? (
            <p className="summary-empty">No epics yet.</p>
          ) : (
            <div className="summary-epics">
              {epicProgress.map((e) => (
                <div key={e.id} className="summary-epics__row">
                  <div className="summary-epics__head">
                    <span>{e.id} {e.title}</span>
                    <span>{e.totalCount === 0 ? 'No child issues' : `${e.donePct}% done`}</span>
                  </div>
                  <div className="summary-epics__stack">
                    <div className="summary-epics__stack-track">
                      {e.segments.map((seg) => (
                        <span
                          key={seg.status}
                          title={`${STATUS_LABELS[seg.status]}: ${seg.count}`}
                          style={{ width: `${seg.pct}%`, background: STATUS_COLORS[seg.status] }}
                        />
                      ))}
                    </div>
                    <div className="summary-epics__tooltip">
                      {e.segments.map((seg) => (
                        <p key={seg.status}>
                          {STATUS_LABELS[seg.status]}: {seg.count}
                        </p>
                      ))}
                      <p>Total: {e.totalCount}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </article>
      </section>

    </div>
  );
}
