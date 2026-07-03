import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { userApi, authApi } from '../api';
import type { UserDto } from '../api';
import { setAuthToken, clearAuthToken, getStoredAuthToken } from '../api/client';
import { nameFromJwtPayload, parseJwtPayload, uidFromJwtPayload, usernameFromJwtPayload } from '../utils/jwtPayload';

export interface AppUser {
  id: string;
  name: string;
  username: string;
  avatarColor: string;
  passwordLoginEnabled: boolean;
}

const EMPTY_USER: AppUser = {
  id: '',
  username: '',
  name: '',
  avatarColor: 'linear-gradient(135deg, #94a3b8, #64748b)',
  passwordLoginEnabled: false,
};

const AUTH_STORAGE_KEY = 'jira_auth_user';

const SEED_USERS = [
  { username: 'alice', name: 'Alice', email: 'alice@example.com', avatarColor: 'linear-gradient(135deg, #6366f1, #7c3aed)' },
  { username: 'john', name: 'John', email: 'john@example.com', avatarColor: 'linear-gradient(135deg, #06b6d4, #3b82f6)' },
  { username: 'charles', name: 'Charles', email: 'charles@example.com', avatarColor: 'linear-gradient(135deg, #10b981, #06b6d4)' },
];

function dtoToAppUser(dto: UserDto): AppUser {
  const name = dto.name?.trim() || dto.username || 'User';
  return {
    id: String(dto.id),
    username: dto.username,
    name,
    avatarColor: dto.avatarColor ?? 'linear-gradient(135deg, #6366f1, #7c3aed)',
    passwordLoginEnabled: dto.passwordLoginEnabled,
  };
}

interface UserContextValue {
  users: AppUser[];
  currentUser: AppUser;
  setCurrentUser: (user: AppUser) => void;
  apiReady: boolean;
  /** True while the first /api/users fetch (and optional seed) is in flight. */
  usersLoading: boolean;
  /** Set when user list cannot be loaded (quick-login hidden until fixed). */
  usersLoadError: string | null;
  retryUsersBootstrap: () => void;
  isAuthenticated: boolean;
  login: (username: string, password: string) => Promise<string | null>;
  applyOAuthSession: (accessToken: string) => Promise<void>;
  logout: () => void;
  githubOAuthEnabled: boolean;
}

const UserContext = createContext<UserContextValue | null>(null);

export let USERS: AppUser[] = [];

