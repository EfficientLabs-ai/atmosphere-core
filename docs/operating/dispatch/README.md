# dispatch/

Scoped task files the orchestrator drops here for **worker terminal sessions** to execute in
parallel. See [`../PARALLEL.md`](../PARALLEL.md).

Each file: the task, the exact files to touch, and acceptance criteria. A worker opens a fresh
`claude`, runs `Execute docs/operating/dispatch/<file>.md. Follow OPERATING-MODEL.md. Write results
+ a DONE line back, then stop.`, and reports back here. The orchestrator runs the merge gate.

*(Empty until a parallel sprint is dispatched.)*
