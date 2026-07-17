import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useSpaces } from '../context/SpaceContext';
import { useTickets } from '../context/TicketContext';
import { useCurrentUser } from '../context/UserContext';
import { TicketDetailModal } from '../components/TicketDetailModal';
import { codeLinkApi, githubRepoApi } from '../api';
import type {
  IssueCodeLinkDto,
  SpaceGithubRepoDto,
  ScanResult,
} from '../api';
import './Code.css';
import { normalizeGithubAccountInput } from '../utils/githubAccount';
import { formatRelativeAgo, formatRelativeAgoOrNever } from '../utils/relativeTime';

const KIND_META: Record<'pull_request', { icon: string; label: string; badge: string }> = {
  pull_request: { icon: '⇅', label: 'Pull requests linked to issues', badge: 'PR' },
};

/** Code page is PR-only. Branch/commit/repo/other links may exist on issues but are not listed here. */
const KIND_ORDER: Array<'pull_request'> = ['pull_request'];

type ViewMode = 'active' | 'all';

const ACTIVE_PR_STATES = new Set(['open', 'draft']);
const PAGE_SIZE = 50;

function parseBackendSpaceId(id: string): number | null {
  const t = id.trim();
  if (!t || !/^\d+$/.test(t)) return null;
  const n = parseInt(t, 10);
  return n > 0 ? n : null;
}