export function UserProvider({ children }: { children: React.ReactNode }) {
  const [users, setUsers] = useState<AppUser[]>([]);
  const [currentUser, setCurrentUser] = useState<AppUser>(EMPTY_USER);
  const [apiReady, setApiReady] = useState(false);
  const [usersLoading, setUsersLoading] = useState(true);
  const [usersLoadError, setUsersLoadError] = useState<string | null>(null);
  const [githubOAuthEnabled, setGithubOAuthEnabled] = useState(
    () => import.meta.env.VITE_GITHUB_OAUTH_ENABLED === 'true',
  );
  const [isAuthenticated, setIsAuthenticated] = useState(() => {
    return localStorage.getItem(AUTH_STORAGE_KEY) !== null && getStoredAuthToken() != null;
  });

  const syncUsersFromApi = useCallback(async (): Promise<AppUser[] | null> => {
    try {
      const dtos = await userApi.getAll();
      const mapped = dtos.map(dtoToAppUser);
      setUsers(mapped);
      USERS = mapped;
      return mapped;
    } catch {
      return null;
    }
  }, []);

  const applySessionFromStorage = useCallback((mapped: AppUser[]) => {
    const saved = localStorage.getItem(AUTH_STORAGE_KEY);
    const token = getStoredAuthToken();
    if (saved && token) {
      try {
        const parsed = JSON.parse(saved) as AppUser;
        const found = mapped.find((u) => u.id === parsed.id);
        if (found) {
          setAuthToken(token);
          setCurrentUser(found);
          setIsAuthenticated(true);
        } else {
          // Do not force-logout when user list is temporarily stale/incomplete.
          // Keep the stored session and let background sync reconcile later.
          setAuthToken(token);
          setCurrentUser(parsed);
          setIsAuthenticated(true);
        }
      } catch {
        localStorage.removeItem(AUTH_STORAGE_KEY);
        clearAuthToken();
        setIsAuthenticated(false);
      }
    } else {
      clearAuthToken();
      setIsAuthenticated(false);
    }
  }, []);

  const applyOfflineSessionFromStorage = useCallback(() => {
    const saved = localStorage.getItem(AUTH_STORAGE_KEY);
    const token = getStoredAuthToken();
    if (saved && token) {
      try {
        const parsed = JSON.parse(saved) as AppUser;
        setAuthToken(token);
        setCurrentUser(parsed);
        setIsAuthenticated(true);
      } catch {
        clearAuthToken();
        setIsAuthenticated(false);
      }
    } else {
      clearAuthToken();
      setUsers([]);
      USERS = [];
      setCurrentUser(EMPTY_USER);
      setIsAuthenticated(false);
    }
  }, []);

  const loadUsersBootstrap = useCallback(async () => {
    setUsersLoading(true);
    setUsersLoadError(null);
    try {
      let githubOAuth = import.meta.env.VITE_GITHUB_OAUTH_ENABLED === 'true';
      try {
        const cfg = await authApi.getConfig();
        githubOAuth = githubOAuth || cfg.githubOAuthEnabled;
      } catch {
        /* older backend or offline */
      }
      setGithubOAuthEnabled(githubOAuth);

      let dtos = await userApi.getAll();
      if (dtos.length === 0) {
        for (const seed of SEED_USERS) {
          await userApi.create(seed);
        }
        dtos = await userApi.getAll();
      }
      const mapped = dtos.map(dtoToAppUser);
      setUsers(mapped);
      USERS = mapped;
      applySessionFromStorage(mapped);
      setApiReady(true);
    } catch (e: unknown) {
      console.warn('User bootstrap failed', e);
      const msg = e instanceof Error ? e.message : 'Cannot reach API';
      setUsersLoadError(msg);
      setUsers([]);
      USERS = [];
      setApiReady(false);
      applyOfflineSessionFromStorage();
    } finally {
      setUsersLoading(false);
    }
  }, [applySessionFromStorage, applyOfflineSessionFromStorage]);

  useEffect(() => {
    void loadUsersBootstrap();
  }, [loadUsersBootstrap]);

  const applyOAuthSession = useCallback(
    async (accessToken: string) => {
      setAuthToken(accessToken);
      const payload = parseJwtPayload(accessToken);
      const uid = uidFromJwtPayload(payload);
      let user: AppUser;
      if (uid != null) {
        try {
          const dto: UserDto = await userApi.getById(uid);
          user = dtoToAppUser(dto);
        } catch {
          user = {
            id: String(uid),
            username: usernameFromJwtPayload(payload) ?? 'user',
            name: nameFromJwtPayload(payload) ?? 'User',
            avatarColor: 'linear-gradient(135deg, #ea4335, #fbbc04)',
            passwordLoginEnabled: false,
          };
        }
      } else {
        user = {
          id: '',
          username: usernameFromJwtPayload(payload) ?? 'user',
          name: nameFromJwtPayload(payload) ?? 'User',
          avatarColor: 'linear-gradient(135deg, #ea4335, #fbbc04)',
          passwordLoginEnabled: false,
        };
      }
      setCurrentUser(user);
      setIsAuthenticated(true);
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(user));
      setApiReady(true);
      setUsersLoadError(null);
      // Do not block OAuth callback redirect on user list bootstrap.
      void syncUsersFromApi().then((mapped) => {
        if (mapped && mapped.length > 0) {
          const found = mapped.find((u) => u.id === user.id);
          if (found) setCurrentUser(found);
        }
      });
    },
    [syncUsersFromApi],
  );

  const login = useCallback(
    async (username: string, password: string): Promise<string | null> => {
      try {
        const resp = await authApi.login({ username, password });
        const user = dtoToAppUser(resp.user);
        setAuthToken(resp.accessToken);
        setCurrentUser(user);
        setIsAuthenticated(true);
        localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(user));
        setApiReady(true);
        setUsersLoadError(null);

        void syncUsersFromApi().then((mapped) => {
          if (mapped && mapped.length > 0) {
            const found = mapped.find((u) => u.id === user.id);
            if (found) setCurrentUser(found);
          }
        });
        return null;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Login failed';
        return msg;
      }
    },
    [syncUsersFromApi],
  );

  const logout = useCallback(() => {
    setIsAuthenticated(false);
    clearAuthToken();
    localStorage.removeItem(AUTH_STORAGE_KEY);
  }, []);

  const retryUsersBootstrap = useCallback(() => {
    void loadUsersBootstrap();
  }, [loadUsersBootstrap]);

  return (
    <UserContext.Provider
      value={{
        users,
        currentUser,
        setCurrentUser,
        apiReady,
        usersLoading,
        usersLoadError,
        retryUsersBootstrap,
        isAuthenticated,
        login,
        applyOAuthSession,
        logout,
        githubOAuthEnabled,
      }}
    >
      {children}
    </UserContext.Provider>
  );
}

export function useCurrentUser(): UserContextValue {
  const ctx = useContext(UserContext);
  if (!ctx) throw new Error('useCurrentUser must be used inside UserProvider');
  return ctx;
}
