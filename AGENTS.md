# AGENTS.md

## UI/UX Execution Contract

- All frontend work must follow shadcn Tailwind v4 and Radix primitives patterns.
- Use these as the first references before writing UI code:
- https://ui.shadcn.com/docs/tailwind-v4
- https://ui.shadcn.com/docs/components
- https://www.radix-ui.com/primitives/docs
- Local code reference: `/Users/sarvesh/code/ui/apps/v4`

## Implementation Defaults

- Keep Tailwind in v4 CSS-first mode.
- Keep design tokens and theme mappings in `app/globals.css` using `@theme inline`.
- Use `tw-animate-css` for animation utilities.
- Use official shadcn components in `components/ui/*` and compose from them.
- Prefer Radix-backed components (`Select`, `DropdownMenu`, `Sheet`, etc.) over native control elements when available.
- Preserve accessibility from Radix/shadcn patterns (focus rings, keyboard nav, aria semantics).

## Component Policy

- When a needed component exists in shadcn, install via CLI:
- `npx shadcn@latest add <component>`
- Avoid one-off custom primitives if a shadcn/Radix equivalent exists.
- If customization is needed, keep the component API compatible with upstream shadcn patterns.

## Quality Gate

- Build must pass: `npm run build`.
- UI must work in both light and dark themes.
- Primary flow must stay minimal: topic, turns, persona A/B, start/stop, saved conversations.
