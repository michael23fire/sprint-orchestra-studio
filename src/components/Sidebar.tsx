import { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useSpaces } from '../context/SpaceContext';
import { useCurrentUser } from '../context/UserContext';
import { isSpaceOwner } from '../types/space';
import { CreateSpaceModal } from './CreateSpaceModal';
import { AddPeopleModal } from './AddPeopleModal';
import { SpacePeopleModal } from './SpacePeopleModal';

export function Sidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { spaces, currentSpace, setCurrentSpace, hydrateSpace } = useSpaces();
  const { currentUser } = useCurrentUser();
  const [showCreate, setShowCreate] = useState(false);
  const [peopleSpaceId, setPeopleSpaceId] = useState<string | null>(null);
  const peopleSpace = peopleSpaceId ? spaces.find((s) => s.id === peopleSpaceId) : undefined;

  useEffect(() => {
    if (!peopleSpaceId) return;
    void hydrateSpace(peopleSpaceId);
  }, [peopleSpaceId, hydrateSpace]);

  return (
    <>
      <aside className="sidebar">
        <nav className="sidebar__nav">
          <button type="button" className={`sidebar__link ${location.pathname === '/groups' ? 'sidebar__link--active' : ''}`} onClick={() => navigate('/groups')}>Groups</button>
        </nav>

        <div className="sidebar__spaces-header">
          <span className="sidebar__section-label">Spaces</span>
          <button
            type="button"
            className="sidebar__add-space-btn"
            onClick={() => setShowCreate(true)}
            title="Create space"
          >
            +
          </button>
        </div>

        <div className="sidebar__space-list">
          {spaces.map((space) => (
            <div
              key={space.id}
              className={`sidebar__space-item ${space.id === currentSpace.id ? 'sidebar__space-item--active' : ''}`}
            >
              <button
                type="button"
                className="sidebar__space-select"
                onClick={() => { setCurrentSpace(space); navigate('/board'); }}
              >
                <span
                  className="sidebar__space-dot"
                  style={{ background: space.color }}
                />
                <span className="sidebar__space-name">{space.name}</span>
              </button>
              <button
                type="button"
                className="sidebar__space-people-btn"
                onClick={() => setPeopleSpaceId(space.id)}
                title={isSpaceOwner(space, currentUser.id) ? 'Manage people' : 'View people'}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <line x1="19" y1="8" x2="19" y2="14" />
                  <line x1="22" y1="11" x2="16" y2="11" />
                </svg>
              </button>
            </div>
          ))}
        </div>

        <button
          type="button"
          className="sidebar__link sidebar__link--secondary"
          onClick={() => setShowCreate(true)}
        >
          + Create space
        </button>
      </aside>

      {showCreate && <CreateSpaceModal onClose={() => setShowCreate(false)} />}
      {peopleSpace && isSpaceOwner(peopleSpace, currentUser.id) && (
        <AddPeopleModal
          spaceId={peopleSpace.id}
          onClose={() => setPeopleSpaceId(null)}
        />
      )}
      {peopleSpace && !isSpaceOwner(peopleSpace, currentUser.id) && (
        <SpacePeopleModal
          space={peopleSpace}
          onClose={() => setPeopleSpaceId(null)}
        />
      )}
    </>
  );
}
