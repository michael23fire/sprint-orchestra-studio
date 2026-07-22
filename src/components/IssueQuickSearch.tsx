import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTickets } from '../context/TicketContext';
import { useSpaces } from '../context/SpaceContext';
import { ISSUE_TYPE_META } from '../types/ticket';
import type { Ticket, TicketStatus } from '../types/ticket';
import { searchApi } from '../api';
import type { SearchResultDto } from '../api';
import { IssueKeyChip } from './IssueKeyChip';
import './IssueQuickSearch.css';

/** First paint size. */
const INITIAL_VISIBLE = 8;
/** How many extra rows each “Show more” click adds. */
const PAGE_SIZE = 2;
/** Soft cap so a huge space cannot freeze the dropdown. */
const HARD_CAP = 10;
/** Debounce for the backend full-text call — avoid firing on every keystroke. */
const REMOTE_DEBOUNCE_MS = 300;
/** Don't hit the backend for single-character queries; too noisy, too broad. */
const REMOTE_MIN_QUERY_LENGTH = 2;
/** Cross-space / comment hits shown below the quick-jump list. */
const REMOTE_LIMIT = 8;

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

type CombinedItem =
  | { kind: 'local'; ticket: Ticket }
  | { kind: 'remote'; hit: SearchResultDto };

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

/**
 * The backend wraps matched terms in literal "<b>"/"</b>" (Postgres `ts_headline`
 * defaults). Snippets come from user-authored issue/comment text, so they must never
 * be interpreted as HTML — split on the literal markers and render everything as text
 * nodes instead of using dangerouslySetInnerHTML.
 */
function renderSnippet(snippet: string): ReactNode[] {
  const parts = snippet.split(/(<b>|<\/b>)/);
  const nodes: ReactNode[] = [];
  let highlighting = false;
  parts.forEach((part, i) => {
    if (part === '<b>') {
      highlighting = true;
      return;
    }
    if (part === '</b>') {
      highlighting = false;
      return;
    }
    if (!part) return;
    nodes.push(
      highlighting ? (
        <mark key={i} className="iqs__mark">
          {part}
        </mark>
      ) : (
        <span key={i}>{part}</span>
      ),
    );
  });
  return nodes;
}

