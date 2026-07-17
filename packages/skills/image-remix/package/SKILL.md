---
name: image-remix
description: Remix or restyle one or more reference images into controlled variations. Use when the user wants to preserve selected subjects, products, composition, or brand traits while changing style, setting, lighting, palette, crop, or mood.
---

# Image Remix

Produce a traceable image-remix brief and, when the session exposes a suitable
image generation or editing tool, render the requested variations.

## Establish the brief

1. Identify the source images supplied by the user or present on the active Canvas.
2. When Canvas nodes are involved, call `canvas_query_nodes` with the host-provided
   active Canvas id and retain its returned revision. Never invent another scope.
3. Separate the request into:
   - elements that must remain recognizable;
   - elements that may change;
   - elements that must be removed or avoided;
   - target use, aspect ratio, resolution, and variation count.
4. Ask only for a missing choice that would materially change the result, such as
   which product is authoritative or whether text must remain exact.
5. Treat logos, labels, faces, and product geometry as fidelity-sensitive. Do not
   promise pixel-exact preservation unless the available tool guarantees it.

## Build the remix specification

Write one master specification containing:

- reference roles and their priority;
- subject, pose, framing, camera, and depth;
- setting, materials, palette, lighting, and atmosphere;
- explicit preserve, change, and exclude lists;
- output dimensions and crop-safe zones;
- acceptance checks for identity, text, artifacts, and brand consistency.

Create separate prompts when variations differ structurally. Do not hide competing
directions in a single ambiguous prompt.

## Produce or hand off

1. If a compatible image tool is actually available, pass only supported reference
   inputs and parameters to it. Never claim a render occurred before receiving a
   successful tool result.
2. Inspect every returned image against the acceptance checks. Report deviations
   plainly and do not silently substitute a different concept.
3. If no compatible image tool is available, return a complete production pack:
   master prompt, negative prompt, reference-role map, size and crop settings,
   variation matrix, fidelity checklist, and recommended iteration order.
4. If generation fails or is cancelled, stop downstream tool calls, report the last
   confirmed result and unfinished steps, and do not retry or publish without
   explicit approval.
5. If the user requested Canvas placement and a real output file exists, re-query
   the Canvas and add it with `canvas_add_resources` using the latest revision.
6. Use `canvas_view` only to reveal completed additions; a view failure does not
   mean a successfully saved resource was reverted.
7. If the required Canvas tools are unavailable, return the production pack and
   mark Canvas placement as not performed.

Stay within the active Project and Canvas. Do not edit `.convax`, infer private file
paths, overwrite references, or perform unrelated Canvas mutations.