export function Code() {
  const { currentSpace } = useSpaces();
  const { currentUser } = useCurrentUser();
  const {
    tickets,
    sprints,
    refreshData,
    deleteCodeLink,
    updateTicket,
    createSubtask,
    deleteTicket,
    addComment,
    editComment,
    deleteComment,
    addIssueLink,
    deleteIssueLink,
    addCodeLink,
    refreshCodeLinks,
    hydrateIssueDetail,
  } = useTickets();
  const [searchParams, setSearchParams] = useSearchParams();
  const spaceDbId = parseBackendSpaceId(currentSpace.id);

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

  const [links, setLinks] = useState<IssueCodeLinkDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('active');
  /** Selected owner/repo keys; empty = all repos. */
  const [repoFilters, setRepoFilters] = useState<string[]>([]);
  const [repoMenuOpen, setRepoMenuOpen] = useState(false);
  const repoMenuRef = useRef<HTMLDivElement>(null);
  const [groupLimits, setGroupLimits] = useState<Record<'pull_request', number>>({
    pull_request: PAGE_SIZE,
  });
  const [banner, setBanner] = useState<{ text: string; tone: 'error' | 'success' | 'info' } | null>(null);

  const [repos, setRepos] = useState<SpaceGithubRepoDto[]>([]);
  const [repoInput, setRepoInput] = useState('');
  const [repoError, setRepoError] = useState<string | null>(null);
  const [repoAdding, setRepoAdding] = useState(false);
  const [accountInput, setAccountInput] = useState('');
  const [bulkImportToken, setBulkImportToken] = useState('');
  const [accountImporting, setAccountImporting] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [repoModalOpen, setRepoModalOpen] = useState(false);

  const loadLinks = useCallback(() => {
    if (spaceDbId == null) return;
    setLoading(true);
    codeLinkApi.getBySpace(spaceDbId)
      .then((items) => setLinks(items))
      .catch((err) => {
        setLinks([]);
        setBanner({ text: err instanceof Error ? err.message : 'Failed to load code links', tone: 'error' });
      })
      .finally(() => setLoading(false));
  }, [spaceDbId]);

  const loadRepos = useCallback(() => {
    if (spaceDbId == null) return;
    githubRepoApi.list(spaceDbId)
      .then((items) => setRepos(items))
      .catch((err) => {
        setRepos([]);
        setBanner({ text: err instanceof Error ? err.message : 'Failed to load repositories', tone: 'error' });
      });
  }, [spaceDbId]);

  useEffect(() => {
    setBanner(null);
    loadLinks();
    loadRepos();
  }, [loadLinks, loadRepos]);

  useEffect(() => {
    setGroupLimits({ pull_request: PAGE_SIZE });
  }, [viewMode, repoFilters, search]);

  useEffect(() => {
    if (!repoMenuOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (repoMenuRef.current && !repoMenuRef.current.contains(e.target as Node)) {
        setRepoMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [repoMenuOpen]);

  /** Only connected space repos — avoids stale entries after disconnect / GitHub delete. */
  const repoOptions = useMemo(
    () => (repos ?? []).map((r) => `${r.owner}/${r.repo}`).sort(),
    [repos],
  );

  useEffect(() => {
    setRepoFilters((prev) => {
      const next = prev.filter((r) => repoOptions.includes(r));
      return next.length === prev.length ? prev : next;
    });
  }, [repoOptions]);

  function toggleRepoFilter(repoKey: string) {
    setRepoFilters((prev) =>
      prev.includes(repoKey) ? prev.filter((r) => r !== repoKey) : [...prev, repoKey],
    );
  }

  const issueTitleByKey = useMemo(() => {
    const map: Record<string, string> = {};
    tickets.forEach((t) => { map[t.id] = t.title; });
    return map;
  }, [tickets]);

  const searchActive = search.trim().length > 0;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return links.filter((l) => {
      // Code page is PR-only. Branch/commit/other Development links stay on the issue;
      // whole-repo URLs sync into Connected repositories.
      if (l.kind !== 'pull_request') return false;
      if (viewMode === 'active') {
        const s = (l.state ?? '').toLowerCase();
        if (s && !ACTIVE_PR_STATES.has(s)) return false;
      }
      if (repoFilters.length > 0) {
        const rf = l.owner && l.repo ? `${l.owner}/${l.repo}` : '';
        if (!repoFilters.includes(rf)) return false;
      }
      if (!q) return true;
      return (
        (l.title ?? '').toLowerCase().includes(q) ||
        l.url.toLowerCase().includes(q) ||
        l.issueKey.toLowerCase().includes(q) ||
        (l.owner ?? '').toLowerCase().includes(q) ||
        (l.repo ?? '').toLowerCase().includes(q)
      );
    });
  }, [links, viewMode, repoFilters, search]);

  const groups = useMemo(() => {
    const byKind: Record<'pull_request', IssueCodeLinkDto[]> = {
      pull_request: [...filtered],
    };
    const activityMs = (l: IssueCodeLinkDto) => {
      const raw = l.lastActivityAt ?? l.createdAt;
      if (!raw) return 0;
      const t = new Date(raw).getTime();
      return Number.isNaN(t) ? 0 : t;
    };
    const sortByActivity = (a: IssueCodeLinkDto, b: IssueCodeLinkDto) => activityMs(b) - activityMs(a);
    KIND_ORDER.forEach((k) => { byKind[k].sort(sortByActivity); });
    return byKind;
  }, [filtered]);

  const totalCount = filtered.length;

  // ── Actions ────────────────────────────────────────────────────────────
  async function addRepo(e: React.FormEvent) {
    e.preventDefault();
    if (spaceDbId == null || !repoInput.trim()) return;
    setRepoError(null);
    setRepoAdding(true);
    try {
      await githubRepoApi.add(spaceDbId, { target: repoInput.trim() });
      setRepoInput('');
      loadRepos();
    } catch (err) {
      setRepoError(err instanceof Error ? err.message : 'Failed to add repo');
    } finally {
      setRepoAdding(false);
    }
  }

  async function importAllFromAccount(e: React.FormEvent) {
    e.preventDefault();
    if (spaceDbId == null || !accountInput.trim()) return;
    setAccountError(null);
    setAccountImporting(true);
    try {
      const account = normalizeGithubAccountInput(accountInput);
      if (!account) {
        setAccountError('Enter a GitHub username, organization, or profile URL.');
        return;
      }
      const tokenTrim = bulkImportToken.trim();
      const res = await githubRepoApi.bulkImport(spaceDbId, {
        account,
        ...(tokenTrim ? { githubToken: tokenTrim } : {}),
      });
      setAccountInput('');
      setBulkImportToken('');
      loadRepos();
      if (res.discovered === 0) {
        setBanner({
          text: tokenTrim
            ? 'No owned repositories visible with that PAT. Check repo read access (classic: repo scope; fine-grained: select the private repos).'
            : 'No public repositories found for that account. Add a PAT to include private owned repos.',
          tone: 'info',
        });
      } else {
        setBanner({
          text:
            `Imported ${res.added} repo${res.added === 1 ? '' : 's'} from GitHub`
            + (res.skipped > 0 ? ` (${res.skipped} already connected)` : '')
            + ` — ${res.discovered} owned repo${res.discovered === 1 ? '' : 's'} visible`
            + (tokenTrim ? '; PAT saved on this space for Scan/Refresh.' : '.'),
          tone: 'success',
        });
      }
    } catch (err) {
      setAccountError(err instanceof Error ? err.message : 'Bulk import failed');
    } finally {
      setAccountImporting(false);
    }
  }

  async function removeRepo(repoId: number) {
    if (spaceDbId == null) return;
    if (!window.confirm('Disconnect this repository? All Development links for this repo in this space will be removed.')) return;
    try {
      await githubRepoApi.remove(spaceDbId, repoId);
      loadRepos();
      loadLinks();
      refreshData();
    } catch (err) {
      setBanner({ text: err instanceof Error ? err.message : 'Failed to disconnect repo', tone: 'error' });
    }
  }

  async function runScan() {
    if (spaceDbId == null) return;
    setBanner(null);
    setScanResult(null);
    setScanning(true);
    try {
      const result = await githubRepoApi.scan(spaceDbId);
      setScanResult(result);
      loadLinks();
      loadRepos();
      if (result.linksCreated > 0 || (result.reposRemoved ?? 0) > 0) refreshData();
    } catch (err) {
      setBanner({ text: err instanceof Error ? err.message : 'Scan failed', tone: 'error' });
    } finally {
      setScanning(false);
    }
  }

  async function refreshAll() {
    if (spaceDbId == null) return;
    setBanner(null);
    setRefreshing(true);
    try {
      const result = await codeLinkApi.refreshSpace(spaceDbId);
      setBanner({
        text:
          result.checked === 0
            ? 'No pull requests linked to issues in this space yet.'
            : result.updated > 0
              ? `Checked ${result.checked} linked item${result.checked === 1 ? '' : 's'} — ${result.updated} updated from GitHub.`
              : `Checked ${result.checked} linked item${result.checked === 1 ? '' : 's'} — titles and statuses already match GitHub.`,
        tone: result.checked === 0 ? 'info' : 'success',
      });
      loadLinks();
      if (result.updated > 0) refreshData();
    } catch (err) {
      setBanner({ text: err instanceof Error ? err.message : 'Refresh failed', tone: 'error' });
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="code-page">
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
          onAddCodeLink={async (issueDbId, url) => {
            await addCodeLink(issueDbId, url);
            loadLinks();
          }}
          onDeleteCodeLink={async (issueDbId, linkId) => {
            await deleteCodeLink(issueDbId, linkId);
            loadLinks();
          }}
          onRefreshCodeLinks={refreshCodeLinks}
          currentUserId={Number(currentUser.id)}
          onOpenTicket={(id) => openTicket(id)}
          onClose={closeTicket}
        />
      )}
      <div className="code-header-block">
        <div className="code-header">
          <div>
            <h2 className="code-title">Code</h2>
            <p className="code-subtitle">
              Pull requests linked to issues in this space.
            </p>
          </div>
          <div className="code-header-actions">
            <button
              type="button"
              className="code-btn code-btn--ghost code-btn--icon"
              onClick={() => setRepoModalOpen(true)}
              title="Manage connected repositories"
            >
              ⚙ Repositories
              <span className="code-btn-count">{repos.length}</span>
            </button>
            <button
              type="button"
              className="code-btn code-btn--primary"
              onClick={runScan}
              disabled={scanning || repos.length === 0}
              title="Read recent PRs in connected repos and link them to issues when titles/bodies mention an issue key."
            >
              {scanning ? 'Scanning…' : '⟳ Scan repos'}
            </button>
            <button
              type="button"
              className="code-btn code-btn--ghost"
              onClick={refreshAll}
              disabled={refreshing || loading}
              title="Re-fetch title and PR status from GitHub for linked pull requests in this space."
            >
              {refreshing ? 'Refreshing…' : '↻ Refresh all'}
            </button>
          </div>
        </div>
        <div className="code-header-hint">
          <p>
            <strong>1. Repositories</strong> — connect the GitHub repos this space should watch.
            {' '}Public repos can be added by URL alone (no token needed for public API access).
            {' '}For <strong>private</strong> repos, open <strong>Repositories → Import all repos</strong> and paste a PAT
            (saved on this space for Scan/Refresh), or set <code>GITHUB_TOKEN</code> on the server.
          </p>
          <p>
            <strong>2. Scan repos</strong> — finds <em>new</em> pull requests in connected repositories whose title or
            description mentions an issue key (e.g. P1-11), and links them to that issue. Does not change existing links.
          </p>
          <p>
            <strong>3. Refresh all</strong> — re-checks titles and open/merged/closed status on GitHub for
            pull requests already linked to issues. Does not discover new ones.
          </p>
        </div>
      </div>

      {banner && (
        <div
          className={
            banner.tone === 'error'
              ? 'code-banner code-banner--error'
              : banner.tone === 'success'
                ? 'code-banner code-banner--success'
                : 'code-banner'
          }
        >
          {banner.text}
        </div>
      )}
      {scanResult && (
        <div className="code-banner code-banner--success">
          <div className="code-scan-summary">
            {(() => {
              const open = scanResult.openPrs;
              const closed = scanResult.closedPrs;
              const hasSplit = typeof open === 'number' && typeof closed === 'number';
              const total = hasSplit ? open + closed : (scanResult.prsInspected ?? 0);
              return (
                <>
                  Scan complete — inspected{' '}
                  {hasSplit ? (
                    <>
                      <strong>{open}</strong> open and <strong>{closed}</strong> closed PR{total === 1 ? '' : 's'}
                    </>
                  ) : (
                    <>
                      <strong>{total}</strong> PR{total === 1 ? '' : 's'}
                    </>
                  )}
                  {' '}across <strong>{scanResult.reposScanned}</strong> repo{scanResult.reposScanned === 1 ? '' : 's'}.
                  {scanResult.linksCreated > 0 && (
                    <> <strong>{scanResult.linksCreated}</strong> PR{scanResult.linksCreated === 1 ? ' was' : 's were'} linked to issues — see the list below.</>
                  )}
                </>
              );
            })()}
            {(scanResult.reposRemoved ?? 0) > 0 && (
              <>
                {' '}
                Removed <strong>{scanResult.reposRemoved}</strong> connection{scanResult.reposRemoved === 1 ? '' : 's'} that no longer exist on GitHub
                (and cleaned up related Development links).
              </>
            )}
          </div>
          {scanResult.perRepo && scanResult.perRepo.length > 0 && (
            <div className="code-scan-breakdown">
              <div className="code-scan-breakdown-head">
                <span>Repository</span>
                <span>Open</span>
                <span>Closed</span>
                <span>Status</span>
              </div>
              {scanResult.perRepo.map((s) => {
                const hasSplit = typeof s.openPrs === 'number' && typeof s.closedPrs === 'number';
                return (
                  <div key={s.repoId} className={`code-scan-breakdown-row ${s.warning ? 'has-warning' : ''}`}>
                    <span className="code-scan-repo">{s.owner}/{s.repo}</span>
                    <span title={hasSplit ? undefined : `Total inspected: ${s.prsInspected ?? 0} (restart backend for open/closed split)`}>
                      {hasSplit ? s.openPrs : (s.prsInspected ?? 0)}
                    </span>
                    <span>{hasSplit ? s.closedPrs : '—'}</span>
                    <span className="code-scan-status">
                      {s.warning ? <span className="code-scan-warning" title={s.warning}>⚠ error</span> : 'OK'}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          {scanResult.warnings.length > 0 && (
            <div className="code-banner-warnings">
              {scanResult.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
            </div>
          )}
        </div>
      )}

      {/* ── Filters ── */}
      <div className="code-filters">
        <div className="code-view-tabs" role="tablist" aria-label="View">
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === 'active'}
            className={`code-view-tab ${viewMode === 'active' ? 'is-active' : ''}`}
            onClick={() => setViewMode('active')}
          >
            Active
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === 'all'}
            className={`code-view-tab ${viewMode === 'all' ? 'is-active' : ''}`}
            onClick={() => setViewMode('all')}
          >
            All
          </button>
        </div>
        <input
          className="code-search"
          type="search"
          placeholder="Search linked PRs or issue keys…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="code-repo-filter" ref={repoMenuRef}>
          <button
            type="button"
            className={`code-select code-repo-filter__trigger${repoFilters.length > 0 ? ' is-active' : ''}`}
            aria-expanded={repoMenuOpen}
            aria-haspopup="listbox"
            onClick={() => setRepoMenuOpen((o) => !o)}
          >
            {repoFilters.length === 0 ? 'All repos' : `Repos · ${repoFilters.length}`}
            <span className="code-repo-filter__chev" aria-hidden>▾</span>
          </button>
          {repoMenuOpen && (
            <div className="code-repo-filter__menu" role="listbox" aria-multiselectable aria-label="Filter by repository">
              {repoOptions.length === 0 ? (
                <p className="code-repo-filter__empty">No connected repos</p>
              ) : (
                <>
                  {repoFilters.length > 0 && (
                    <button
                      type="button"
                      className="code-repo-filter__clear"
                      onClick={() => setRepoFilters([])}
                    >
                      Clear ({repoFilters.length})
                    </button>
                  )}
                  {repoOptions.map((r) => {
                    const checked = repoFilters.includes(r);
                    return (
                      <label key={r} className={`code-repo-filter__row${checked ? ' is-checked' : ''}`}>
                        <input type="checkbox" checked={checked} onChange={() => toggleRepoFilter(r)} />
                        <span className="code-repo-filter__name" title={r}>{r}</span>
                      </label>
                    );
                  })}
                </>
              )}
            </div>
          )}
        </div>
        <span className="code-count">
          {searchActive
            ? `${totalCount} match${totalCount === 1 ? '' : 'es'}`
            : `${totalCount} ${totalCount === 1 ? 'item' : 'items'}`}
        </span>
      </div>

      {viewMode === 'active' ? (
        <p className="code-view-hint">
          Showing open and draft PRs. Choose <strong>All</strong> to include merged and closed ones.
        </p>
      ) : null}

      {!loading && totalCount === 0 && (
        <div className="code-empty">
          <h3>
            {viewMode === 'active'
              ? 'No open PRs linked to issues'
              : 'No PRs linked to issues'}
          </h3>
          <p>
            {viewMode === 'active'
              ? <>No open or draft pull requests are linked to an issue yet. Switch to <strong>All</strong> for merged/closed, or run <strong>Scan repos</strong>.</>
              : <>Connect repos under <strong>⚙ Repositories</strong>, then run <strong>Scan repos</strong> to find PRs whose title mentions an issue key. You can also paste a PR URL in an issue’s <strong>Development</strong> section.</>
            }
          </p>
        </div>
      )}

      {KIND_ORDER.map((kind) => {
        const items = groups[kind];
        if (!items || items.length === 0) return null;
        const meta = KIND_META[kind];
        const limit = groupLimits[kind];
        const visibleItems = items.slice(0, limit);
        const remaining = items.length - visibleItems.length;
        return (
          <div key={kind} className="code-group">
            <h3 className="code-group-title">
              <span className={`code-group-icon code-group-icon--${kind}`}>{meta.icon}</span>
              {meta.label}
              <span className="code-group-count">{items.length}</span>
            </h3>
            <div className="code-list">
              {visibleItems.map((l) => {
                const subtitle = [
                  l.owner && l.repo ? `${l.owner}/${l.repo}` : null,
                  l.refId ? `#${l.refId}` : null,
                ].filter(Boolean).join(' · ');
                return (
                  <div key={l.id} className="code-row">
                    <span className={`code-row-icon code-row-icon--${l.kind}`}>{meta.icon}</span>
                    <div className="code-row-body">
                      <a
                        className="code-row-title"
                        href={l.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {l.title || l.url}
                      </a>
                      <div className="code-row-sub">
                        <span className="code-row-badge">{meta.badge}</span>
                        {subtitle && <span>{subtitle}</span>}
                        {l.authorLogin && <span>by {l.authorLogin}</span>}
                        {l.state && (
                          <span className={`code-row-state code-row-state--${l.state.toLowerCase()}`}>{l.state}</span>
                        )}
                        {(() => {
                          const rel = formatRelativeAgo(l.lastActivityAt ?? l.createdAt);
                          return rel ? <span className="code-row-time" title={l.lastActivityAt ?? l.createdAt}>{rel}</span> : null;
                        })()}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="code-row-issue"
                      onClick={() => openTicket(l.issueKey)}
                      title={issueTitleByKey[l.issueKey] ?? l.issueKey}
                    >
                      {l.issueKey}
                    </button>
                  </div>
                );
              })}
              {remaining > 0 && (
                <button
                  type="button"
                  className="code-show-more"
                  onClick={() =>
                    setGroupLimits((prev) => ({
                      ...prev,
                      [kind]: prev[kind] + PAGE_SIZE,
                    }))
                  }
                >
                  Show {Math.min(PAGE_SIZE, remaining)} more
                  <span className="code-show-more-meta"> · {remaining} remaining</span>
                </button>
              )}
            </div>
          </div>
        );
      })}

      {/* ── Repo settings modal ── */}
      {repoModalOpen && (
        <div className="code-modal-overlay" onClick={() => setRepoModalOpen(false)}>
          <div className="code-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Connected repositories">
            <div className="code-modal-header">
              <h3>Connected repositories</h3>
              <button
                type="button"
                className="code-modal-close"
                onClick={() => setRepoModalOpen(false)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <div className="code-modal-body">
              <div className="code-repo-hint">
                <p className="code-repo-hint-title">How this works</p>
                <ul className="code-repo-hint-list">
                  <li>
                    <strong>Import all</strong> adds every repository owned by the GitHub username or organization you enter
                    (e.g. <code>octocat</code>).
                  </li>
                  <li>
                    Repos you only collaborate on under someone else’s account are <strong>not</strong> included —
                    use <strong>Add one repo</strong> for those.
                  </li>
                  <li>
                    <strong>Public</strong> owned repos: no token needed.
                    {' '}<strong>Private</strong> owned repos: paste a Personal Access Token (PAT) for that same account
                    (classic token with <code>repo</code> scope, or a fine-grained token with repository read).
                  </li>
                  <li>
                    A PAT you paste is saved on this space (never shown again in the UI) and reused later by
                    {' '}<strong>Scan repos</strong> and <strong>Refresh all</strong> on the Code page.
                  </li>
                </ul>
              </div>
              <form className="code-repo-form code-repo-form--bulk" onSubmit={importAllFromAccount}>
                <div className="code-repo-form-fields">
                  <input
                    className="code-search"
                    type="text"
                    placeholder="Username or org — e.g. octocat"
                    title="The name in https://github.com/NAME — a username or organization, not a repo path"
                    value={accountInput}
                    onChange={(e) => setAccountInput(e.target.value)}
                    aria-label="GitHub username or organization for bulk import"
                  />
                  <input
                    className="code-search"
                    type="password"
                    autoComplete="off"
                    placeholder="PAT — only needed for private repos"
                    title="Must belong to the username/org above. Classic: repo scope. Fine-grained: repository read on the private repos."
                    value={bulkImportToken}
                    onChange={(e) => setBulkImportToken(e.target.value)}
                    aria-label="Optional GitHub personal access token for bulk import"
                  />
                </div>
                <button type="submit" className="code-btn code-btn--primary" disabled={accountImporting || !accountInput.trim()}>
                  {accountImporting ? 'Importing…' : 'Import all repos'}
                </button>
              </form>
              {accountError && <p className="code-repo-error">{accountError}</p>}
              <p className="code-repo-subhint">
                Adds repos owned by that username/org (skips ones already in the list). Not a repo path like{' '}
                <code>octocat/Hello-World</code> — just the account name.
                Leave the PAT empty for public-only. With a PAT for that same account, private owned repos are included and the token is saved for Scan/Refresh.
              </p>
              <form className="code-repo-form code-repo-form--single" onSubmit={addRepo}>
                <input
                  className="code-search"
                  type="text"
                  placeholder="owner/repo — e.g. michael23fire/my-repo"
                  title="One repository: owner/repo or a full GitHub URL"
                  value={repoInput}
                  onChange={(e) => setRepoInput(e.target.value)}
                />
                <button type="submit" className="code-btn code-btn--ghost" disabled={repoAdding || !repoInput.trim()}>
                  {repoAdding ? 'Adding…' : 'Add one repo'}
                </button>
              </form>
              {repoError && <p className="code-repo-error">{repoError}</p>}
              {repos.length === 0 ? (
                <p className="code-repo-empty">No repositories connected yet.</p>
              ) : (
                <div className="code-repo-list">
                  {repos.map((r) => (
                    <div key={r.id} className="code-repo-row">
                      <a
                        className="code-repo-name"
                        href={`https://github.com/${r.owner}/${r.repo}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {r.owner}/{r.repo}
                      </a>
                      <span className="code-repo-meta">last scanned {formatRelativeAgoOrNever(r.lastScannedAt)}</span>
                      <button type="button" className="code-repo-remove" onClick={() => removeRepo(r.id)} title="Disconnect">
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
