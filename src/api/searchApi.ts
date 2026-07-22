import { api } from './client';

export interface SearchResultDto {
  type: 'ISSUE' | 'COMMENT';
  /** Which search tier produced this hit — exact issue-key, full-text, or trigram fuzzy fallback. */
  matchType: 'EXACT_KEY' | 'FULL_TEXT' | 'FUZZY';
  spaceId: number;
  issueId: number;
  issueKey: string;
  title: string;
  snippet: string;
  rank: number;
  updatedAt: string;
}

export const searchApi = {
  search: (q: string, limit = 20) =>
    api.get<SearchResultDto[]>(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}`),
};
