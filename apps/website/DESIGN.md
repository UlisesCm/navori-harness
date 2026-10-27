---
name: navori website
description: Familiar technical identity, polished for a clear first explanation.
colors:
  primary: "#0369a1"
  primary-hover: "#075985"
  secondary: "#7c3aed"
  background: "#fafaf7"
  ink: "#0f172a"
  night: "#0a0f1f"
  night-surface: "#131a30"
  dark-accent: "#7dd3fc"
typography:
  headline:
    fontFamily: "Geist Sans, sans-serif"
    fontSize: "clamp(2.1rem, 4.2vw, 3.65rem)"
    fontWeight: 600
    lineHeight: 1.13
    letterSpacing: "-0.035em"
  display:
    fontFamily: "Instrument Serif, serif"
    fontWeight: 400
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Geist Sans, sans-serif"
    fontSize: "1rem"
    lineHeight: 1.5
  code:
    fontFamily: "Geist Mono, monospace"
rounded:
  control: "6px"
  room: "10px"
  stage: "16px"
spacing:
  compact: "8px"
  base: "16px"
  group: "24px"
  section: "80px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#ffffff"
    rounded: "{rounded.control}"
    padding: "10px 16px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
---

# Design System: navori website

## Overview

Refine the existing sky/violet identity rather than replacing it. The user explicitly asked for polish, better spacing and a less AI-generated appearance. Preserve the original hero terminal. Navigation and footer show the plain name; a two-stroke interlocking sky/violet mark is reserved for browser and touch icons.

## Colors

Keep the existing palette in `src/styles/global.css`. Solid deep sky actions remain clear. Restore the original grid and sky/violet background, extending the texture across the entire site with visible lines in both themes. Dark mode keeps the existing navy surfaces and uses a light sky accent.

## Typography

Fonts are self-hosted through the existing Fontsource packages. Geist Sans carries readable instructions, Instrument Serif preserves the existing italic emphasis, and Geist Mono is reserved for the request terminal, commands and measurements. Chinese keeps the native CJK fallback and avoids synthetic italics.

## Layout

The existing 72rem container remains. Desktop demonstrations allocate 26% to the request terminal and 74% to the explanatory scene. At 640px and below, they stack. Navigation collapses at 900px. Keep at least 44px control targets and allow copy to wrap. On the home, use 80px section spacing on desktop and 56px on mobile; group related content more tightly.

## Elevation & Depth

Prefer borders and quiet tonal surfaces. Preserve the terminal's familiar depth and background texture; avoid adding hover lifts throughout the page. Code panels and diagrams explain real content.

## Shapes

Controls use 6px corners, scene rooms 10px and the demonstration frame 16px. The mark uses a 64-unit square with 16-unit corners. Generate derived icons from `src/assets/navori-mark.svg` with `bun run assets:brand` in this app.

## Components

The demonstration is an illustrative story, not a running agent or a guarantee. Eight mutually exclusive scenes introduce their own objects: a shared folder branches to projects, project guidance arrives as context, tgrep scans files and marks a match, CodeGraph draws relationships, specialists pass work, boundaries stop an out-of-scope action, checks exercise a button, and engram saves a decision for the next task. A geometric robot provides continuity through purposeful gestures rather than a perpetual bounce. Reveal timing is 420ms between related objects, with a 6500ms reading dwell. Animations are finite and use transforms, opacity or bounded SVG stroke drawing. Playback pauses outside the viewport and in a hidden document, stops at the end, and starts paused under reduced motion. Pausing reveals the final state of the scene. Manual steps and a complete text explanation remain available. Install controls use pressed buttons in a labeled group, with copy feedback.

## Do's and Don'ts

- Explain the benefit before introducing a technical name.
- Keep detailed configuration, plugin mechanics and differentiation in Deep dive.
- Keep diagrams supplementary to readable text; never make motion the only explanation.
- Preserve the three locales, theme switching, base paths and semantic fragments.
- Do not invent customers, benchmarks, enforcement parity or automatic approval guarantees.
- Do not turn a polish request into a new visual world.
