---
name: short-drama-screenwriter
description: Write or revise short-form episodic drama for vertical video, social series, or compact narrative episodes. Use when the user needs a premise, character engine, beat sheet, episode outline, production script, hooks, cliffhangers, or dialogue polish.
---

# Write a short drama

Build a playable dramatic engine before expanding scenes.

## Define the series promise

1. Extract the premise, audience, genre, platform, episode count, target duration,
   content rating, budget limits, and required story facts.
2. Identify the protagonist's concrete goal, pressure, flaw, opposition, stakes,
   and the repeatable conflict that can sustain multiple episodes.
3. When source material is on Canvas, query it with `canvas_query_nodes` in the
   active scope and retain the latest revision.
4. Ask one consolidated question only when missing information changes the central
   conflict or safety boundary. Otherwise state assumptions.

## Shape the season and episode

Create a compact series bible with character wants, secrets, relationships,
locations, continuity locks, and an episode escalation ladder. For each episode
define:

- an opening disturbance that immediately changes the situation;
- a clear objective and obstacle expressed through action;
- escalating reversals that reveal character or information;
- a decisive turn near the end;
- a consequence or unresolved choice that earns the next episode.

Do not use confusion as a substitute for suspense. Avoid repetitive humiliation,
coercive romance, unsupported medical or legal claims, and cliffhangers unrelated
to the episode's central choice.

For a multi-episode request, default to the series bible, complete season beat
ladder, and one fully written representative episode. Expand every episode into a
production script only when the user requests that scope.

## Write the production script

1. Use scene headings, visible action, speaker names, concise dialogue, and only
   essential performance or sound direction.
2. Give characters distinct tactics and speech patterns; remove exposition both
   characters already know.
3. Keep scenes producible within the declared cast, location, effects, and duration
   budget. Mark any intentional exception.
4. Track props, wardrobe, time, injuries, knowledge, and relationship state across
   scenes and episodes.
5. End with a runtime estimate, continuity checklist, unresolved assumptions, and
   revision targets for hook, clarity, pace, character agency, and payoff.

The complete deliverable is the series bible, episode beat sheet, production
script, and continuity report. Optional image or video tools may create references
only when actually available; never fabricate generated assets.

If optional generation fails or is cancelled, stop downstream tool calls, report
the last confirmed result and unfinished steps, and keep the text deliverable. Do
not retry or publish without explicit approval.

For requested Canvas delivery, re-query and add the text pack through
`canvas_add_resources` with stable ids and the latest revision. Do not overwrite
source nodes, mutate unrelated content, or write `.convax` directly. If the
required Canvas tools are unavailable, return the pack and mark delivery as not
performed.
