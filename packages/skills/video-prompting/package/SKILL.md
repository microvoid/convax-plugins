---
name: video-prompting
description: Write or improve prompts for text-to-video, image-to-video, reference-video, first-frame, last-frame, or multi-reference generation. Use when the user needs a model-aware video prompt, motion plan, negative constraints, or prompt diagnosis.
---

# Write a video prompt

Produce a prompt package that distinguishes story intent, visible motion, camera
behavior, references, and technical constraints.

## Establish the generation contract

1. Identify the target model or service when known, generation mode, references,
   duration, aspect ratio, frame rate, audio expectation, and intended use.
2. When references are on Canvas, call `canvas_query_nodes` in the active scope and
   keep the returned revision. Do not infer inaccessible paths or media metadata.
3. Separate fixed facts from creative choices: subject identity, environment,
   action, camera, timing, style, continuity, text, and prohibited changes.
4. Ask only for a missing reference role or output constraint that materially
   changes the prompt. Otherwise label assumptions and continue.

## Compose the prompt

Write in observable screen terms. Order information as:

1. subject and locked identity traits;
2. environment, time, weather, and spatial relationships;
3. action progression with clear start, change, and end state;
4. camera framing, position, lens feel, and one motivated movement;
5. lighting, material response, palette, and visual treatment;
6. timing, continuity, and explicit exclusions.

Assign every reference a role such as identity, style, composition, motion, first
frame, or last frame. Do not ask one reference to enforce contradictory roles.
Avoid invisible emotions, overloaded adjective lists, conflicting camera commands,
and unsupported parameter syntax.

## Adapt and validate

If current documentation or the live tool schema exposes model-specific limits,
adapt the prompt and parameters to those verified constraints. Otherwise provide a
portable master prompt and label model-specific settings as recommendations, not
facts.

Return the master prompt, concise negative constraints, reference map, timing beats,
parameter assumptions, and a diagnostic checklist. For prompt repair, explain the
likely failure mechanism and change one major variable per iteration.

Call a generator only when one is actually available and the user requested
generation; confirm before costly batches. Never claim a clip exists without a
successful result. If Canvas delivery is requested, re-query before adding the
prompt pack or real outputs with `canvas_add_resources`. Never write `.convax`.
