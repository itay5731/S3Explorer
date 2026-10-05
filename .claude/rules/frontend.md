---
paths:
  - "src/**"
  - "index.html"
  - "vite.config.ts"
---

# Frontend rules

- React 19 + TypeScript (strict) + Vite. `npm run build` must pass with zero errors.
- Import contract types from `src/lib/types.ts`; never redeclare them.
- `src/lib/api.ts` is the only `invoke`/`listen` call site. Normalize rejected `AppError`s there.
  Route to `src/lib/mock.ts` when `window.__TAURI_INTERNALS__` is undefined.
- Long lists are virtualized (`@tanstack/react-virtual`). Progress events at 10 Hz must not
  re-render the object table: keep transfer state in its own store slice/context.
- Native dialogs via `@tauri-apps/plugin-dialog`; reveal files via `@tauri-apps/plugin-opener`;
  OS drag-and-drop via `getCurrentWebview().onDragDropEvent`.
- Keys: join with exactly one `/`, never double slashes; handle spaces and unicode.
- Styling: CSS variables, dark theme default with light via `prefers-color-scheme`, dense 13px
  table, system font stack. Icons from `lucide-react`. Must look polished, not default/Bootstrap.
- Never persist secrets in `localStorage` (profile name, region, endpoint, access key id only).
