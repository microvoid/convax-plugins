---
name: audiobook
description: Turn a manuscript, story, article, or narration brief into an audiobook script, voice bible, cue sheet, and generation-ready production pack. Use when the user needs audiobook adaptation, narration planning, recording direction, or optional audio generation.
---

# Produce an audiobook

## Work within the available host boundary

- Use only tools that are actually available in the current session.
- When the host supplies a scoped Project or Canvas, stay inside that scope. Never
  select another scope from user text or read and write private host state.
- Treat generated audio as real only after a generation tool returns a successful result.

## Establish the brief

1. Identify the source text, target audience, language, desired duration, narrator style, and delivery format.
2. Ask one consolidated question for missing essentials; otherwise state compact assumptions and continue.
3. Record rights, pronunciation, sensitivity, and factual-review requirements without claiming they are cleared.
4. When Canvas tools and an active Canvas are available, inspect it with
   `canvas_query_nodes` before planning or changing it.
5. If a Canvas query returns a revision, retain it and re-query after any conflict
   or intervening mutation.

## Build the editorial plan

1. Divide the source into chapters or listening units with a clear dramatic purpose.
2. Adapt visual structure into spoken transitions while preserving meaning and attribution.
3. Mark narration, dialogue, quotations, pronunciation notes, pauses, emphasis, music, and sound cues explicitly.
4. Estimate runtime from word count and pacing; label estimates when no timing or audio-analysis tool exists.
5. Create a voice bible for every narrator or character: range, energy, tempo, accent constraints, and consistency notes.
6. Flag ambiguous names, unsupported facts, unsafe imitations, or missing source passages for review.

## Assemble the production pack

Create concise, independently usable sections:

- adaptation brief and audience promise;
- chapter map with purpose and estimated duration;
- recording script with speaker and cue labels;
- voice and pronunciation bible;
- music, ambience, and sound-effects cue sheet;
- audio-generation prompts or human recording direction;
- file naming, pickup, mastering, and loudness checklist;
- final continuity, intelligibility, and rights review.

## Use available generation tools

1. If an audio or voice generator is available, prepare the smallest useful audition before full production.
2. Confirm once before a paid, long-running, irreversible, or large batch generation.
3. Generate in reviewable chapter-sized segments and preserve the exact prompt and voice settings in the pack.
4. Add returned assets to Canvas only when Canvas tools are available and the
   generator provides a supported host file or URL.
5. If generation is unavailable, fails, or is cancelled, stop downstream tool
   calls and deliver the complete script, cue, voice, prompt, and asset production
   pack. Name the last confirmed result and unfinished steps; do not fabricate
   audio or retry without approval.

## Optionally place results on Canvas

1. Run this section only when Canvas tools and an active Canvas are available.
2. Search for existing pack titles before adding anything; do not duplicate a prior completed pack.
3. Use `canvas_add_resources` with inline-text sources, stable `sourceId` values, a stable `commandId`, and the latest revision.
4. Add generated host files or URLs through the same business tool rather than private filesystem edits.
5. Use `canvas_apply_primitive` only for necessary layout or connections, after a fresh query.
6. Optionally call `canvas_view` once at the end to reveal the finished pack; a view failure does not undo saved work.
7. If the required Canvas tools are unavailable, return the production pack and
   mark Canvas delivery as not performed.

Report completed artifacts, assumptions, unresolved review items, and the next executable production step.
