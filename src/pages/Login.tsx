import { useState, useEffect } from 'react';
import { useNavigate, useLocation, Navigate } from 'react-router-dom';
import { useCurrentUser } from '../context/UserContext';

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:8080';

function GithubMark() {
  return <span className="login-google-icon" aria-hidden>🐙</span>;
}

export function Login() {
  const {
    login,
    users,
    isAuthenticated,
    githubOAuthEnabled,
    usersLoading,
    usersLoadError,
    retryUsersBootstrap,
  } = useCurrentUser();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: { pathname: string } })?.from?.pathname ?? '/';

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const err = params.get('error');
    if (err) {
      setError(err === 'oauth' ? 'GitHub sign-in was cancelled or failed.' : `Sign-in error: ${err}`);
    }
  }, [location.search]);

  if (isAuthenticated) {
    return <Navigate to={from} replace />;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const err = await login(username.trim().toLowerCase(), password);
    setLoading(false);
    if (err) {
      setError(err);
    } else {
      navigate(from, { replace: true });
    }
  }

  const quickLoginUsers = users.filter((u) => u.passwordLoginEnabled);

  function handleQuickLogin(user: { username: string }) {
    setUsername(user.username);
    setPassword('123');
    setError(null);
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-logo">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
            <rect width="32" height="32" rx="8" fill="#0052CC" />
            <path d="M10 22L16 10l6 12H10z" fill="#fff" />
          </svg>
          <h1 className="login-title">Jira</h1>
        </div>
        <p className="login-subtitle">Log in with username and password, or use GitHub (new accounts are created automatically).</p>

        <form className="login-form" onSubmit={handleSubmit}>
          <div className="login-field">
            <label htmlFor="username" className="login-label">Username</label>
            <input
              id="username"
              className="login-input"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Enter your username"
              autoComplete="username"
              autoFocus
            />
          </div>
          <div className="login-field">
            <label htmlFor="password" className="login-label">Password</label>
            <input
              id="password"
              className="login-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
              autoComplete="current-password"
            />
          </div>
          {error && <p className="login-error">{error}</p>}
          {error && /github/i.test(error) && (
            <>
              {githubOAuthEnabled ? (
                <a className="login-google login-google--inline" href={`${API_BASE}/oauth2/authorization/github`}>
                  Continue with GitHub instead
                </a>
              ) : (
                <p className="login-hint login-hint--tight">
                  Turn on GitHub sign-in on the server: set <code>GITHUB_OAUTH_ENABLED=true</code> and GitHub OAuth app credentials, then restart the backend.
                </p>
              )}
            </>
          )}
          <button
            type="submit"
            className="login-submit"
            disabled={loading || !username.trim() || !password}
          >
            {loading ? 'Logging in…' : 'Log in'}
          </button>
        </form>

        <div className="login-divider">
          <span>or</span>
        </div>
        {githubOAuthEnabled ? (
          <a className="login-google" href={`${API_BASE}/oauth2/authorization/github`}>
            <GithubMark />
            Continue with GitHub
          </a>
        ) : (
          <>
            <div className="login-google login-google--disabled" aria-disabled="true" title="Enable OAuth on the server to use this">
              <GithubMark />
              Continue with GitHub
            </div>
            <p className="login-hint login-hint--tight">
              GitHub sign-in is off until you set <code>GITHUB_OAUTH_ENABLED=true</code> and <code>GITHUB_CLIENT_ID</code> /{' '}
              <code>GITHUB_CLIENT_SECRET</code>, then restart the backend (same pattern as most production apps).
            </p>
          </>
        )}

        <div className="login-divider">
          <span>or quick login as</span>
        </div>

        {usersLoading && <p className="login-hint">Loading demo users…</p>}

        {usersLoadError && !usersLoading && (
          <div className="login-api-error">
            <p>Could not load users from the API.</p>
            <p className="login-api-error-detail">{usersLoadError}</p>
            <p className="login-hint">
              Use <strong>Gateway on port 8080</strong> in <code>VITE_API_URL</code> (not backend 8081). Start Gateway and
              backend, then retry.
            </p>
            <button type="button" className="login-retry" onClick={retryUsersBootstrap}>
              Retry
            </button>
          </div>
        )}

        {!usersLoading && !usersLoadError && quickLoginUsers.length === 0 && (
          <p className="login-hint">No users returned from the API (empty database).</p>
        )}

        <div className="login-quick-users">
          {quickLoginUsers.map((u) => (
            <button
              key={u.id}
              type="button"
              className={`login-quick-user ${username === u.username ? 'login-quick-user--selected' : ''}`}
              onClick={() => handleQuickLogin(u)}
            >
              <span className="login-quick-avatar" style={{ background: u.avatarColor }}>
                {(u.name || u.username || '?').charAt(0).toUpperCase()}
              </span>
              <span className="login-quick-name">{u.name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
