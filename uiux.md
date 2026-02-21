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

