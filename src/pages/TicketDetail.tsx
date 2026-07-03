import { useCallback, useEffect, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { TicketDetailModal } from '../components/TicketDetailModal';
import { useTickets } from '../context/TicketContext';
import { useCurrentUser } from '../context/UserContext';
import './Board.css';
import './TicketDetail.css';

export function TicketDetail() {
  const { ticketId } = useParams<{ ticketId: string }>();
  const navigate = useNavigate();
  const { currentUser } = useCurrentUser();
  const {
    tickets,
    sprints,
    updateTicket,
    createSubtask,
    deleteTicket,
    addComment,
    editComment,
    deleteComment,
    addIssueLink,
    deleteIssueLink,
    addCodeLink,
    deleteCodeLink,
    refreshCodeLinks,
    loading,
    hydrateIssueDetail,
  } = useTickets();

  useEffect(() => {
    if (!ticketId) return;
    void hydrateIssueDetail(ticketId);
  }, [ticketId, hydrateIssueDetail]);

  const ticket = useMemo(
    () => tickets.find((t) => t.id === ticketId),
    [tickets, ticketId],
  );

  const handleClose = useCallback(() => {
    // No modal "parent" to return to in standalone view — send the user
    // back to the board. If they were mid-editing the modal auto-saves on
    // close via its own hasChanges check.
    navigate('/board');
  }, [navigate]);

  const handleOpenTicket = useCallback(
    (id: string) => {
      // Switching to another ticket on the standalone page means navigating
      // within the same tab (keeps the URL accurate & shareable).
      navigate(`/ticket/${id}`);
    },
    [navigate],
  );

  if (!ticket) {
    // While the context is still fetching its initial data we render a
    // neutral loading screen instead of "not found" so users who open a
    // ticket link in a new tab don't see a flash of an error page before
    // the modal appears.
    if (loading) {
      return (
        <div className="td-page">
          <div className="td-page__loading" role="status" aria-live="polite">
            <div className="td-page__spinner" aria-hidden />
            <p>Loading {ticketId}…</p>
          </div>
        </div>
      );
    }
    return (
      <div className="td-page">
        <div className="td-page__not-found">
          <h2>Ticket not found</h2>
          <p>
            The ticket <code>{ticketId}</code> does not exist in this space.
          </p>
          <Link to="/board" className="td-page__back-link">
            Back to Board
          </Link>
        </div>
      </div>
    );
  }

  return (
    <TicketDetailModal
      ticket={ticket}
      allTickets={tickets}
      sprints={sprints}
      onUpdate={updateTicket}
      onCreateSubtask={createSubtask}
      onDeleteTicket={(id) => {
        deleteTicket(id);
        navigate('/board');
      }}
      onAddComment={addComment}
      onEditComment={editComment}
      onDeleteComment={deleteComment}
      onAddIssueLink={addIssueLink}
      onDeleteIssueLink={deleteIssueLink}
      onAddCodeLink={addCodeLink}
      onDeleteCodeLink={deleteCodeLink}
      onRefreshCodeLinks={refreshCodeLinks}
      currentUserId={Number(currentUser.id)}
      onOpenTicket={handleOpenTicket}
      onClose={handleClose}
    />
  );
}
