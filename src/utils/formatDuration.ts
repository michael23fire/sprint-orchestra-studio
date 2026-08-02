/** Formats a millisecond duration for on-screen display, picking the coarsest unit that keeps the
 *  number readable — a local reasoning model's LLM-call time can run into the hundreds of seconds
 *  (see AskAiPanel's stage-latency breakdown), and "118261.22ms" is harder to scan than "1m 58s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes}m ${seconds}s`;
}
