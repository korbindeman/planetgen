---
name: studio-style
description: Visual language and copy voice for planetgen studio chrome (sidebar, shell, picker, overlays, labels, controls). Use when adding or changing UI, CSS in index.html, studio Preact, typography, buttons, copy, or reviewing how the app looks. Triggers on letter-spacing, uppercase, text-transform, chrome, sidebar, style, and simple-english.
---

# Studio style

This skill covers the sidebar, the shell, the picker, popovers, and the look bar. The globe, the colormap, and canvas overlays are out of scope. CSS lives in the `<style>` block in `index.html`. Markup lives in `src/studio/`. Words follow `CONTEXT.md`.

## Type

Use the system UI sans-serif font. Set the rail to 13px with line-height 1.4. Make titles larger. Set `font-weight` to `650`. Do not change case to show hierarchy.

Do not set `text-transform: uppercase`. Do not add the wide `letter-spacing` that you bundle with it.

Do not set `letter-spacing`. Letter spacing does not look good. Leave the font default on titles too.

Write sentence case in the DOM. Write "Tectonics", not "TECTONICS". Show hierarchy with size, weight, and opacity (`0.42` to `0.55` for mute). Do not use case or tracking.

Set `font-variant-numeric: tabular-nums` on values that update. Set `text-wrap: balance` on titles. Set `text-wrap: pretty` on lead copy.

## Surface

Set the light palette. Dark mode is `filter: invert(1)` on `html`. Re-invert canvases. Do not add a second palette.

Use these tokens on `body`:

- `--pg-ink`: `#111`
- `--pg-rail`: `#f4f4f3`
- `--pg-hair`: `rgba(0,0,0,0.08)`
- `--pg-fill`: `rgba(0,0,0,0.055)`
- `--pg-fill-hover`: `rgba(0,0,0,0.08)`
- `--pg-muted`: `rgba(0,0,0,0.48)`
- `--pg-radius`: `8px`
- `--pg-radius-sm`: `6px`
- `--pg-ease`: `cubic-bezier(0.23, 1, 0.32, 1)`
- `--pg-ease-out`: `cubic-bezier(0.2, 0, 0, 1)`

Draw hairlines with `box-shadow: 0 ±1px 0 var(--pg-hair)`. Do not use `border` between rail sections. Use a stacked transparent shadow on raised cards. Mute with opacity. Restyle native widgets. Do not leave UA chrome.

## Controls

Make buttons ghost by default. Use one filled action. `.stage-forward` is ink with white type and `font-weight: 600`. A selected chip in a segmented track (stage tabs, look bar, bool params) is a white pill with a stacked transparent shadow, not a fill tint.

A combo is a padded fill well (`padding: 1px`, radius 7px). The inner action is a concentric rounded rect, not a flush split. Put a muted `.combo-label` inside the well (Seed, Name). Do not leave a text field with only a placeholder.

Gate hover with `@media (hover: hover) and (pointer: fine)`. On press, scale to `0.96` in 150ms with `--pg-ease-out`. Name the transition properties. Do not write `transition: all`. If the visible control is smaller than 40×40, extend the hit target with a `::before` inset. Set `:focus-visible` to a 2px `currentColor` outline.

If `prefers-reduced-motion: reduce` is set, drop transform motion.

## Parameter language

A knob is one tight row: label, value capsule, slider. Do not stack the value above a full-width slider.

The capsule is a fill well. The number is ink at weight 650 with `tabular-nums`. The unit sits on the right, smaller and muted to opacity `0.32`. Units that have a mark (`°`, `km`, `m`, `h`, `Gyr`) show it. Count, step, index, frac, and `1` show no mark. The capsule is editable. Escape cancels. Enter and blur commit and clamp to the vouched range.

The slider is a 1.5rem rounded rect (`5px`), the same height as the capsule. Fill the portion to the left of the thumb with `--param-t` (0..1) on the input. The thumb is a vertical 7px rounded rect flush with the track. No pill radii. No shadow, no circle.

Keep vertical rhythm tight: about `0.22rem` between rows. Labels truncate. Do not put the bound value in the label.

## Copy

Write UI copy with the simple-english skill. Use pragmatic mode. Project
docs are the **docs** skill, not this one.

Buttons and labels are technical names. Keep the words in `CONTEXT.md` as they are.

Do not put a bound input's value in a button label. The Save button next to the name field is Save or Saved. It does not repeat the name.

For body copy, empty states, and hints, obey the simple-english skill. Write one instruction per sentence. Do not write "should".

## Undo

Delete marks a record. It does not drop the id. Show `.undo-badge` with Undo. One badge at a time. The badge sits above the modal.

## Do not

- Set `text-transform: uppercase`
- Set `letter-spacing` of any kind
- Add a second typeface, a colour palette, or a dark-mode rewrite
- Draw borders between rail sections
- Put a second filled button in the same view
- Put a bound input's value in a button label
- Open the app in an agent browser. The user runs `bun run dev`.
