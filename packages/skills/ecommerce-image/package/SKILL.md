---
name: ecommerce-image
description: Plan, prompt, or generate ecommerce product image sets for listings, storefronts, and campaigns. Use when the user needs hero images, gallery views, detail shots, lifestyle scenes, or channel-specific product creatives from supplied product references.
---

# Ecommerce Image

Create a coherent product-image set that preserves product identity and matches the
target sales channel. Generate assets only when a suitable image tool is present.

## Gather constraints

1. Identify the authoritative product references, brand rules, target channel,
   audience, locale, deliverable count, and required aspect ratios.
2. When references are Canvas nodes, call `canvas_query_nodes` in the active scope
   and retain the latest revision. Do not infer hidden files or another Canvas.
3. Ask only for missing facts that materially affect production, such as an unknown
   package variant, mandatory label text, or marketplace background requirement.
4. Separate verified product facts from creative direction. Never invent product
   claims, certifications, dimensions, ingredients, logos, or endorsements.

## Design the image set

Build a shot matrix appropriate to the request. Consider:

- a clean primary hero with strong silhouette and safe margins;
- alternate angles that explain form and scale;
- close details for materials, controls, or craftsmanship;
- a lifestyle scene showing intended context without misleading performance;
- variant or bundle views with unambiguous quantity;
- optional campaign crops that retain a clear product focal point.

For every shot specify purpose, reference priority, product pose, camera and lens
feel, background, lighting, props, composition, aspect ratio, and copy-safe area.
Add fidelity checks for geometry, color, label spelling, variant, and item count.

## Generate or prepare production

1. If a compatible image generation or editing tool is actually available, use the
   product references it supports and generate a small proof set before scaling.
2. Review outputs against the shot matrix. Reject warped packaging, false text,
   incorrect variants, duplicate parts, unsupported claims, and implausible scale.
3. If generation is unavailable, return a complete production pack containing a
   master product description, per-shot prompts, negative prompt, reference map,
   dimensions, crop guidance, variation matrix, and acceptance checklist.
4. Never report an image as generated unless a tool returned a real output.

If the user requested Canvas delivery and output files exist, re-query first and use
`canvas_add_resources` with the latest revision. Add a markdown production pack as
an inline-text resource only when requested. Reveal additions with `canvas_view`;
do not modify unrelated nodes or write `.convax` directly.
