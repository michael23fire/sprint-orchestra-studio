import type { IssueHistoryDto } from '../api/historyApi';

const STATUS_LABELS: Record<string, string> = {
  planned: 'Planned',
  in_progress: 'In Progress',
  blocked: 'Blocked',
  in_review: 'In Review',
  done: 'Done',
};

/** CSS var names in Board.css (`--color-planned`, …) for lifecycle bar segments. */
export const STATUS_LIFECYCLE_CSS_VAR: Record<string, string> = {
  planned: 'var(--color-planned)',
  in_progress: 'var(--color-in-progress)',
  blocked: 'var(--color-blocked)',
  in_review: 'var(--color-in-review)',
  done: 'var(--color-done)',
};

export function statusLifecycleSegmentColor(status: string): string {
  return STATUS_LIFECYCLE_CSS_VAR[status] ?? '#94a3b8';
}

export function formatStatusLabel(key: string | null | undefined): string {
  if (key == null || key === '') return '—';
  return STATUS_LABELS[key] ?? key.replace(/_/g, ' ');
}

export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 60_000) return '< 1 min';
  const m = Math.floor(ms / 60_000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m} min`;
}

/** Rounded to whole minutes (e.g. bar tooltip). Omits trailing `0 min` when days/hours present. */
export function formatDurationMinutePrecision(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalMin = Math.max(0, Math.round(ms / 60_000));
  if (totalMin === 0) return '0 min';
  const d = Math.floor(totalMin / (60 * 24));
  const h = Math.floor((totalMin % (60 * 24)) / 60);
  const m = totalMin % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m} min`);
  if (parts.length === 0) return '0 min';
  return parts.join(' ');
}

export interface StatusLifecycleSegment {
  status: string;
  statusLabel: string;
  startedAtIso: string;
  endedAtIso: string | null;
  durationMs: number;
  isOngoing: boolean;
}

/** Issue closed at this point: no ongoing time in Done (reopen would add more history). */
export function isInstantTerminalDone(seg: StatusLifecycleSegment): boolean {
  return seg.status === 'done' && seg.durationMs === 0;
}

/**
 * Reconstructs time-in-status from issue creation and `field_change` history rows (status).
 */
export function buildStatusLifecycle(
  history: IssueHistoryDto[],
  issueCreatedAtIso: string | undefined,
  currentStatus: string,
): StatusLifecycleSegment[] {
  if (!issueCreatedAtIso) return [];

  const createdMs = new Date(issueCreatedAtIso).getTime();
  if (Number.isNaN(createdMs)) return [];

  const transitions = history
    .filter((h) => h.eventType === 'field_change' && h.fieldName === 'status')
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  const now = Date.now();

  if (transitions.length === 0) {
    const closed = currentStatus === 'done';
    return [
      {
        status: currentStatus,
        statusLabel: formatStatusLabel(currentStatus),
        startedAtIso: issueCreatedAtIso,
        endedAtIso: closed ? issueCreatedAtIso : null,
        durationMs: closed ? 0 : now - createdMs,
        isOngoing: !closed,
      },
    ];
  }

  const segments: StatusLifecycleSegment[] = [];
  for (let i = 0; i < transitions.length; i++) {
    const tr = transitions[i];
    const startMs = i === 0 ? createdMs : new Date(transitions[i - 1].createdAt).getTime();
    const endMs = new Date(tr.createdAt).getTime();
    const st = tr.fromValue ?? (i === 0 ? 'planned' : (transitions[i - 1].toValue ?? 'planned'));
    segments.push({
      status: st,
      statusLabel: formatStatusLabel(st),
      startedAtIso: new Date(startMs).toISOString(),
      endedAtIso: tr.createdAt,
      durationMs: endMs - startMs,
      isOngoing: false,
    });
  }
  const last = transitions[transitions.length - 1];
  const lastStart = new Date(last.createdAt).getTime();
  const finalSt = last.toValue ?? currentStatus;
  if (finalSt === 'done') {
    segments.push({
      status: 'done',
      statusLabel: formatStatusLabel('done'),
      startedAtIso: last.createdAt,
      endedAtIso: last.createdAt,
      durationMs: 0,
      isOngoing: false,
    });
  } else {
    segments.push({
      status: finalSt,
      statusLabel: formatStatusLabel(finalSt),
      startedAtIso: last.createdAt,
      endedAtIso: null,
      durationMs: now - lastStart,
      isOngoing: finalSt === currentStatus,
    });
  }
  return segments;
}

/** Tooltip / aria text for one bar slice. */
export function formatLifecycleSegmentSummary(seg: StatusLifecycleSegment): string {
  if (isInstantTerminalDone(seg)) {
    return `${seg.statusLabel} · Completed ${formatLifecycleDate(seg.endedAtIso ?? seg.startedAtIso)}`;
  }
  const range = seg.endedAtIso
    ? `${formatLifecycleDate(seg.startedAtIso)} → ${formatLifecycleDate(seg.endedAtIso)}`
    : `${formatLifecycleDate(seg.startedAtIso)} → …`;
  return `${seg.statusLabel} · ${formatDurationMinutePrecision(seg.durationMs)} · ${range}${seg.isOngoing ? ' (current)' : ''}`;
}

export function formatLifecycleDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}
