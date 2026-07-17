import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTickets } from '../context/TicketContext';
import { ISSUE_TYPE_META } from '../types/ticket';
import type { Ticket, TicketStatus } from '../types/ticket';
import { IssueKeyChip } from './IssueKeyChip';
import './IssueQuickSearch.css';

/** First paint size. */
const INITIAL_VISIBLE = 8;
/** How many extra rows each “Show more” click adds. */
const PAGE_SIZE = 2;
/** Soft cap so a huge space cannot freeze the dropdown. */
const HARD_CAP = 10;

const STATUS_LABELS: Record<TicketStatus, string> = {
  planned: 'Planned',
  in_progress: 'In Progress',
  blocked: 'Blocked',
  in_review: 'In Review',
  done: 'Done',
};

const STATUS_COLORS: Record<TicketStatus, string> = {
  planned: '#8b5cf6',
  in_progress: '#3b82f6',
  blocked: '#ef4444',
  in_review: '#f59e0b',
  done: '#10b981',
};

/** Rank matches: issue-key hit first, then title-start, then any substring. */
function scoreMatch(ticket: Ticket, q: string): number | null {
  const key = ticket.id.toLowerCase();
  const title = ticket.title.toLowerCase();
  const assignee = (ticket.assignee ?? '').toLowerCase();
  if (key === q) return 0;
  if (key.startsWith(q)) return 1;
  if (key.includes(q)) return 2;
  if (title.startsWith(q)) return 3;
  if (title.includes(q)) return 4;
  if (assignee.includes(q)) return 5;
  return null;
}

function createdAtMs(t: Ticket): number {
  if (!t.createdAt) return 0;
  const ms = Date.parse(t.createdAt);
  return Number.isFinite(ms) ? ms : 0;
}

export function IssueQuickSearch() {
  const navigate = useNavigate();
  const { tickets } = useTickets();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const rankedMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [] as Ticket[];
    return tickets
      .map((t) => ({ t, score: scoreMatch(t, q) }))
      .filter((r): r is { t: Ticket; score: number } => r.score !== null)
      .sort((a, b) => {
        // 1) Better match quality first
        if (a.score !== b.score) return a.score - b.score;
        // 2) Same quality → newest first (Jira-like recency)
        const byTime = createdAtMs(b.t) - createdAtMs(a.t);
        if (byTime !== 0) return byTime;
        // 3) Stable fallback
        return a.t.id.localeCompare(b.t.id);
      })
      .map((r) => r.t);
  }, [tickets, query]);

  const totalMatched = rankedMatches.length;
  const cappedPool = rankedMatches.slice(0, HARD_CAP);
  const results = cappedPool.slice(0, visibleCount);
  const canShowMoreInDropdown = results.length < cappedPool.length;
  const nextBatch = Math.min(PAGE_SIZE, cappedPool.length - results.length);
  const remainingOutsideCap = Math.max(0, totalMatched - HARD_CAP);

  useEffect(() => {
    setActiveIndex(0);
    setVisibleCount(INITIAL_VISIBLE);
  }, [query]);

  // ⌘K / Ctrl+K focuses the search from anywhere.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  const goTo = useCallback(
    (id: string) => {
      setOpen(false);
      setQuery('');
      setVisibleCount(INITIAL_VISIBLE);
      inputRef.current?.blur();
      navigate(`/ticket/${id}`);
    },
    [navigate],
  );

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      if (query) setQuery('');
      else setOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (!open || results.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + results.length) % results.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const chosen = results[activeIndex];
      if (chosen) goTo(chosen.id);
    }
  }

  const showDropdown = open && query.trim().length > 0;

  return (
    <div className="iqs" ref={rootRef}>
      <input
        ref={inputRef}
        type="search"
        className="top-nav__search-input"
        placeholder="Search issues (⌘K)"
        aria-label="Search issues"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        role="combobox"
        aria-expanded={showDropdown}
        aria-controls="iqs-listbox"
        autoComplete="off"
      />

      {showDropdown && (
        <div className="iqs__dropdown" id="iqs-listbox" role="listbox">
          {totalMatched === 0 ? (
            <div className="iqs__empty">No issues match “{query.trim()}”.</div>
          ) : (
            <>
              <div className="iqs__meta" aria-live="polite">
                {totalMatched} issue{totalMatched === 1 ? '' : 's'}
                {totalMatched > results.length && (
                  <span className="iqs__meta-hint">
                    {' '}
                    · showing {results.length}
                    {remainingOutsideCap > 0 || canShowMoreInDropdown ? ` of ${Math.min(totalMatched, HARD_CAP)}` : ''}
                  </span>
                )}
              </div>
              {results.map((t, i) => {
                const meta = t.issueType ? ISSUE_TYPE_META[t.issueType] : undefined;
                const status = t.status;
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="option"
                    aria-selected={i === activeIndex}
                    className={`iqs__item${i === activeIndex ? ' iqs__item--active' : ''}`}
                    onMouseEnter={() => setActiveIndex(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => goTo(t.id)}
                  >
                    {meta && (
                      <span className="iqs__type" style={{ color: meta.color }} title={meta.label} aria-hidden>
                        {meta.icon}
                      </span>
                    )}
                    <IssueKeyChip issueKey={t.id} size="sm" />
                    <span className="iqs__title">{t.title}</span>
                    {status && (
                      <span
                        className="iqs__status"
                        style={{ color: STATUS_COLORS[status], borderColor: STATUS_COLORS[status] }}
                      >
                        {STATUS_LABELS[status]}
                      </span>
                    )}
                  </button>
                );
              })}
              {canShowMoreInDropdown && (
                <button
                  type="button"
                  className="iqs__more"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setVisibleCount((n) => Math.min(n + PAGE_SIZE, HARD_CAP));
                    setActiveIndex(0);
                  }}
                >
                  Show {nextBatch} more
                </button>
              )}
              {!canShowMoreInDropdown && remainingOutsideCap > 0 && (
                <div className="iqs__cap-note">
                  {remainingOutsideCap} more match — refine your keyword to narrow results.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
