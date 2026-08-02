import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useSpaces } from '../context/SpaceContext';
import { aiApi } from '../api';
import type { AskResponseDto, ChatTurnDto } from '../api';
import { IssueKeyChip } from './IssueKeyChip';
import { formatDuration } from '../utils/formatDuration';
import './AskAiPanel.css';

interface AskAiPanelProps {
  onClose: () => void;
}

/** Clickable starting points shown only before the first question — gives an empty conversation
 *  something purposeful to show instead of dead space, and doubles as a hint at the kinds of
 *  questions this tool is actually good at (content vs. counts vs. history). */
const SUGGESTED_PROMPTS = [
  "What's blocking the payment epic?",
  'Which issues were reopened after being marked done?',
  "What's the current sprint's goal?",
  'How many bugs are still open?',
];

/** One exchange in the running conversation — the question as asked, plus the full response (so
 *  citations/abstained render per-turn, not just the latest one). */
interface ConversationTurn {
  question: string;
  result: AskResponseDto;
}

export function AskAiPanel({ onClose }: AskAiPanelProps) {
  const { spaces, currentSpace } = useSpaces();
  const [query, setQuery] = useState('');
  const [selectedSpaceIds, setSelectedSpaceIds] = useState<Set<string>>(() => new Set(spaces.map((s) => s.id)));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Latest SSE progress label from askStream's onStage callback (e.g. "searching the knowledge
  // base") — null while idle or before the first event of a request arrives. Replaces a single
  // static "Working…" string with what the CragAgent loop is actually doing right now.
  const [stageLabel, setStageLabel] = useState<string | null>(null);
  // The running "ask" conversation — each entry is one question + its full answer. Follow-up
  // questions resolve against this (see `history` below); "New chat" is the only thing that clears
  // it, so an old topic's context never bleeds into an unrelated new one by accident.
  const [conversation, setConversation] = useState<ConversationTurn[]>([]);

  // Derived, not separately stored state: the wire format ai-service expects (see ChatTurnDto) is
  // just each turn's question + final answer text, oldest first — recomputing it from `conversation`
  // means there's exactly one source of truth for "what has this chat said so far."
  const history: ChatTurnDto[] = useMemo(
    () => conversation.flatMap((t): ChatTurnDto[] => [
      { role: 'user', content: t.question },
      { role: 'assistant', content: t.result.answer },
    ]),
    [conversation],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Auto-scroll, ChatGPT-style: a sentinel div at the very end of the scrollable body, scrolled into
  // view whenever a new turn lands or the "Working…" indicator appears — so a growing conversation
  // always keeps the newest content in view instead of leaving the user scrolled up on turn 1.
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [conversation.length, loading]);

  const spaceIds = useMemo(
    () => spaces.filter((s) => selectedSpaceIds.has(s.id)).map((s) => Number(s.id)),
    [spaces, selectedSpaceIds],
  );

  function toggleSpace(id: string) {
    setSelectedSpaceIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // Accepts an explicit question so a suggested-prompt chip can fire-and-submit in one click rather
  // than needing a setQuery + wait-for-re-render + second click round trip.
  async function handleSubmit(explicitQuestion?: string) {
    const question = (explicitQuestion ?? query).trim();
    if (!question || loading || spaceIds.length === 0) return;
    setLoading(true);
    setError(null);
    setStageLabel(null);
    try {
      const result = await aiApi.askStream(question, spaceIds, history, setStageLabel);
      setConversation((prev) => [...prev, { question, result }]);
      setQuery('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed — try again.');
    } finally {
      setLoading(false);
      setStageLabel(null);
    }
  }

  /** Clears the current input/error only — deliberately leaves an in-progress
   *  conversation alone (e.g. clearing a typo mid-question shouldn't cost you the thread). */
  function handleClear() {
    setQuery('');
    setError(null);
  }

  /** Starts a fresh conversation: the one action that actually drops `history`, so a new,
   *  unrelated topic never gets the previous topic's context mixed in. */
  function handleNewChat() {
    setConversation([]);
    setQuery('');
    setError(null);
  }

  const hasResult = conversation.length > 0 || error !== null;
  const isEmpty = conversation.length === 0 && !loading && !error;

  return (
    <div className="bl-overlay" onMouseDown={onClose}>
      <div className="bl-modal aa-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="bl-modal__header aa-header">
          <h2 className="bl-modal__title aa-header__title">
            <span className="aa-header__badge" aria-hidden>✨</span>
            Ask AI
          </h2>
          <button type="button" className="bl-modal__close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="bl-modal__body aa-body">
          <div className="aa-top">
            <p className="aa-hint">
              Ask about existing issues, sprints, or decisions — AI automatically chooses the right
              search or structured data source, cites real issues, and says when it does not know.
            </p>

            <div className="aa-scope">
              <span className="aa-scope__label">Search in</span>
              <div className="aa-scope__pills">
                {spaces.map((s) => {
                  const active = selectedSpaceIds.has(s.id);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      className={`aa-scope__pill${active ? ' aa-scope__pill--active' : ''}`}
                      aria-pressed={active}
                      onClick={() => toggleSpace(s.id)}
                    >
                      {s.name}{s.id === currentSpace.id ? ' · current' : ''}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Scrollable message thread, ChatGPT-style — the composer below stays fixed while this
              area grows and scrolls independently as the conversation gets longer. */}
          <div className="aa-scroll">
            {isEmpty && (
              <div className="aa-empty">
                <div className="aa-empty__icon" aria-hidden>✨</div>
                <p className="aa-empty__title">Ask anything about this workspace</p>
                <p className="aa-empty__hint">Try one of these, or type your own below.</p>
                <div className="aa-suggestions">
                  {SUGGESTED_PROMPTS.map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      className="aa-suggestion"
                      disabled={spaceIds.length === 0}
                      onClick={() => handleSubmit(prompt)}
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {loading && (
              <div className="aa-loading">
                <span className="aa-loading__dot" aria-hidden />
                <span className="aa-loading__dot" aria-hidden />
                <span className="aa-loading__dot" aria-hidden />
                {/* Live progress from the SSE stream (see askStream) once the first event arrives;
                    falls back to a generic message for the brief gap before it does. */}
                <span>{stageLabel ? `${stageLabel}…` : 'Retrieving relevant data and reasoning through an answer…'}</span>
              </div>
            )}

            {error && <p className="aa-error">{error}</p>}

            {conversation.length > 0 && (
              <div className="aa-thread">
                {conversation.map((turn, i) => (
                  <div className="aa-result" key={i}>
                    <div className="aa-turn-question__row">
                      <p className="aa-turn-question">{turn.question}</p>
                    </div>
                    <div className="aa-turn-answer__row">
                      <span className="aa-turn-answer__avatar" aria-hidden>✨</span>
                      <div className="aa-turn-answer__body">
                        {turn.result.abstained ? (
                          // Render the backend's own answer text rather than separate hardcoded copy:
                          // it's the exact ABSTENTION_PHRASE contract ai-service guarantees
                          // (app/agent/crag_loop.py) — duplicating that string here would just be one
                          // more place for the two to drift out of sync, which already happened once.
                          <p className="aa-abstained">{turn.result.answer}</p>
                        ) : (
                          <div className="aa-answer">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                              {turn.result.answer}
                            </ReactMarkdown>
                          </div>
                        )}
                        {turn.result.citations.length > 0 && (
                          // <details> gives collapse/expand for free — no state, no JS, keyboard/
                          // screen reader accessible by default — matching the "answer first, sources
                          // on demand" pattern most modern chat UIs use over always-open citation dumps.
                          <details className="aa-citations">
                            <summary className="aa-citations__summary">
                              Sources ({turn.result.citations.length})
                            </summary>
                            <div className="aa-citations__list">
                              {turn.result.citations.map((c, ci) => (
                                <div className="aa-citation" key={`${c.issueKey}-${ci}`}>
                                  <IssueKeyChip issueKey={c.issueKey} size="sm" />
                                  <span className="aa-citation__snippet">{c.content}</span>
                                </div>
                              ))}
                            </div>
                          </details>
                        )}
                        {turn.result.stageTimings && (
                          // Same collapse-for-free <details> pattern as Sources above — server-
                          // measured wall-clock split, off by default so it doesn't clutter a normal
                          // read of the answer, one click away when latency itself is the question.
                          <details className="aa-citations">
                            <summary className="aa-citations__summary">Stage latency</summary>
                            <div className="aa-citations__list">
                              <span className="aa-citation__snippet">
                                cache lookup: {formatDuration(turn.result.stageTimings.cacheLookupMs)}
                                {' · '}retrieval: {formatDuration(turn.result.stageTimings.retrievalMs)}
                                {' · '}LLM calls: {formatDuration(turn.result.stageTimings.llmMs)}
                                {' · '}total: {formatDuration(turn.result.stageTimings.totalMs)}
                              </span>
                            </div>
                          </details>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div ref={bottomRef} />
          </div>

          {/* Composer pinned at the bottom of the panel, same placement as a modern LLM chat UI. */}
          <div className="aa-composer">
            {hasResult && !loading && (
              <div className="aa-composer__actions">
                <button
                  type="button"
                  className="aa-icon-btn"
                  onClick={handleClear}
                  title="Clear what you've typed below (keeps the conversation above)"
                >
                  <svg className="aa-icon-btn__icon" viewBox="0 0 16 16" aria-hidden>
                    <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.4" />
                    <path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  </svg>
                  Clear
                </button>
                {conversation.length > 0 && (
                  <button
                    type="button"
                    className="aa-icon-btn"
                    onClick={handleNewChat}
                    title="Start a fresh conversation — this thread's history won't be sent with your next question"
                  >
                    <svg className="aa-icon-btn__icon" viewBox="0 0 16 16" aria-hidden>
                      <path
                        d="M8.5 3H3.75a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7.25"
                        fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"
                      />
                      <path
                        d="M11.85 2.15a1.1 1.1 0 0 1 1.56 1.56L8.7 8.4 6.9 9l.6-1.8z"
                        fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"
                      />
                    </svg>
                    New chat
                  </button>
                )}
              </div>
            )}
            <div className="aa-query-row">
              <input
                className="aa-query-input"
                placeholder="e.g. what's blocking the payment epic?"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleSubmit(); } }}
                autoFocus
              />
              <button
                type="button"
                className="aa-send-btn"
                onClick={() => handleSubmit()}
                disabled={!query.trim() || loading || spaceIds.length === 0}
                aria-label={loading ? 'Working…' : 'Ask'}
                title={loading ? 'Working…' : 'Ask'}
              >
                {loading ? <span className="aa-spinner" aria-hidden /> : <span aria-hidden>↑</span>}
              </button>
            </div>
            {spaceIds.length === 0 && <p className="aa-error">Select at least one space to search.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
