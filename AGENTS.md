# Repository Guidelines

## Project Structure & Module Organization
- `server.js` — Node.js dev server that serves static assets and proxies cross-origin HLS requests through `/proxy/…`.
- `index.html`, `styles.css`, `player.js` — Front-end entrypoint, styling, and player logic; all assets live in the repo root for easy static hosting.
- `README.md` — Quick start instructions for running the demo player and explaining proxy behaviour.
- No nested packages or build pipeline; the repo intentionally stays lightweight for rapid iteration.

## Build, Test, and Development Commands
- `node server.js` — Starts the combined static server and CORS proxy on `http://localhost:3000`.
- `PORT=4000 node server.js` — Overrides the listen port when running alongside other local services.
- Manual reload (⌘R / Ctrl+R) in the browser is sufficient; no bundler or watch task is required.

## Coding Style & Naming Conventions
- JavaScript uses modern ES modules with strict mode implied; keep 2-space indentation and prefer double quotes for strings to match `player.js`.
- Keep functions small and descriptive; helper utilities (e.g., `ensureProxy`) live near their callers.
- CSS favors BEM-like single-word class names (`.player-container`); avoid utility frameworks unless discussed first.
- Keep comments succinct and only where behaviour is non-obvious (error recovery, proxy routing, etc.).

## Testing Guidelines
- Primary validation is manual playback: launch `node server.js`, open `http://localhost:3000`, and test both default and `?src=` override streams.
- Verify Chrome/Edge paths for proxy-assisted playback and Safari/iOS for native HEVC/HDR support.
- When adding features, document recommended test scenarios (device/browser combinations) directly in PR notes.

## Commit & Pull Request Guidelines
- Follow Conventional Commits (e.g., `feat:`, `fix:`, `chore:`) as seen in the existing history.
- Each commit should remain atomic: update related HTML/CSS/JS together with matching documentation.
- Pull requests should include: purpose summary, manual test notes, and any screenshots or screen recordings relevant to UI changes.
- Link related issues or task IDs in the PR body and request review before merging to `main`.

## Security & Configuration Tips
- Treat proxy use as development-only; avoid exposing `server.js` publicly without authentication and rate limiting.
- Do not hardcode credentials or private stream URLs in source; rely on query parameters or environment variables for sensitive values.
