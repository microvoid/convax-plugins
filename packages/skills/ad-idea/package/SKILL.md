---
name: ad-idea
description: Develop advertising concepts from a product, brand, campaign, or launch brief. Use when the user needs a big idea, campaign territories, hooks, taglines, scripts, storyboards, or a production-ready creative proposal.
---

# Develop an ad idea

Create a decision-ready concept pack before attempting asset generation.

## Frame the problem

1. Extract the product, audience, desired action, channel, format, duration, locale,
   brand voice, mandatory elements, and prohibited claims.
2. Separate verified facts from aspirations. Never invent performance evidence,
   endorsements, scarcity, certifications, prices, or legal clearance.
3. When source material is on Canvas, call `canvas_query_nodes` in the active scope
   and retain its revision. Do not infer private files or another Project.
4. Ask one consolidated question only when a missing fact would change the core
   promise, target audience, or compliance risk; otherwise state assumptions.

## Generate distinct territories

Produce three genuinely different creative territories. For each include:

- a one-sentence human insight and campaign promise;
- the central device or tension, not just a visual style;
- a hook, narrative progression, product proof, and call to action;
- channel adaptations and the reason the idea fits them;
- execution risks, claim risks, and what must be verified.

Avoid concepts that differ only by color, setting, or tagline. Do not imitate a
living artist, copy a recognizable campaign, or imply rights to protected assets.

## Select and expand

1. Compare territories for relevance, distinctiveness, product clarity,
   feasibility, extensibility, and compliance.
2. Recommend one direction while keeping the tradeoffs visible.
3. Expand the selected direction into a production pack: key message, tagline
   options, beat sheet, shot or frame list, dialogue or voiceover, supers, CTA,
   visual system, audio direction, deliverable matrix, and acceptance checklist.
4. Mark every unverified product statement and required legal review.

## Execute truthfully

If compatible image, audio, or video tools are available, confirm before paid or
large-batch work and generate only a small proof first. Never claim an asset exists
until a tool returns it. If generation is unavailable, the complete concept,
script, shot, prompt, and review pack is the finished deliverable.

When Canvas delivery is requested, re-query first and add the pack through
`canvas_add_resources` with the latest revision and stable ids. Add only real output
files or URLs, reveal them with `canvas_view` if useful, and never write `.convax`.
