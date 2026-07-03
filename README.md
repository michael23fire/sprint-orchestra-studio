# Jira Agentic AI — Web (SPA)

Standalone **React + Vite + TypeScript** frontend for the Jira-style workspace UI (spaces, backlog, board, issues, etc.).  
This tree is a copy of `frontend/` from the full-stack **jira-agentic-ai** repo, kept at the **repository root** so you can version and deploy it separately.

## Prerequisites

- **Node.js 20+** and npm

## Setup

```bash
npm install
cp .env.example .env.local   # optional; edit API URL
npm run dev                  # http://localhost:5173
```

## Scripts

| Command | Description |
|--------|-------------|
| `npm run dev` | Vite dev server |
| `npm run build` | TypeScript check + production bundle → `dist/` |
| `npm run preview` | Serve `dist/` locally |
| `npm run lint` | ESLint |

## API URL

The SPA calls the backend with `fetch`. Base URL is set in **`VITE_API_URL`** (build-time / dev env).  
If unset, it defaults to **`http://localhost:8080`** — typically the Spring Cloud Gateway or the Spring Boot API, **not** a direct `:8081` service URL from the browser (see warnings in `src/api/client.ts`).

Example `.env.local`:

```bash
VITE_API_URL=http://localhost:8080
```

For production builds, set `VITE_API_URL` to your public API origin before `npm run build`.

## CORS

The backend must allow your SPA origin (e.g. `http://localhost:5173` in dev). Configure that in the API gateway / Spring CORS settings.

## Own Git repository

From this folder:

```bash
git init
git add .
git commit -m "Initial commit: SPA extracted from jira-agentic-ai"
git remote add origin <your-new-remote-url>
git push -u origin main
```

## Related repo

Backend (Java/Spring Boot), gateway, database migrations, and Docker Compose live in the **jira-agentic-ai** monorepo.
