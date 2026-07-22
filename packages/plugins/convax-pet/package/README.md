# Violet for Convax

Violet is a local pixel companion for Convax. The pet mirrors Agent activity
across projects, surfaces work that needs attention, and opens the corresponding
session when selected.

The Plugin is entirely declarative. Its inert ZIP contains no scripts, executable
runtime, network access, requested capabilities, or executable authority. Convax
owns the pet window, activity aggregation, navigation, preferences, and lifecycle;
this package contributes only Violet's metadata and sprite sheet through
`contributes.pet` with `spriteVersion: 2`.

The 1536×1872 sprite sheet follows `convax.pet-sprite/2`: eight columns by nine
rows, with 192 by 208 pixel cells. Rows are `idle`, `running-right`, `running-left`,
`waving`, `jumping`, `failed`, `waiting`, `running`, and `review` in that order.

## Artwork provenance

Violet is original artwork generated for this package with OpenAI image generation,
then manually reviewed and assembled into the fixed atlas grid. The `running` and
`review` rows were selected from separate generated variants, mechanically aligned,
and processed into a transparent WebP. No third-party character or sprite asset is
included.
