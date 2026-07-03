import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSpaces } from '../context/SpaceContext';
import { useTickets } from '../context/TicketContext';
import { codeLinkApi, githubRepoApi } from '../api';
import type {
  IssueCodeLinkDto,
  CodeLinkKind,
  SpaceGithubRepoDto,
  ScanResult,
} from '../api';
import './Code.css';
import { normalizeGithubAccountInput } from '../utils/githubAccount';
import { formatRelativeAgo, formatRelativeAgoOrNever } from '../utils/relativeTime';

const KIND_META: Record<CodeLinkKind, { icon: string; label: string; badge: string }> = {
  pull_request: { icon: '⇅', label: 'Pull requests', badge: 'PR' },
  commit: { icon: '◉', label: 'Commits', badge: 'Commit' },
  branch: { icon: '⎇', label: 'Branches', badge: 'Branch' },
  repo: { icon: '▣', label: 'Repositories', badge: 'Repo' },
  other: { icon: '🔗', label: 'Other links', badge: 'Link' },
};

const KIND_ORDER: CodeLinkKind[] = ['pull_request', 'commit', 'branch', 'repo', 'other'];

type KindFilter = 'all' | CodeLinkKind;
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
  const { tickets, refreshData } = useTickets();
  const navigate = useNavigate();
  const spaceDbId = parseBackendSpaceId(currentSpace.id);

  const [links, setLinks] = useState<IssueCodeLinkDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('active');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [repoFilter, setRepoFilter] = useState<string>('all');
  const [commitsExpanded, setCommitsExpanded] = useState(false);
  const [groupLimits, setGroupLimits] = useState<Record<CodeLinkKind, number>>({
    pull_request: PAGE_SIZE, commit: PAGE_SIZE, branch: PAGE_SIZE, repo: PAGE_SIZE, other: PAGE_SIZE,
  });
  const [banner, setBanner] = useState<string | null>(null);

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
      .catch(() => setLinks([]))
      .finally(() => setLoading(false));
  }, [spaceDbId]);

  const loadRepos = useCallback(() => {
    if (spaceDbId == null) return;
    githubRepoApi.list(spaceDbId).then(setRepos).catch(() => setRepos([]));
  }, [spaceDbId]);

  useEffect(() => { loadLinks(); loadRepos(); }, [loadLinks, loadRepos]);

  useEffect(() => {
    setGroupLimits({
      pull_request: PAGE_SIZE, commit: PAGE_SIZE, branch: PAGE_SIZE, repo: PAGE_SIZE, other: PAGE_SIZE,
    });
  }, [viewMode, kindFilter, repoFilter, search]);

  /** Only connected space repos — avoids stale entries after disconnect / GitHub delete. */
  const repoOptions = useMemo(
    () => (repos ?? []).map((r) => `${r.owner}/${r.repo}`).sort(),
    [repos],
  );

  useEffect(() => {
    if (repoFilter === 'all') return;
    if (!repoOptions.includes(repoFilter)) {
      setRepoFilter('all');
    }
  }, [repoFilter, repoOptions]);

  const issueTitleByKey = useMemo(() => {
    const map: Record<string, string> = {};
    tickets.forEach((t) => { map[t.id] = t.title; });
    return map;
  }, [tickets]);

  const searchActive = search.trim().length > 0;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return links.filter((l) => {
      // When the user types into search, go global: ignore Active/All and
      // the Type filter so they can find any link in the space.
      if (!searchActive) {
        if (viewMode === 'active') {
          if (l.kind !== 'pull_request') return false;
          const s = (l.state ?? '').toLowerCase();
          if (s && !ACTIVE_PR_STATES.has(s)) return false;
        } else if (kindFilter !== 'all' && l.kind !== kindFilter) {
          return false;
        }
      }
      if (repoFilter !== 'all') {
        const rf = l.owner && l.repo ? `${l.owner}/${l.repo}` : '';
        if (rf !== repoFilter) return false;
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
  }, [links, viewMode, kindFilter, repoFilter, search, searchActive]);

  const groups = useMemo(() => {
    const byKind: Record<CodeLinkKind, IssueCodeLinkDto[]> = {
      pull_request: [], commit: [], branch: [], repo: [], other: [],
    };
    filtered.forEach((l) => { byKind[l.kind].push(l); });
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
        setBanner('No repositories returned for that account (may need a GitHub token for private repos).');
      } else {
        setBanner(
          `Imported ${res.added} repo${res.added === 1 ? '' : 's'} from GitHub`
            + (res.skipped > 0 ? ` (${res.skipped} already connected)` : '')
            + ` — ${res.discovered} visible in total.`,
        );
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
      setBanner(err instanceof Error ? err.message : 'Failed to disconnect repo');
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
      setBanner(err instanceof Error ? err.message : 'Scan failed');
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
      setBanner(
        result.checked === 0
          ? 'No code links in this space yet.'
          : result.updated > 0
            ? `Refreshed ${result.checked} link${result.checked === 1 ? '' : 's'} — ${result.updated} updated from GitHub.`
            : `Checked ${result.checked} link${result.checked === 1 ? '' : 's'} — no metadata changes (bulk-import with a PAT in Repositories to store one for this space, or set server GITHUB_TOKEN).`,
      );
      loadLinks();
      if (result.updated > 0) refreshData();
    } catch (err) {
      setBanner(err instanceof Error ? err.message : 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="code-page">
      <div className="code-header-block">
        <div className="code-header">
          <div>
            <h2 className="code-title">Code</h2>
            <p className="code-subtitle">
              Pull requests and commits linked to issues in this space.
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
              className="code-btn code-btn--ghost"
              onClick={refreshAll}
              disabled={refreshing || loading}
              title="Re-fetch title and PR status from GitHub for every Development link in this space (needs API access to private repos)."
            >
              {refreshing ? 'Refreshing…' : '↻ Refresh all'}
            </button>
            <button
              type="button"
              className="code-btn code-btn--primary"
              onClick={runScan}
              disabled={scanning || repos.length === 0}
              title="Read recent PRs/commits in connected repos and create new issue links when titles/messages mention an issue key."
            >
              {scanning ? 'Scanning…' : '⟳ Scan repos'}
            </button>
          </div>
        </div>
        <p className="code-header-hint">
          <strong>Scan repos</strong> discovers <em>new</em> links by scanning connected repositories for issue keys (e.g. P1-11) in PR titles and commit messages — it does not change existing links.
          {' '}
          <strong>Refresh all</strong> updates titles and PR open/merged/closed state for links you already have.
          For <strong>private</strong> repos, use <strong>Repositories → Import all repos</strong> with a PAT (it is saved on this space for Scan/Refresh), or set <code>GITHUB_TOKEN</code> on the server.
        </p>
      </div>

      {banner && <div className="code-banner">{banner}</div>}
      {scanResult && (
        <div className="code-banner code-banner--success">
          <div className="code-scan-summary">
            Scan complete — inspected <strong>{scanResult.prsInspected}</strong> PRs and
            {' '}<strong>{scanResult.commitsInspected}</strong> commits across
            {' '}<strong>{scanResult.reposScanned}</strong> repo{scanResult.reposScanned === 1 ? '' : 's'},
            {' '}created <strong>{scanResult.linksCreated}</strong> new link{scanResult.linksCreated === 1 ? '' : 's'}.
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
                <span>PRs</span>
                <span>Commits</span>
                <span>New links</span>
                <span>Status</span>
              </div>
              {scanResult.perRepo.map((s) => (
                <div key={s.repoId} className={`code-scan-breakdown-row ${s.warning ? 'has-warning' : ''}`}>
                  <span className="code-scan-repo">{s.owner}/{s.repo}</span>
                  <span>{s.prsInspected}</span>
                  <span>{s.commitsInspected}</span>
                  <span className={s.linksCreated > 0 ? 'code-scan-created' : ''}>
                    {s.linksCreated > 0 ? `+${s.linksCreated}` : 0}
                  </span>
                  <span className="code-scan-status">
                    {s.warning ? <span className="code-scan-warning" title={s.warning}>⚠ error</span> : 'OK'}
                  </span>
                </div>
              ))}
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
          placeholder="Search PRs, commits, repos, issues…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {viewMode === 'all' && (
          <select className="code-select" value={kindFilter} onChange={(e) => setKindFilter(e.target.value as KindFilter)}>
            <option value="all">All types</option>
            <option value="pull_request">Pull requests</option>
            <option value="commit">Commits</option>
            <option value="branch">Branches</option>
            <option value="repo">Repos</option>
            <option value="other">Other</option>
          </select>
        )}
        <select className="code-select" value={repoFilter} onChange={(e) => setRepoFilter(e.target.value)}>
          <option value="all">All repos</option>
          {repoOptions.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <span className="code-count">
          {searchActive
            ? `${totalCount} match${totalCount === 1 ? '' : 'es'} in ${links.length}`
            : `${totalCount} ${totalCount === 1 ? 'link' : 'links'}`}
        </span>
      </div>

      {searchActive ? (
        <p className="code-view-hint">
          Searching across <strong>all</strong> links in this space (ignoring Active / All and Type filters).
        </p>
      ) : viewMode === 'active' ? (
        <p className="code-view-hint">
          <strong>Active</strong> = open / draft pull requests only. Switch to <strong>All</strong> for merged / closed PRs and commits.
        </p>
      ) : null}

      {!loading && totalCount === 0 && (
        <div className="code-empty">
          <h3>{viewMode === 'active' ? 'No active PRs' : 'No code linked yet'}</h3>
          <p>
            {viewMode === 'active'
              ? <>No open or draft pull requests linked to any issue. Switch to <strong>All</strong> to see history, or run <strong>Scan repos</strong> to pull in new links.</>
              : <>Either paste a GitHub URL into any issue's <strong>Development</strong> section, or open <strong>⚙ Repositories</strong> to connect a repo and run <strong>Scan repos</strong>.</>
            }
          </p>
        </div>
      )}

      {KIND_ORDER.map((kind) => {
        const items = groups[kind];
        if (!items || items.length === 0) return null;
        const meta = KIND_META[kind];
        const isCommits = kind === 'commit';
        const collapsed = isCommits && !commitsExpanded;
        const limit = groupLimits[kind];
        const visibleItems = items.slice(0, limit);
        const remaining = items.length - visibleItems.length;
        return (
          <div key={kind} className="code-group">
            <h3 className="code-group-title">
              <span className={`code-group-icon code-group-icon--${kind}`}>{meta.icon}</span>
              {meta.label}
              <span className="code-group-count">{items.length}</span>
              {isCommits && (
                <button
                  type="button"
                  className="code-group-toggle"
                  onClick={() => setCommitsExpanded((v) => !v)}
                  title={collapsed ? 'Show commits' : 'Hide commits'}
                >
                  {collapsed ? 'Show' : 'Hide'}
                </button>
              )}
            </h3>
            {!collapsed && (
              <div className="code-list">
                {visibleItems.map((l) => {
                  const subtitle = [
                    l.owner && l.repo ? `${l.owner}/${l.repo}` : null,
                    l.kind === 'pull_request' && l.refId ? `#${l.refId}` : null,
                    l.kind === 'commit' && l.refId ? l.refId.substring(0, 7) : null,
                    l.kind === 'branch' && l.refId ? l.refId : null,
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
                        onClick={() => navigate(`/ticket/${l.issueKey}`)}
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
            )}
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
                <p className="code-repo-hint-title">How import works</p>
                <ul className="code-repo-hint-list">
                  <li>
                    Import links repos for this space and scan detects references like{' '}
                    <code>{currentSpace.key ? `${currentSpace.key}-123` : 'PROJ-123'}</code> in PR titles / commit messages.
                  </li>
                  <li>
                    Public repos work without a token. Private repos need a PAT (<code>repo</code> classic, or fine-grained read access).
                  </li>
                  <li>
                    If you provide a PAT, it is stored on this space (not returned by API) for <strong>Scan repos</strong>, <strong>Refresh all</strong>, and Development metadata.
                  </li>
                  <li>
                    Import includes repos <strong>owned by the account</strong>; collaborator repos from other owners are excluded.
                  </li>
                </ul>
              </div>
              <form className="code-repo-form code-repo-form--bulk" onSubmit={importAllFromAccount}>
                <div className="code-repo-form-fields">
                  <input
                    className="code-search"
                    type="text"
                    placeholder="User, org, or profile URL (e.g. vercel or https://github.com/octocat)"
                    value={accountInput}
                    onChange={(e) => setAccountInput(e.target.value)}
                    aria-label="GitHub account for bulk import"
                  />
                  <input
                    className="code-search"
                    type="password"
                    autoComplete="off"
                    placeholder="Optional: GitHub token (needed for private repos)"
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
                Adds repositories owned by that account (skips ones already linked). Collaborator repos owned by other accounts are excluded. With a PAT, it is saved on this space for later scans; leave it empty for public-only imports.
              </p>
              <form className="code-repo-form code-repo-form--single" onSubmit={addRepo}>
                <input
                  className="code-search"
                  type="text"
                  placeholder="Single repo: owner/repo  (e.g. facebook/react)  or a GitHub URL"
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
