import { api } from './client';
import type { GithubTokenBody } from './codeLinkApi';

export interface SpaceGithubRepoDto {
  id: number;
  spaceId: number;
  owner: string;
  repo: string;
  createdAt: string;
  lastScannedAt: string | null;
}

export interface CreateSpaceGithubRepoRequest {
  /** Accepts "owner/repo" or a full GitHub URL. */
  target: string;
}

export interface BulkImportGithubReposRequest {
  /** GitHub user or org login; leading @ optional. */
  account: string;
  /**
   * Optional PAT. Without it, only public owned repos are imported.
   * With it, private owned repos are included (token must belong to that account)
   * and the PAT is stored on the space for Scan / Refresh.
   */
  githubToken?: string;
}

export interface BulkImportGithubReposResult {
  discovered: number;
  added: number;
  skipped: number;
}

export interface RepoScanStats {
  repoId: number;
  owner: string;
  repo: string;
  prsInspected: number;
  /** Present after backend restart with open/closed split. */
  openPrs?: number;
  closedPrs?: number;
  commitsInspected: number;
  linksCreated: number;
  warning: string | null;
}

export type { GithubTokenBody } from './codeLinkApi';

export interface ScanResult {
  reposScanned: number;
  /** GitHub returned 404 — removed from space + Development links cleaned up. */
  reposRemoved: number;
  prsInspected: number;
  openPrs?: number;
  closedPrs?: number;
  commitsInspected: number;
  linksCreated: number;
  perRepo: RepoScanStats[];
  warnings: string[];
}

export const githubRepoApi = {
  list: (spaceId: number) =>
    api.get<SpaceGithubRepoDto[]>(`/api/spaces/${spaceId}/github-repos`),
  add: (spaceId: number, req: CreateSpaceGithubRepoRequest) =>
    api.post<SpaceGithubRepoDto>(`/api/spaces/${spaceId}/github-repos`, req),
  bulkImport: (spaceId: number, req: BulkImportGithubReposRequest) =>
    api.post<BulkImportGithubReposResult>(`/api/spaces/${spaceId}/github-repos/bulk`, req),
  remove: (spaceId: number, repoId: number) =>
    api.delete<void>(`/api/spaces/${spaceId}/github-repos/${repoId}`),
  scan: (spaceId: number, body: GithubTokenBody = {}) =>
    api.post<ScanResult>(`/api/spaces/${spaceId}/github-repos/scan`, body),
};
