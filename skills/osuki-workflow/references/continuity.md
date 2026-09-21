# Follow-up coordination

OpenCode owns execution, delivery and child sessions. Osuki's work record preserves the objective and unresolved requests; it is not a second native inbox. Its status describes the objective, not whether a process is running. Read full pending text with osuki_work status when the injected preview is insufficient.

Interpret the injected Jev category against the actual user message:

- question: answer without changing the objective or stopping workers. A question is not implementation permission.
- amend: check compatibility, forward the relevant addition using the affected child's sessionID and background=true, and checkpoint the updated requirements. Confirm the result covers the addition.
- independent: keep the request pending until dependencies and shared files/resources are checked. Delegate in parallel only with separate ownership; otherwise finish current work first. Record accepted work in the objective before resolving its pending entry.
- conflict: pause affected workers through native controls, establish which requirements changed, then checkpoint and continue the appropriate existing child. Clarify ambiguity before discarding work.
- cancel: honor explicit user intent immediately. osuki_work pause/cancel interrupts all recorded children; for a narrower stop, use the affected child's native control instead. Never auto-resume.
- uncertain: inspect the message and context or ask a focused question. Do not cancel work or authorize new edits based on the fallback.

Use the latest revision for state changes. Only checkpoint accepts objective updates and resolved IDs from pending user messages; these IDs are never acceptance criteria. complete/pause/block/cancel accept only action, revision and evidence. For example: `{"action":"block","revision":0,"evidence":"Review service unavailable; diff checks passed."}` uses the observed revision, not a fixed zero. Keep deferred requests pending. Preserve unchanged requirements; check older worker results against current scope before accepting them.

Native worker notifications and session inspection are execution evidence. A stored child ID, a delivered instruction, or a successful tool call is not proof of completed implementation. Reconcile workers after reconnect/reload before reporting progress; do not spawn duplicates or silently restart stopped work. Checkpoint resumes paused/blocked work only with explicit user direction.

Before handoff, integrate worker results, validate proportionately, resolve pending requests, then osuki_work complete with concrete evidence. Active goals still require their independent receipts. Tell the user whether you answered, forwarded, deferred, paused, or completed work; never report routing advice as an action already performed.
