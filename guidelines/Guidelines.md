# Venture GUI AI Guidelines

## Engineering Rules

- Refactor before patching. Do not stack quick `if/else` fixes onto already bloated logic.
- Keep functions focused. If a change pushes a function past roughly 50 lines or 3 nested levels, extract helpers first.
- Reuse existing patterns instead of copying logic. Shared behavior belongs in hooks, stores, utils, or small components.
- Delete obsolete code instead of commenting it out.
- Use clear naming. Avoid placeholders such as `tmp`, `data1`, or vague `handle`.

## Project Context

- Tech stack: React + Vite + Tailwind + Zustand + Framer Motion.
- Layout state is centralized in `src/app/store/useLayoutStore.ts`.
- Right-side page switching is controlled by the rail and related layout state.
- Prefer dense, precise, Apple-like UI. Avoid loose spacing and visually dirty shadows.
- Use solid panel backgrounds during animations. Do not rely on translucent overlay tricks.

## Change Workflow

- Start with impact analysis. Identify all affected modules and nearby duplicated logic before editing.
- Prefer architectural cleanup when a change touches layout, shared state, or repeated interaction patterns.
- After edits, validate the changed files with diagnostics and fix straightforward issues before finishing.
- When a change affects runtime behavior, inspect the page instead of assuming the UI is correct.

## Live Preview Rule

- Keep a Vite dev server available for this project with `npm run dev` whenever UI work is in progress.
- Default preview URL is `http://127.0.0.1:5173/`.
- After completing any code change, every AI must ensure the page is updated before handing off work.
- Required handoff sequence:
  1. Confirm the dev server is still running; restart it if config or startup files changed.
  2. Refresh or reopen the preview page so the latest code is rendered.
  3. Check for obvious runtime failures such as blank screens, import errors, console errors, or broken interactions.
  4. Only then report completion to the user, together with the active preview URL.
- If hot module replacement does not apply cleanly, do not ignore it. Restart the dev server and verify again.

## UI Standards

- Use flex and grid first. Absolute positioning is a last resort.
- Keep visual alignment exact. Do not approximate centering with hard-coded offsets.
- Favor stable, quiet components with subtle but high-quality motion.
- Apply shadows to surfaces, not to dark icons on light backgrounds.
