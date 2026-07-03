import { api } from './client';

export type CodeLinkKind = 'pull_request' | 'commit' | 'branch' | 'repo' | 'other';

export interface IssueCodeLinkDto {
  id: number;
  issueId: number;
  issueKey: string;
  url: string;
  kind: CodeLinkKind;
  provider: string;
  owner: string | null;
  repo: string | null;
  refId: string | null;
  title: string | null;
  state: string | null;
  authorLogin: string | null;
  creatorName: string | null;
  createdAt: string;
  /** GitHub activity time when known (ISO); prefer over createdAt for sort/display. */
  lastActivityAt: string | null;
}

export interface CreateIssueCodeLinkRequest {
  url: string;
  /** Optional; used only for this request to read private GitHub resources (not stored). */
  githubToken?: string;
}

/** Optional body for scan/refresh endpoints. */
export interface GithubTokenBody {
  githubToken?: string;
}

export interface RefreshResult {
  checked: number;
  updated: number;
}

export const codeLinkApi = {
  getByIssue: (issueId: number) =>
    api.get<IssueCodeLinkDto[]>(`/api/issues/${issueId}/code-links`),
  create: (issueId: number, req: CreateIssueCodeLinkRequest) =>
    api.post<IssueCodeLinkDto>(`/api/issues/${issueId}/code-links`, req),
  delete: (issueId: number, linkId: number) =>
    api.delete<void>(`/api/issues/${issueId}/code-links/${linkId}`),
  getBySpace: (spaceId: number) =>
    api.get<IssueCodeLinkDto[]>(`/api/spaces/${spaceId}/code-links`),
  refreshSpace: (spaceId: number, body: GithubTokenBody = {}) =>
    api.post<RefreshResult>(`/api/spaces/${spaceId}/code-links/refresh`, body),
  refreshIssue: (issueId: number, body: GithubTokenBody = {}) =>
    api.post<RefreshResult>(`/api/issues/${issueId}/code-links/refresh`, body),
  refreshOne: (linkId: number, body: GithubTokenBody = {}) =>
    api.post<IssueCodeLinkDto>(`/api/code-links/${linkId}/refresh`, body),
};
