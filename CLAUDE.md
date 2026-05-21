# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

EnsoAI — Git Worktree Manager with AI Agent. An Electron desktop app for managing multiple AI agents (Claude, Codex, Gemini, etc.) in parallel across Git worktrees.

## Tech Stack

Electron 39 + React 19 + TypeScript 5.9 | Tailwind CSS 4 | Monaco Editor | xterm.js + node-pty | simple-git | Zustand | sqlite3

## Commands

```bash
pnpm dev                  # Development mode (runs scripts/dev.js → electron-vite dev)
pnpm build                # Production build (electron-vite build + copy-web-assets.cjs)
pnpm build:mac            # Build macOS (signed + notarized)
pnpm build:mac:unsigned   # Build macOS without code signing (local testing)
pnpm build:mac:debug      # Build macOS arm64 --dir, unsigned (fastest local iteration)
pnpm build:win            # Build Windows
pnpm build:linux          # Build Linux
pnpm generate:themes      # Regenerate theme files (npx tsx scripts/generate-themes.ts)
pnpm typecheck            # TypeScript type check (tsc --noEmit)
pnpm lint                 # Biome lint check
pnpm lint:fix             # Biome lint + auto-fix
pnpm test                 # Vitest (single run)
pnpm test:watch           # Vitest in watch mode
```

Package manager: **pnpm 10.26.2** (pinned via `packageManager` field). Node.js 20+ required.

