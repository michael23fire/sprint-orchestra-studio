/**
 * Matches backend {@code GithubMetadataClient.normalizeGithubAccountInput}:
 * bare login, @login, github.com/name, or https://github.com/name
 */
export function normalizeGithubAccountInput(raw: string): string {
  let s = raw.trim();
  if (!s) return '';
  if (s.startsWith('@')) s = s.slice(1).trim();
  if (s.toLowerCase().startsWith('github.com/')) s = `https://${s}`;
  try {
    if (s.startsWith('http://') || s.startsWith('https://')) {
      const u = new URL(s);
      const h = u.hostname.toLowerCase();
      if (h === 'github.com' || h === 'www.github.com') {
        const parts = u.pathname.split('/').filter(Boolean);
        if (parts.length === 0) return '';
        const head = parts[0].toLowerCase();
        if (head === 'orgs' && parts[1]) return parts[1];
        if (head === 'users' && parts[1]) return parts[1];
        if (head === 'settings' || head === 'pulls' || head === 'issues') return '';
        return parts[0];
      }
    }
  } catch {
    /* treat as plain login */
  }
  return s;
}
