# Cohorte — logo

The mark is an open-end wrench whose jaw is the letter C: a cohort of agents, and the
bidouille that drives them. One shape, one colour.

## Rules

- **The bolt (the cream diamond) only appears on the dark tile.** Free-standing marks are the
  wrench alone, in a single colour.
- Below 48 px the bolt is dropped; the wrench holds down to 16 px.
- Clearspace: one jaw radius (12 units of the 64 grid) on all sides.
- Geometry: 64 grid, jaw radius 12, stroke 8.5, flat jaw tips, mouth opened 96°.
- Never re-space the wordmark. Space Grotesk 600, tracking −3%.
- Never outline, gradient, or shadow the mark.

## Colours

| Role | Hex |
| --- | --- |
| Amber (accent) | `#F5851F` |
| Tile | `#191512` |
| Cream | `#FAF6EF` |
| Ink | `#241E19` |

## Files

| File | Use |
| --- | --- |
| `cohorte-mark.svg` | amber mark, transparent — inline in README / dashboard |
| `cohorte-mark-mono.svg` | `currentColor` — inherits text colour wherever it is inlined |
| `cohorte-mark-ink.svg` / `-cream.svg` | one-colour on light / on dark |
| `cohorte-avatar.svg` | dark tile + bolt, 22% radius |
| `cohorte-lockup-horizontal.svg` / `-stacked.svg` | mark + wordmark |
| `cohorte-banner.svg` | 1280×320 README header (vector) |
| `cohorte-banner.png` | 2560×640 README header — real typeface baked in, use this on GitHub |
| `cohorte-avatar-400/512/1024.png` | npm, GitHub org/repo avatar, social preview |
| `cohorte-mark-512/1024.png` | transparent mark |
| `favicon-16/32/48.png`, `icon-192.png`, `icon-512.png`, `apple-touch-icon-180.png` | dashboard favicon set |

The lockup and banner SVGs reference Space Grotesk and JetBrains Mono by name. Outline the text
(or use the PNG) anywhere the fonts are not guaranteed — GitHub strips font loading from SVG.

## ASCII splash

```
C— cohorte
```
