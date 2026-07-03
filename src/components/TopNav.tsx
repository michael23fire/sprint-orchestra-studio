import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCurrentUser } from '../context/UserContext';
import { CreateTaskModal } from './CreateTaskModal';

export function TopNav() {
  const { currentUser, logout } = useCurrentUser();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [menuOpen]);

  const initial = currentUser.name.charAt(0).toUpperCase();

  function handleLogout() {
    setMenuOpen(false);
    logout();
    navigate('/login');
  }

  return (
    <>
      <header className="top-nav">
        <div className="top-nav__logo">Jira</div>
        <div className="top-nav__search">
          <input type="search" placeholder="Search" className="top-nav__search-input" aria-label="Search" />
        </div>
        <button type="button" className="top-nav__create" onClick={() => setShowCreate(true)}>
          Create
        </button>
        <div className="top-nav__actions">
          <button type="button" className="top-nav__icon" aria-label="Notifications">
            <span aria-hidden>⌘</span>
          </button>
          <button type="button" className="top-nav__icon" aria-label="Settings">
            ⚙
          </button>

          <div className="user-menu" ref={menuRef}>
            <button
              type="button"
              className="top-nav__avatar"
              style={{ background: currentUser.avatarColor }}
              aria-label="User menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((o) => !o)}
            >
              {initial}
            </button>

            {menuOpen && (
              <div className="user-menu__dropdown">
                <div className="user-menu__header">
                  <div className="user-menu__current-avatar" style={{ background: currentUser.avatarColor }}>
                    {initial}
                  </div>
                  <div>
                    <div className="user-menu__name">{currentUser.name}</div>
                    <div className="user-menu__label">{currentUser.username}</div>
                  </div>
                </div>
                <div className="user-menu__divider" />
                <button
                  type="button"
                  className="user-menu__item user-menu__item--logout"
                  onClick={handleLogout}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                    <polyline points="16 17 21 12 16 7" />
                    <line x1="21" y1="12" x2="9" y2="12" />
                  </svg>
                  Log out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {showCreate && <CreateTaskModal onClose={() => setShowCreate(false)} />}
    </>
  );
}
