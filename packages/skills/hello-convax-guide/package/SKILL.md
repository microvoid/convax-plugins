---
name: hello-convax-guide
description: Explain how to verify the Hello Convax Plugin host connection safely.
---

# Hello Convax Guide

1. Confirm that the active Canvas contains a Hello Convax Plugin node.
2. Ask the user to press **Refresh context** in the Plugin surface.
3. A successful test displays `Connected through convax.plugin-host/1` and the
   current host-scoped Project, Canvas, and owning node context.
4. If it stays disconnected, report that the Plugin frame did not receive its
   scoped MessagePort. Do not work around the host or edit `.convax` state.
