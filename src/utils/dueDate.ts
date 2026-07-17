const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const EXPLICIT_TIME_PATTERN = /(?:T|\s)\d{1,2}:\d{2}/i;

function isDateOnlyValue(value: string): boolean {
  return !EXPLICIT_TIME_PATTERN.test(value);
}

/**
 * Jira-style due dates are date-only values. Treat their deadline as the end
 * of the selected day so a due-today issue is not overdue at midnight.
 */
export function parseDueDate(value?: string): Date | null {
  if (!value) return null;
  const dateOnly = DATE_ONLY_PATTERN.exec(value);
  const parsed = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 23, 59, 59, 999)
    : new Date(value);
  if (!dateOnly && !Number.isNaN(parsed.getTime()) && isDateOnlyValue(value)) {
    parsed.setHours(23, 59, 59, 999);
  }
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatDueDateWithTime(value?: string): string {
  const parsed = parseDueDate(value);
  if (!parsed) return 'No due date';

  const dateLabel = parsed.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const timeLabel = isDateOnlyValue(value ?? '')
    ? '11:59 PM'
    : parsed.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  return `${dateLabel}, ${timeLabel}`;
}
