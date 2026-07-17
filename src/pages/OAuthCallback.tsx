import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCurrentUser } from '../context/UserContext';
import './Login.css';

export function OAuthCallback() {
  const navigate = useNavigate();
  const { applyOAuthSession } = useCurrentUser();
  const [message, setMessage] = useState('Signing you in…');
  const handledRef = useRef(false);

  useEffect(() => {
    // React StrictMode re-runs effects in dev; guard to process OAuth callback only once.
    if (handledRef.current) {
      return;
    }
    handledRef.current = true;

    const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
    const hashParams = new URLSearchParams(hash);
    const queryParams = new URLSearchParams(window.location.search);
    const token = hashParams.get('access_token') ?? queryParams.get('access_token');

    if (!token) {
      setMessage('Missing token. Redirecting to login…');
      const t = setTimeout(() => navigate('/login?error=oauth', { replace: true }), 800);
      return () => clearTimeout(t);
    }
    window.history.replaceState(null, '', window.location.pathname);

    (async () => {
      try {
        await applyOAuthSession(token);
        navigate('/spaces', { replace: true });
      } catch {
        setMessage('Could not complete sign-in. Redirecting…');
        setTimeout(() => navigate('/login?error=oauth_session', { replace: true }), 800);
      }
    })();
  }, [navigate, applyOAuthSession]);

  return (
    <div className="login-page">
      <div className="login-card">
        <p className="login-subtitle">{message}</p>
      </div>
    </div>
  );
}
