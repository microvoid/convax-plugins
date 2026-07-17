---
name: clip-export
description: Export image and video nodes from the active Convax Canvas into JianYing. Use when the user asks to send selected Canvas media to the currently open JianYing draft or create a new draft for those materials.
---

# Clip Export

Use the scoped Canvas and JianYing tools only. Never inspect native draft files,
automate the editor through shell commands, or write `.convax` data.

## Select export material

1. Resolve the active Canvas from host context and call `canvas_query_nodes` before
   doing anything that can export data.
2. Keep only nodes reported as image or video media. Do not treat text, Plugin, or
   missing nodes as exportable.
3. If the requested selection is ambiguous, show the candidate names or node ids
   and ask which ones to use.
4. Retain the latest Canvas revision returned by the query. Never invent a Canvas id
   or accept an id outside the active Project and Canvas scope.

## Choose the JianYing target

1. Call `jianying_get_draft_status` immediately before target selection.
2. Preserve the returned `draftToken`; it is short-lived and must not be reused for
   an unrelated attempt.
3. Handle each reported status conservatively:
   - for `active`, ask whether to use the named current draft or create a new one;
   - for `no_active_draft` or `not_running`, select a new draft;
   - for `ambiguous`, `unavailable`, or `unsupported`, stop and report the reason.
4. Never reinterpret an uncertain status as permission to create a new draft.

## Export

1. Call `jianying_export_canvas_media` exactly once with the selected `nodeIds`, the
   latest `expectedRevision`, and `target` containing the returned `draftToken` plus
   the explicit kind `current` or `new`.
2. Do not pass a Canvas id to the export call; the host binds it to the live scope.
3. If the revision is stale before export starts, re-query and ask again only when
   the selection or target choice is no longer valid.
4. Report the actual returned draft name, imported item count, target kind, and any
   warning or unverified outcome.

Do not retry automatically after a timeout, partial result, or unknown native
outcome because a repeated call may duplicate media. Explain the uncertainty and
let the user decide the next action.
