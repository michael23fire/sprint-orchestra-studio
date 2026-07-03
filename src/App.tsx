import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { JiraLayout } from './components/JiraLayout';
import { Board } from './pages/Board';
import { Summary } from './pages/Summary';
import { Backlog } from './pages/Backlog';
import { Code } from './pages/Code';
import { Timeline } from './pages/Timeline';
import { Pages } from './pages/Pages';
import { Forms } from './pages/Forms';
import { TicketDetail } from './pages/TicketDetail';
import { SpaceOverview } from './pages/SpaceOverview';
import { SpacesList } from './pages/SpacesList';
import { Groups } from './pages/Groups';
import { Login } from './pages/Login';
import { OAuthCallback } from './pages/OAuthCallback';
import { RequireAuth } from './components/RequireAuth';
import { UserProvider } from './context/UserContext';
import { SpaceProvider } from './context/SpaceContext';
import { TicketProvider } from './context/TicketContext';
import './pages/Login.css';
import './pages/Groups.css';
import './App.css';

function AuthenticatedProviders() {
  return (
    <SpaceProvider>
      <TicketProvider>
        <Outlet />
      </TicketProvider>
    </SpaceProvider>
  );
}

function App() {
  return (
    <UserProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/oauth-callback" element={<OAuthCallback />} />
          <Route element={<RequireAuth />}>
            <Route element={<AuthenticatedProviders />}>
              <Route path="/" element={<JiraLayout />}>
                <Route index element={<Navigate to="/spaces" replace />} />
                <Route path="spaces" element={<SpacesList />} />
              <Route path="groups" element={<Groups />} />
                <Route path="space" element={<SpaceOverview />} />
                <Route path="board" element={<Board />} />
                <Route path="summary" element={<Summary />} />
                <Route path="backlog" element={<Backlog />} />
                <Route path="code" element={<Code />} />
                <Route path="timeline" element={<Timeline />} />
                <Route path="pages" element={<Pages />} />
                <Route path="forms" element={<Forms />} />
                <Route path="ticket/:ticketId" element={<TicketDetail />} />
              </Route>
            </Route>
          </Route>
        </Routes>
      </BrowserRouter>
    </UserProvider>
  );
}

export default App;
