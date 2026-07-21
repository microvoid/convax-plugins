# Skill authoring

A Skill published here is a portable [Agent Skill](https://agentskills.io/), not a
Convax-only extension. Convax provides a registry and managed installation path,
while the released ZIP remains usable by OpenAI Codex and other clients that
support the open `SKILL.md` format. A Skill teaches a workflow; installing it does
not register tools, grant permissions, or create a second implementation of host
domain rules.

## Source and bundle boundary

Keep Convax publishing metadata outside the portable bundle:

```text
packages/skills/<id>/
  package.json              # workspace dependencies/scripts; never included in the ZIP
  convax-package.json       # Registry/release metadata; never included in the ZIP
  package/                  # the exact ZIP root and portable Skill directory
    SKILL.md                # required Agent Skills entry point
    LICENSE                 # package license when required
    agents/openai.yaml      # optional OpenAI/Codex UI metadata
    scripts/                # optional deterministic helpers
    references/             # optional selectively loaded documentation
    assets/                 # optional output resources
```

Do not put `README.md`, installation guides, changelogs, contributor notes, or
release instructions in `package/`. `SKILL.md` is the runtime entry point. Human
documentation and marketplace copy belong at the repository or catalog layer.
`convax-package.json` is a Convax publishing envelope, not part of the Agent Skills
format and not part of the released Skill directory.

## Write `SKILL.md`

The ZIP root must contain `SKILL.md` with YAML frontmatter:

```md
---
name: review-storyboard
description: Review storyboards for composition, continuity, and pacing. Use when an agent needs a structured storyboard critique or revision plan.
---

# Review storyboard

1. Inspect the storyboard material available in the current session.
2. Report composition, continuity, and pacing issues with stable references.
3. If a compatible Canvas tool exists, offer scoped annotations; otherwise return
   the complete review in text.
```

For this registry's portable baseline:

- `name` must equal both the package id and Skill directory name, contain only
  lowercase letters, digits, and hyphens, and be at most 64 characters;
- `description` must say both what the Skill does and when it should activate, and
  must be at most 1,024 characters;
- keep the full `SKILL.md` under 500 lines and move detailed, selectively read
  material into directly referenced files under `references/`;
- use relative paths from the Skill root for bundled resources and avoid deep
  chains between reference files.

Keep the body imperative and bounded. Describe inputs, decision points, the
smallest useful workflow, completion criteria, failure and cancellation behavior,
and what requires confirmation. Do not restate general model knowledge that does
not change execution.

## Treat tools as optional capabilities

Portable does not mean every client exposes the same tools. Before naming or
calling a tool, require the agent to inspect the capabilities actually available in
the current session. Never tell an agent to invent a missing tool, approximate a
mutation with private filesystem access, or infer permission from installation.

For every optional integration, define one of these outcomes:

1. **Equivalent capability:** use a compatible available tool and preserve the
   same safety and output checks.
2. **Useful degradation:** return a production-ready plan, prompt, script, review,
   or other handoff that does not pretend the unavailable action occurred.
3. **Safe stop:** when the requested result is inherently tool-bound, identify the
   missing operation and stop without retrying or bypassing the host.

Denial, cancellation, timeout, partial success, and uncertain native outcomes are
not success. Report the last confirmed result and unfinished steps. Confirm before
paid, destructive, irreversible, external, or large-batch actions.

## Add portable resources

- Put repeatable deterministic helpers in `scripts/`; keep dependencies explicit,
  portable, and pinned where the runtime permits it.
- Put domain detail that is needed only in some runs in `references/`, and tell the
  agent exactly when to read each file.
- Put templates, media, lookup data, and other files consumed by outputs in
  `assets/`; do not use assets as hidden instructions.
- Do not include dependency trees, generated binaries, secrets, ambient
  credentials, symlinks, absolute paths, or machine-specific state.

Convax validation and installation treat bundled scripts as inert bytes and never
execute contributor code. A Skill may instruct an agent to run a reviewed script
later, subject to that client's normal permission and sandbox policy.

## Add optional OpenAI UI metadata

`agents/openai.yaml` is a recommended OpenAI/Codex extension, not a required Agent
Skills file. Other compatible clients may ignore it. Generate it from the finished
`SKILL.md` with the official `skill-creator` generator and include only:

```yaml
interface:
  display_name: "Review Storyboard"
  short_description: "Review storyboard composition and continuity"
  default_prompt: "Use $review-storyboard to review this storyboard and propose prioritized revisions."
```

Quote every string. Keep `short_description` between 25 and 64 characters. The
one-sentence `default_prompt` must explicitly mention `$<skill-name>`. Do not list
Convax host functions as OpenAI MCP dependencies: tool availability remains a
runtime capability check, not an installation grant.

## Preserve host safety

Skills must stay inside the active host scope, use typed public capabilities, respect
revision/conflict handling, and never instruct an Agent to edit private `.convax`
JSON. Do not embed secrets, tokens, absolute paths, dependency trees, generated
binaries, or instructions to disable safety checks.

A normal standalone Skill has its own install and removal lifecycle. When a
`convax.plugin/4` Plugin owns the Skill, set `ownerPluginId` in the Skill's
`convax-package.json` and add the matching `{name,path}` item to the Plugin's
`contributes.skills`. Convax may display this standard Skill with its owner, but it
must be installed, updated, and removed only with that Plugin. The portable Skill
ZIP remains independently usable by Codex and other compatible clients.

The Plugin packer reads the Skill workspace and injects it into the Plugin ZIP.
Never maintain a copied Skill tree below the Plugin source. npm dependencies and
workspace relationships are build concerns; they do not grant capabilities or
establish Convax lifecycle ownership. A package `build` script must finish before
validation and emit a self-contained portable `package/` tree; consumers never run
the package manager. Changing an owned Skill requires a versioned Release for both
the Skill and its owner Plugin because both deterministic ZIPs change.

## Validate

Before release:

1. Run the Agent Skills reference validator, or the bundled `skill-creator`
   `quick_validate.py`, against `package/`.
2. Regenerate and inspect `agents/openai.yaml` after changing `SKILL.md`.
3. Run `bun run workspaces:build:packages`, `bun run validate`, `bun test`, and
   `bun run pack` from this repository.
4. Test at least one representative request, one failure or missing-tool path, and
   one request that should not trigger the Skill.
5. Inspect the ZIP and confirm `SKILL.md` is at its root and
   `convax-package.json` is absent.
