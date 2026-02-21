# UI/UX Guidelines

Design direction: minimal, modern, calm, and precise. The interface should feel inevitable, not decorative.

## 1) Core Product Taste

- Remove visual noise before adding visual style.
- Favor fewer, stronger elements over many small accents.
- Every element must answer one question: does this increase clarity or confidence?
- Default to stillness and restraint; motion exists only to explain change.

## 2) Visual Principles

- Use high contrast with soft edges, not harsh chrome.
- Prefer large blocks of clean negative space.
- Avoid ornamental gradients, badges, and shadows unless they communicate hierarchy.
- Keep one accent color family only; neutrals should do most of the work.

## 3) Typography

- Use one primary sans-serif family and one mono family for technical metadata only.
- Build hierarchy with size/weight first, then color.
- Target readable body size (`16px-18px`) and generous line height (`1.45-1.65`).
- Avoid long all-caps labels; reserve for tiny utility metadata.

## 4) Spacing and Layout

- Use an 8px spacing grid with consistent vertical rhythm.
- Keep layout modular: clear panel boundaries, aligned baselines, stable gutters.
- Prioritize one primary action region per screen.
- Avoid multi-column complexity on mobile; stack and preserve action order.

## 5) Component Behavior

- Buttons: strong primary, quiet secondary, never equal visual weight.
- Inputs: clean borders, clear focus ring, no heavy fills.
- Chips/status: concise and scannable, never paragraph-like.
- Lists/cards: identical structure and spacing for fast visual parsing.

## 6) State Design (Critical)

- Empty states must teach the next action in one sentence.
- Loading states should be subtle and non-jumpy.
- Error states should be explicit, short, and actionable.
- Success states should confirm outcome and what changed.

## 7) Motion

- Use short durations (`120-240ms`) and natural easing.
- Animate entry, not everything.
- Do not animate if it competes with reading.
- No infinite decorative animations.

## 8) Copy and Tone

- Use plain language; remove filler and hype.
- Keep labels concrete (`Refresh memory`, not `Sync intelligence fabric`).
- Status lines should include outcome + next context.
- Avoid repeated phrasing across controls and messages.

## 9) Accessibility Baseline

- Keyboard-first navigation for all core flows.
- Visible focus states on every interactive element.
- Color contrast must pass AA minimum.
- Use semantic HTML and clear aria-live regions for streaming content.

## 10) Discovery Product Specific Rules

- Preserve conversation legibility above all visual flourish.
- Keep evidence and confidence visible but lightweight.
- Surface important memory layers (micro/meso/macro/conflicts) as progressive disclosure.
- Prefer one-click actions for high-frequency workflows.

## 11) Build Checklist Before Shipping UI Changes

- Can a first-time user complete the primary flow in under 60 seconds?
- Are primary/secondary actions visually unambiguous?
- Are empty/loading/error states present for every major panel?
- Does the layout remain clean and readable on mobile?
- Are labels and statuses concise and non-repetitive?

## 12) Anti-Patterns to Reject

- Competing accents and multiple focal points.
- Dense dashboards with tiny text.
- Motion that does not explain state transitions.
- Overly decorative “AI-style” visuals that reduce trust.
- Hidden affordances for critical actions.

## 13) Snappy Modern Execution Spec (For Future Model Runs)

- Do not use default, untouched shadcn tokens. Always set a deliberate light and dark token palette.
- Keep one primary accent family and use it consistently for active states, focus, and agent-bubble emphasis.
- Replace flat panel stacks with layered depth: soft glass surfaces, subtle blur, low-noise shadows, and thin borders.
- Never put cards inside cards unless there is a clear information hierarchy need.

### Layout Rules

- Use a ChatGPT-like structure: collapsible left sidebar, central conversation thread, sticky composer/footer.
- Keep the thread as the visual center; side tools are secondary and should not compete for attention.
- Use sticky header and sticky composer with translucent background so context stays visible while scrolling.
- Avoid cramped widths: keep thread max width around readable prose measures (roughly 70-90 characters per line).

### Conversation Rendering Rules

- Render messages as left/right conversational bubbles with clear speaker labels.
- Differentiate speakers with contrast and surface treatment, not loud color overload.
- Prioritize text readability: 15-17px body size, generous line-height, and soft corner radius.
- Show stream updates progressively and animate message entry subtly once per message.

### Motion and Responsiveness Rules

- Interaction timing should feel fast: 150-220ms for hover/focus/press transitions.
- Include tactile feedback for buttons (tiny press scale) and clear focus rings on keyboard navigation.
- Use one entry animation pattern for messages; avoid layered or competing animations.
- Respect `prefers-reduced-motion` and disable non-essential animation there.

### Visual Cleanliness Rules

- Reduce border noise. Use borders only where they communicate structure.
- Prefer shadow + contrast + spacing for hierarchy before adding extra lines/dividers.
- Keep status/info text subdued; primary content must remain dominant.
- Keep controls compact and aligned; no oversized control bars for simple actions.

### Minimal Feature Budget Rules

- Keep the main screen limited to core actions:
- Topic input
- Turn count
- Persona A/B selection
- Start/Stop
- History actions should stay lightweight and tucked into the sidebar.

### Quality Gate (Must Pass Before Shipping)

- First glance should reveal: where to type, where to start, where conversation appears.
- No visual element should look decorative without functional purpose.
- Light and dark themes both maintain contrast and perceived depth.
- Mobile layout keeps the same action order and does not hide critical controls.

## 14) Source Of Truth For UI Implementation

- Primary reference for styling and setup: https://ui.shadcn.com/docs/tailwind-v4
- Primary reference for component patterns: https://ui.shadcn.com/docs/components
- Primary reference for primitives/composition: https://www.radix-ui.com/primitives/docs
- Local reference implementation: `/Users/sarvesh/code/ui/apps/v4`

## 15) Mandatory Build Pattern (shadcn v4 + Radix)

- Use Tailwind v4 CSS-first setup (`@import "tailwindcss"` and `@theme inline` tokens in `app/globals.css`).
- Use `tw-animate-css` for animation utilities (do not use legacy `tailwindcss-animate` plugin setup).
- Use official shadcn generated components from `components/ui/*`; avoid custom raw HTML controls when a matching shadcn component exists.
- Use Radix-backed composition patterns (`asChild`, `Slot`, portal primitives, `data-slot` attributes) from generated components.
- Keep `components.json` aligned with shadcn v4 conventions (`tailwind.config` empty, css variables enabled).

## 16) UI Change Workflow (Every Feature)

- Check the relevant shadcn v4 and Radix docs first.
- Prefer `npx shadcn@latest add <component>` instead of hand-rolling primitives.
- Keep design token changes in `app/globals.css`, not scattered inline.
- Validate with `npm run build` before shipping.
- If a component is customized, keep API-compatible wrappers so it can still be updated from shadcn registry later.
