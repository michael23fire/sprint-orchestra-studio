import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useSpaces } from '../context/SpaceContext';
import { useTickets } from '../context/TicketContext';
import { useCurrentUser } from '../context/UserContext';
import { SpacePeopleModal } from '../components/SpacePeopleModal';
import { ISSUE_TYPE_META } from '../types/ticket';
import type { IssueType } from '../types/ticket';
import './SpaceOverview.css';

function IssueIcon({ type }: { type?: IssueType }) {
  const meta = ISSUE_TYPE_META[type ?? 'task'];
  return (
    <span className="so-icon" style={{ background: meta.color }}>
      {meta.icon}
    </span>
  );
}

export function SpaceOverview() {
  const { currentSpace, hydrateSpace } = useSpaces();
  const { tickets, sprints } = useTickets();
  const { users } = useCurrentUser();
  const [showPeople, setShowPeople] = useState(false);

  useEffect(() => {
    if (!showPeople) return;
    void hydrateSpace(currentSpace.id);
  }, [showPeople, currentSpace.id, hydrateSpace]);

  const members = users.filter((u) => currentSpace.members.includes(u.id));
  const admin = users.find((u) => u.id === currentSpace.ownerId);
  const activeSprint = sprints.find((s) => s.status === 'active');
  const totalTickets = tickets.length;
  const doneTickets = tickets.filter((t) => t.status === 'done').length;
  const inProgressTickets = tickets.filter((t) => t.status === 'in_progress').length;
  const recentTickets = [...tickets].reverse().slice(0, 6);

  const issueTypeCounts = tickets.reduce<Record<string, number>>((acc, t) => {
    const type = t.issueType ?? 'task';
    acc[type] = (acc[type] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="so-page">
      {/* Space header */}
      <div className="so-header">
        <div className="so-header__icon" style={{ background: currentSpace.color }}>
          {currentSpace.name.charAt(0).toUpperCase()}
        </div>
        <div className="so-header__info">
          <h1 className="so-header__name">{currentSpace.name}</h1>
          <span className="so-header__key">{currentSpace.key}</span>
          <span className="so-header__meta">
            {totalTickets} issues · {members.length} member{members.length !== 1 ? 's' : ''}
          </span>
          <span className="so-header__meta so-header__meta--admin">
            Admin: {admin?.name ?? 'Unknown'}
          </span>
        </div>
      </div>

      {/* Quick nav */}
      <div className="so-nav">
        <Link to="/board" className="so-nav__card">
          <span className="so-nav__card-icon">📋</span>
          <span className="so-nav__card-label">Board</span>
        </Link>
        <Link to="/backlog" className="so-nav__card">
          <span className="so-nav__card-icon">📦</span>
          <span className="so-nav__card-label">Backlog</span>
        </Link>
        <Link to="/timeline" className="so-nav__card">
          <span className="so-nav__card-icon">📅</span>
          <span className="so-nav__card-label">Timeline</span>
        </Link>
        <Link to="/summary" className="so-nav__card">
          <span className="so-nav__card-icon">📊</span>
          <span className="so-nav__card-label">Summary</span>
        </Link>
      </div>

      <div className="so-grid">
        {/* Stats */}
        <section className="so-section">
          <h2 className="so-section__title">Overview</h2>
          <div className="so-stats">
            <div className="so-stat">
              <span className="so-stat__value">{totalTickets}</span>
              <span className="so-stat__label">Total Issues</span>
            </div>
            <div className="so-stat">
              <span className="so-stat__value so-stat__value--blue">{inProgressTickets}</span>
              <span className="so-stat__label">In Progress</span>
            </div>
            <div className="so-stat">
              <span className="so-stat__value so-stat__value--green">{doneTickets}</span>
              <span className="so-stat__label">Done</span>
            </div>
            <div className="so-stat">
              <span className="so-stat__value so-stat__value--purple">{sprints.length}</span>
              <span className="so-stat__label">Sprints</span>
            </div>
          </div>

          {/* Issue type breakdown */}
          <div className="so-breakdown">
            <h3 className="so-breakdown__title">By Issue Type</h3>
            {Object.entries(issueTypeCounts).map(([type, count]) => {
              const meta = ISSUE_TYPE_META[type as IssueType];
              return (
                <div key={type} className="so-breakdown__row">
                  <IssueIcon type={type as IssueType} />
                  <span className="so-breakdown__label">{meta?.label ?? type}</span>
                  <span className="so-breakdown__count">{count}</span>
                </div>
              );
            })}
          </div>
        </section>

        {/* Right column */}
        <div className="so-right">
          {/* Active sprint */}
          {activeSprint && (
            <section className="so-section">
              <h2 className="so-section__title">Active Sprint</h2>
              <div className="so-sprint-card">
                <div className="so-sprint-card__name">{activeSprint.name}</div>
                {activeSprint.goal && (
                  <div className="so-sprint-card__goal">{activeSprint.goal}</div>
                )}
                <div className="so-sprint-card__dates">
                  {activeSprint.startDate} – {activeSprint.endDate}
                </div>
                <Link to="/board" className="so-sprint-card__link">Go to Board →</Link>
              </div>
            </section>
          )}

          {/* Members */}
          <section className="so-section">
            <h2 className="so-section__title">Members</h2>
            <button type="button" className="so-members__view-all" onClick={() => setShowPeople(true)}>
              View all members
            </button>
            <div className="so-members">
              {members.length === 0 && (
                <p className="so-members__empty">No members yet. Add people from the sidebar.</p>
              )}
              {members.map((u) => (
                <div key={u.id} className="so-members__item">
                  <span className="so-members__avatar" style={{ background: u.avatarColor }}>
                    {u.name.charAt(0)}
                  </span>
                  <span className="so-members__name">{u.name}</span>
                  {admin?.id === u.id && <span className="so-members__role">Admin</span>}
                </div>
              ))}
            </div>
          </section>

          {/* Recent issues */}
          <section className="so-section">
            <h2 className="so-section__title">Recent Issues</h2>
            <div className="so-recent">
              {recentTickets.length === 0 && (
                <p className="so-members__empty">No issues yet.</p>
              )}
              {recentTickets.map((t) => (
                <Link key={t.id} to={`/board?ticket=${t.id}`} className="so-recent__item">
                  <IssueIcon type={t.issueType} />
                  <span className="so-recent__id">{t.id}</span>
                  <span className="so-recent__title">{t.title}</span>
                </Link>
              ))}
            </div>
          </section>
        </div>
      </div>
      {showPeople && <SpacePeopleModal space={currentSpace} onClose={() => setShowPeople(false)} />}
    </div>
  );
}
