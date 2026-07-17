# Skill authoring

A Skill is a native OpenCode instruction bundle installed into Convax's managed user
Skill store. It teaches a workflow; it does not register code, tools, permissions,
or a second implementation of Canvas/Project rules.

The ZIP root must contain `SKILL.md` with YAML frontmatter:

```md
---
name: review-storyboard
description: Review a storyboard using existing Canvas read and view tools.
---

# Review storyboard

1. Inspect the active Canvas snapshot.
2. Report composition issues with node ids.
3. Ask before applying optional view changes.
```

`name` must equal the package id and use kebab-case. Keep `description` specific so
agents can select the Skill correctly. Put detailed, selectively-read material in
`references/`. Scripts are allowed only when they are portable, reviewable helpers;
Convax installation never runs them, and instructions must not claim they execute
with extra authority.

Skills must stay inside the active host scope, use typed public capabilities, respect
revision/conflict handling, and never instruct an Agent to edit private `.convax`
JSON. Do not embed secrets, tokens, absolute paths, dependency trees, generated
binaries, or instructions to disable safety checks.

A Plugin companion Skill remains a separate install and lifecycle. Its presence
does not grant the Plugin capabilities, and removing either one does not silently
remove the other.
