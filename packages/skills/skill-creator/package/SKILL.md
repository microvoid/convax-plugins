---
name: skill-creator
description: Create or revise a portable agent Skill from concrete user workflows. Use when the user asks to design SKILL.md, scaffold a Skill bundle, improve triggering instructions, or package reusable references, scripts, or assets.
---

# Skill Creator

Build the smallest Skill that reliably changes how an agent performs the target
workflow. Ground every instruction in real user examples and available tools.

## Define the job

1. Collect two or three representative requests that should trigger the Skill and
   at least one nearby request that should not.
2. Identify the desired output, completion signal, common failure modes, and any
   action that needs user confirmation.
3. Inspect the capabilities exposed in the current session. Never invent tool names,
   permissions, installation behavior, or access beyond the active Project scope.
4. Confirm the destination when it is not supplied. A project-local folder is an
   authored artifact, not an automatically installed or discovered Skill.

## Plan the bundle

Use a lowercase kebab-case id of at most 64 characters and make the directory name
match the frontmatter `name`.

Choose only resources that will be reused:

- keep the core decision process and execution sequence in `SKILL.md`;
- place selectively needed domain detail in `references/`;
- add `scripts/` only for repeatable deterministic work;
- add `assets/` only when files are copied or transformed into outputs;
- add agent-facing UI metadata only when the target host supports it.

Do not add a README, changelog, installation guide, dependency tree, secret, or
process diary to an individual Skill bundle.

## Author the instructions

1. Start `SKILL.md` with only single-line `name` and `description` frontmatter.
2. Put the complete triggering description in `description`: state what the Skill
   does and the situations in which it should be selected.
3. Write the body in imperative form. Prefer a short ordered workflow, decision
   rules, failure behavior, and output contract over broad explanation.
4. Require a fresh query and revision before Canvas mutations. Use public business
   tools before primitives and never direct an agent to edit `.convax`.
5. Describe a truthful fallback whenever an optional generator or integration may
   be absent. A production-ready handoff is valid; a fabricated success is not.

## Validate and deliver

Run the target repository's validator when it exists. Test added helper scripts with
representative inputs without executing untrusted third-party code. Re-read the
Skill using the trigger and non-trigger prompts, then check paths, licenses, and
portable dependencies.

If file-writing tools are unavailable, return a complete handoff containing the
directory tree and full content for every required file. Do not claim the Skill was
created, installed, or validated unless the corresponding operation succeeded.
