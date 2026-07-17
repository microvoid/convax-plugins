---
name: film-shot
description: Design cinematic shots for a scene, script, storyboard, or visual sequence. Use when the user needs coverage, camera choices, blocking, continuity, a shot list, storyboard descriptions, or generation-ready image and video prompts.
---

# Design film shots

Turn story intent into shootable or generatable coverage without decorating every
beat with unnecessary camera movement.

## Read the scene

1. Identify the dramatic objective, turning point, point of view, characters,
   location, time, duration, delivery format, capture format, available lenses and
   support, lighting limits, location restrictions, and references.
2. Inspect relevant active Canvas nodes with `canvas_query_nodes` and keep the
   returned revision. Never widen the host-provided scope.
3. Establish continuity anchors: screen direction, geography, eyelines, wardrobe,
   props, lighting state, weather, and character position.
4. Ask only about ambiguity that changes staging or meaning; state safe assumptions
   for cosmetic details.

## Build coverage

Break the scene into dramatic beats, then assign the minimum coverage needed. For
each shot specify:

- shot id, beat, purpose, subject, and action;
- framing, angle, camera height, lens character, distance, and movement;
- blocking, foreground, background, focus, lighting, and sound cue;
- estimated duration, transition, and continuity dependencies;
- reference inputs and any element that must remain locked.

Preserve a readable master when geography matters. Use close coverage for a reason,
maintain the 180-degree line unless a deliberate crossing is motivated, and avoid
camera motion that competes with the action.

## Deliver the shot pack

1. Present a compact scene strategy and numbered shot table.
2. Add continuity notes, pickup options, risky shots, and a fallback coverage plan.
3. For generated media, provide one self-contained prompt per shot plus negative
   constraints and reference roles. Do not bury multiple shots in one prompt.
4. Include an edit-order proposal and checks for spatial clarity, performance,
   pacing, identity consistency, and asset feasibility.

If an appropriate generator is available, confirm before expensive batches and
test one representative shot. Otherwise the shot table and prompt pack are the
complete deliverable; never fabricate frames or clips.

If generation fails or is cancelled, stop downstream tool calls, report the last
confirmed result and unfinished steps, and keep the shot and prompt pack as the
deliverable. Do not retry or publish without explicit approval.

When Canvas placement is requested, re-query and add the plan or real outputs with
`canvas_add_resources` using the latest revision. Use primitives only for necessary
layout, keep stable command ids, and never edit `.convax` directly. If the required
Canvas tools are unavailable, return the pack and mark placement as not performed.