`scripts/dev.js` wraps `electron-vite dev` to: (1) forward SIGINT/SIGTERM and kill the full process tree on Ctrl+C (electron-vite doesn't), and (2) append `--no-sandbox` on Linux where unprivileged user namespaces are disabled.

## Architecture

### Three-Process Model (electron-vite)

```
src/main/          → Electron main process (Node.js)
src/preload/       → Context bridge (contextIsolation: true)
src/renderer/      → React SPA (no router, tab/panel navigation)
src/shared/        → Types and utilities shared across processes
```

### Path Aliases

- `@/*` → `src/renderer/*` (renderer only)
- `@shared/*` → `src/shared/*` (all targets)

### IPC Architecture

All IPC channels centralized in `src/shared/types/ipc.ts` (~160 channels, `domain:action` naming). Pattern:

- **Handler** (`src/main/ipc/*.ts`): `ipcMain.handle()` per domain, delegates to service singletons
- **Bridge** (`src/preload/index.ts`): Typed `electronAPI` wrapper, one method per channel
- **Push events**: `webContents.send()` for terminal data, file changes, clone progress, etc.

Key IPC domains: `git`, `worktree`, `files`, `terminal`, `agent`, `settings`, `ai`, `claude`, `todo`, `remoteShare`

### Main Process Services (`src/main/services/`)

| Service | Description |
|---------|-------------|
| `git/` | GitService per workdir (Map-based), WorktreeService, GitAutoFetch |
| `terminal/` | PtyManager — node-pty instances, streaming data over IPC |
| `files/` | FileWatcher, LocalFileAccess with encoding detection (jschardet + iconv-lite) |
| `claude/` | ClaudeIdeBridge (WebSocket), McpManager, PromptsManager, HookManager, ProviderManager |
| `ai/` | AI providers for commit messages, code review, branch naming |
| `agent/` | AgentRegistry — Claude / Codex / Gemini / DeepSeek adapters |
| `cli/` | CLI agent process management (TUI agents like DeepSeek) |
| `remoteShare/` | RemoteShareServer, BoreManager (share local session via bore.pub) |
| `remote/` | Remote session client logic |
| `hapi/` | Embedded HTTP API server (paired with `remoteShare`) |
| `search/` | Workspace search via `@vscode/ripgrep` |
| `proxy/` | Outbound HTTP/HTTPS proxy support for AI providers |
| `todo/` | Todo persistence (sqlite3) |
| `updater/` | electron-updater integration |
| `webInspector/` | DevTools-style web inspector (uses `scripts/web-inspector.user.js`) |
| `app/` | App lifecycle, single-instance lock, window management |

`MenuBuilder.ts` and `i18n.ts` live alongside the service folders (top-level files in `services/`).

Each service has a matching IPC handler in `src/main/ipc/*.ts` (e.g. `git.ts`, `terminal.ts`, `claudeProvider.ts`, `hapi.ts`, `remoteShare.ts`, `cli.ts`, `webInspector.ts`).

### Renderer State (Zustand Stores)

20 stores in `src/renderer/stores/`:

| Store | Purpose |
|-------|---------|
| `settings/` | **Persisted** via custom `electronStorage` adapter (IPC → `settings.json` in userData). Covers theme, terminal, agents, AI, keybindings. ~830 lines with migrations. |
| `worktree.ts` / `worktreeActivity.ts` | Active worktree list, selection, per-worktree activity tracking |
| `editor.ts` | File tabs, dirty state, navigation history, per-worktree state |
| `terminal.ts` / `terminalWrite.ts` | Terminal sessions and write buffering |
| `repository.ts` | Git status, branches, logs |
| `sourceControl.ts` | Source control panel state |
| `agentSessions.ts` / `agentStatus.ts` / `agentTasks.ts` | Agent session tracking, run status, task list |
| `cloneTasks.ts` | Git clone progress per task |
| `codeReviewContinue.ts` | Code review resume state |
| `navigation.ts` | Panel/route navigation |
| `todo.ts` | Todo list state |
| `initScript.ts` | First-run / init script flow |
| `tempWorkspace.ts` | Temporary workspace state |
| `unsavedPrompt.ts` | Unsaved-changes prompt orchestration |

Store pattern: `create<State>((set, get) => ({...}))` with flat state and setter actions. Only `settings` uses `persist` middleware. `agentTasksEquality.ts` is a helper module (not a store) used to short-circuit re-renders.

### Renderer Layout

```
App.tsx (orchestrator, ~20 hooks)
├── WindowTitleBar         — Custom title bar
├── RepositorySidebar      — Repository list
├── TreeSidebar            — File tree
├── MainContent            — Panel dispatcher (agent, editor, terminal, source control)
│   └── Panels switch via Zustand state, kept mounted (CSS invisible) for state retention
└── BackgroundLayer
```

No React Router. Navigation via Zustand stores and `App/hooks/` (20 custom hooks).

### Preload

Single file `src/preload/index.ts` (~1200 lines) — `contextBridge.exposeInMainWorld('electronAPI', {...})`. Every renderer → main call goes through this typed bridge.

### Native Dependencies & Vite Externals

In `electron.vite.config.ts`, the main-process build externalizes `node-pty` and `@parcel/watcher` (Rollup `external`). When adding a new native module that uses N-API or prebuilt binaries (e.g. `sqlite3`-style modules), add it to the `external` list, otherwise electron-vite will try to bundle the `.node` binary and the build will fail at runtime.

`postinstall` runs `electron-builder install-app-deps` to rebuild native modules against the Electron ABI — re-run `pnpm install` after pulling changes that touch native deps.

## Code Conventions

### Tooling

- **Biome** replaces ESLint + Prettier. Config in `biome.json` (single quotes, 2-space indent, 100 char line width, trailing commas es5)
- **Tailwind 4** with `@theme` blocks in `globals.css`, OKLCH color space
- **Husky + lint-staged**: Pre-commit runs `biome check --write`

### Anti-Patterns (Prohibited)

| Prohibited | Reason |
|------------|--------|
| CDN-loaded Monaco workers | CSP restrictions — must use local worker imports |
| Direct `globals.css` theme modification | Use Ghostty theme sync mechanism |
| Manually implementing UI components | Use `@coss/ui` first (see design-system.md) |
| `as any` / `@ts-ignore` | Avoid type escapes; fix the types instead |

### Code Comments

- All code comments must be in **English**
- Keep comments brief and focused on the "why", not the "what"

## Design System

UI development must follow `docs/design-system.md`. Key points:

- **Components**: Use [@coss/ui](https://coss.com/ui) components first (`src/renderer/components/ui/`)
- **Colors**: CSS variables (`text-primary`, `bg-accent`, `text-muted-foreground`)
- **Sizes**: Tab bar `h-9`, tree nodes `h-7`, small buttons `h-6`
- **Spacing**: Compact `gap-1`, standard `gap-2`, indentation `depth * 12 + 8px`
- **Icons**: Lucide React; directories yellow, TS blue, JS yellow
- **Text truncation**: `min-w-0 flex-1 truncate` + fixed elements `shrink-0`
- **Animation**: Framer Motion with configs from `src/renderer/lib/motion.ts` (springFast/Standard/Gentle)
- **Monaco**: Local workers, theme synced from terminal (Ghostty) theme

## Commit Convention

[Conventional Commits](https://www.conventionalcommits.org/) format. Description in Chinese.

```
<type>[optional scope]: <Chinese description>
```

Only `feat`, `fix`, `ci`, `build` appear in auto-generated Release Notes.

## Key Files to Know

| File | Why it matters |
|------|----------------|
| `src/shared/types/ipc.ts` | All IPC channel names — modify when adding new IPC calls |
| `src/preload/index.ts` | IPC bridge — add typed wrappers here when adding channels |
| `src/renderer/stores/settings/` | Largest store with persistence and migrations — read carefully before modifying |
| `src/main/services/claude/ClaudeIdeBridge.ts` | MCP/IDE integration core via WebSocket |
| `docs/design-system.md` | Complete UI component patterns and styling rules |
