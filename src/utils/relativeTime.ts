/**
 * Compact relative time for dense UI (Code page, etc.): "2h ago", "3d ago".
 * Empty string if no ISO value.
 */
export function formatRelativeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function formatRelativeAgoOrNever(iso: string | null | undefined): string {
  if (!iso) return 'never';
  return formatRelativeAgo(iso) || 'never';
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Jira Cloud issue view: relative for the first 7 days, absolute after (JRACLOUD-41506). */
const JIRA_RELATIVE_WINDOW = 7 * DAY;

export function formatAbsoluteActivityTime(isoOrTs: string | null | undefined): string {
  if (!isoOrTs) return '';
  const d = new Date(isoOrTs);
  if (Number.isNaN(d.getTime())) return isoOrTs;
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * Jira-style activity timestamps (comments / history / All feed):
 * - ≤ 7 days → relative ("just now", "5 minutes ago", "Yesterday", "3 days ago")
 * - > 7 days → absolute ("Jul 8, 09:40 PM")
 */
export function formatJiraActivityTime(isoOrTs: string | null | undefined): string {
  if (!isoOrTs) return '';
  const d = new Date(isoOrTs);
  if (Number.isNaN(d.getTime())) return isoOrTs;
  const diff = Date.now() - d.getTime();
  if (diff < JIRA_RELATIVE_WINDOW) {
    if (diff < MINUTE) return 'just now';
    if (diff < HOUR) {
      const m = Math.floor(diff / MINUTE);
      return `${m} ${m === 1 ? 'minute' : 'minutes'} ago`;
    }
    if (diff < DAY) {
      const h = Math.floor(diff / HOUR);
      return `${h} ${h === 1 ? 'hour' : 'hours'} ago`;
    }
    const days = Math.floor(diff / DAY);
    if (days <= 1) return 'Yesterday';
    return `${days} days ago`;
  }
  return formatAbsoluteActivityTime(isoOrTs);
}
