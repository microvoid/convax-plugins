# Convax Pet

Convax Pet is one sandboxed feature Plugin that owns the floating pet experience,
the settings surface, activity presentation, and a packaged collection of pets.
Individual characters are library entries, not separate Convax Plugins.

The `convax.plugin/5` manifest declares `contributes.pet` with the static overlay,
settings, `convax.pet-library/1` document, and `convax.pet-host/1` protocol. Convax
provides only the native window, content-free Agent activity, validated navigation,
installed asset serving, and bounded preferences. Plugin code has no Node,
Electron, network, arbitrary filesystem, or executable authority.

The first packaged pet is Violet. Its 1536×1872 WebP follows
`convax.pet-sprite/2`: eight columns by nine rows with 192×208 cells. Rows are
`idle`, `running-right`, `running-left`, `waving`, `jumping`, `failed`, `waiting`,
`running`, and `review` in that order.

Future pets are added to `pet-library.json` and bundled into a new version of this
same feature Plugin. The first release does not import legacy pet folders, raw
spritesheets, or remote pet assets.

## Artwork provenance

Violet is original artwork generated for this package with OpenAI image generation,
then manually reviewed and assembled into the fixed atlas grid. The `running` and
`review` rows were selected from separate generated variants, mechanically aligned,
and processed into a transparent WebP. No third-party character or sprite asset is
included.