export function IssueQuickSearch() {
  const navigate = useNavigate();
  const { tickets } = useTickets();
  const { spaces, currentSpace, setCurrentSpace } = useSpaces();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);
  const [remoteResults, setRemoteResults] = useState<SearchResultDto[]>([]);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestIdRef = useRef(0);

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

  // The quick-jump list above already covers title/key matches in the current space;
  // don't repeat the same issue in the full-text section below it.
  const localIds = useMemo(() => new Set(rankedMatches.map((t) => t.id)), [rankedMatches]);
  const dedupedRemote = useMemo(
    () => remoteResults.filter((r) => !(r.type === 'ISSUE' && localIds.has(r.issueKey))),
    [remoteResults, localIds],
  );

  const spaceById = useMemo(() => new Map(spaces.map((s) => [Number(s.id), s])), [spaces]);

  const combined: CombinedItem[] = useMemo(
    () => [
      ...results.map((ticket): CombinedItem => ({ kind: 'local', ticket })),
      ...dedupedRemote.map((hit): CombinedItem => ({ kind: 'remote', hit })),
    ],
    [results, dedupedRemote],
  );

  useEffect(() => {
    setActiveIndex(0);
    setVisibleCount(INITIAL_VISIBLE);
  }, [query]);

  // Debounced cross-space + comment full-text search (backend `/api/search`).
  // Every state update happens inside the timeout callback (an async boundary),
  // never synchronously in the effect body, to avoid cascading renders.
  useEffect(() => {
    const q = query.trim();
    const requestId = ++requestIdRef.current;
    const tooShort = q.length < REMOTE_MIN_QUERY_LENGTH;
    const handle = setTimeout(
      () => {
        if (requestIdRef.current !== requestId) return;
        if (tooShort) {
          setRemoteResults([]);
          setRemoteLoading(false);
          return;
        }
        setRemoteLoading(true);
        searchApi
          .search(q, REMOTE_LIMIT)
          .then((hits) => {
            if (requestIdRef.current === requestId) setRemoteResults(hits);
          })
          .catch(() => {
            if (requestIdRef.current === requestId) setRemoteResults([]);
          })
          .finally(() => {
            if (requestIdRef.current === requestId) setRemoteLoading(false);
          });
      },
      tooShort ? 0 : REMOTE_DEBOUNCE_MS,
    );
    return () => clearTimeout(handle);
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

  const resetAndClose = useCallback(() => {
    setOpen(false);
    setQuery('');
    setVisibleCount(INITIAL_VISIBLE);
    inputRef.current?.blur();
  }, []);

  const goTo = useCallback(
    (id: string) => {
      resetAndClose();
      navigate(`/ticket/${id}`);
    },
    [navigate, resetAndClose],
  );

  const goToRemote = useCallback(
    (hit: SearchResultDto) => {
      resetAndClose();
      if (Number(currentSpace.id) !== hit.spaceId) {
        const target = spaceById.get(hit.spaceId);
        if (target) setCurrentSpace(target);
      }
      navigate(`/ticket/${hit.issueKey}`);
    },
    [resetAndClose, currentSpace.id, spaceById, setCurrentSpace, navigate],
  );

  const selectItem = useCallback(
    (item: CombinedItem) => {
      if (item.kind === 'local') goTo(item.ticket.id);
      else goToRemote(item.hit);
    },
    [goTo, goToRemote],
  );

  /**
   * Rows are real <a> (via Link) so right-click / Cmd-click / middle-click give the
   * browser's native "open in new tab". Only intercept plain-left-clicks to keep the
   * existing in-app dropdown behavior (close + client-side navigate, possibly a space
   * switch for remote hits); everything else is left to the browser.
   */
  function shouldHandleAsPlainClick(e: React.MouseEvent): boolean {
    return !e.defaultPrevented && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      if (query) setQuery('');
      else setOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (!open || combined.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % combined.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + combined.length) % combined.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const chosen = combined[activeIndex];
      if (chosen) selectItem(chosen);
    }
  }

  const showDropdown = open && query.trim().length > 0;
  const showRemoteSection = query.trim().length >= REMOTE_MIN_QUERY_LENGTH;

  return (
    <div className="iqs" ref={rootRef}>
      <input
        ref={inputRef}
        type="search"
        className="top-nav__search-input"
        placeholder="Search issues & comments (⌘K)"
        aria-label="Search issues and comments"
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
            <div className="iqs__empty">No issues match “{query.trim()}” in this space.</div>
          ) : (
            <>
              <div className="iqs__meta" aria-live="polite">
                {totalMatched} issue{totalMatched === 1 ? '' : 's'} in this space
                {totalMatched > results.length && (
                  <span className="iqs__meta-hint">
                    {' '}
                    · showing {results.length}
                    {remainingOutsideCap > 0 || canShowMoreInDropdown ? ` of ${Math.min(totalMatched, HARD_CAP)}` : ''}
                  </span>
                )}
              </div>
              {results.map((t) => {
                const i = combined.findIndex((c) => c.kind === 'local' && c.ticket.id === t.id);
                const meta = t.issueType ? ISSUE_TYPE_META[t.issueType] : undefined;
                const status = t.status;
                return (
                  <Link
                    key={t.id}
                    to={`/ticket/${t.id}`}
                    role="option"
                    aria-selected={i === activeIndex}
                    className={`iqs__item${i === activeIndex ? ' iqs__item--active' : ''}`}
                    onMouseEnter={() => setActiveIndex(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                      if (!shouldHandleAsPlainClick(e)) return;
                      e.preventDefault();
                      goTo(t.id);
                    }}
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
                  </Link>
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

          {showRemoteSection && (
            <>
              <div className="iqs__section-label">
                All spaces &amp; comments
                {remoteLoading && <span className="iqs__loading-dot" aria-hidden />}
              </div>
              {dedupedRemote.length === 0 && !remoteLoading && (
                <div className="iqs__empty iqs__empty--remote">
                  No full-text matches for “{query.trim()}”.
                </div>
              )}
              {dedupedRemote.map((hit) => {
                const i = combined.findIndex(
                  (c) => c.kind === 'remote' && c.hit.type === hit.type && c.hit.issueId === hit.issueId,
                );
                const space = spaceById.get(hit.spaceId);
                return (
                  <Link
                    key={`${hit.type}-${hit.issueId}`}
                    to={`/ticket/${hit.issueKey}`}
                    role="option"
                    aria-selected={i === activeIndex}
                    className={`iqs__remote-item${i === activeIndex ? ' iqs__item--active' : ''}`}
                    onMouseEnter={() => setActiveIndex(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                      if (!shouldHandleAsPlainClick(e)) return;
                      e.preventDefault();
                      goToRemote(hit);
                    }}
                  >
                    <div className="iqs__remote-row">
                      <span
                        className={`iqs__remote-type iqs__remote-type--${hit.type.toLowerCase()}`}
                        title={hit.type === 'COMMENT' ? 'Comment match' : 'Issue match'}
                      >
                        {hit.type === 'COMMENT' ? (
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                          </svg>
                        ) : (
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                            <path d="M14 2v6h6" />
                          </svg>
                        )}
                      </span>
                      <IssueKeyChip issueKey={hit.issueKey} size="sm" />
                      <span className="iqs__title">{hit.title}</span>
                      {hit.matchType === 'FUZZY' && (
                        <span className="iqs__fuzzy-badge" title="Fuzzy match — close spelling or partial word, not an exact hit">
                          ~ fuzzy
                        </span>
                      )}
                      {space && (
                        <span className="iqs__space-badge" style={{ borderColor: space.color, color: space.color }}>
                          {space.key}
                        </span>
                      )}
                    </div>
                    {hit.snippet && <div className="iqs__snippet">{renderSnippet(hit.snippet)}</div>}
                  </Link>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}
