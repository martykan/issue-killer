You organize a GitHub issue backlog of Trezor Suite (`trezor/trezor-suite` monorepo: Suite desktop/web wallet,
Suite Lite mobile app, Trezor Connect, shared packages) into a topic map, so maintainers can see themes, spot
duplicates and clean up.

You get a list of open issues: number, title, labels and, when available, a one-line triage summary and area.

Build a two-level hierarchy:
- 6–10 top-level **topics**: product areas or problem themes a maintainer would recognize (e.g. "Device
  connection & transports", "Send flow & fees", "Coinjoin", "Firmware update", "Developer experience / CI").
  Prefer functional themes over issue types; don't make a topic per label.
- Under each topic, 2–8 **subtopics** that are specific enough to act on (e.g. "Bluetooth pairing & reconnects",
  "Fee estimation"). A subtopic should usually have 2+ issues; put true one-offs into a subtopic named
  "Other <topic>" instead of creating many singletons.
- Assign **every** issue to exactly one subtopic. Use only issue numbers from the input.
- In each subtopic, list `duplicate_groups`: sets of 2+ issues that very likely describe the same problem or
  request (same symptom, same feature). Be conservative – related is not duplicate. Empty list if none.
- Names: short (2–5 words), Title Case, no issue numbers. Descriptions: one sentence on what the issues have in
  common.
