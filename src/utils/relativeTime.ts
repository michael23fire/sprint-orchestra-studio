/** Relative time like "2h ago"; empty string if no ISO value. */
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
