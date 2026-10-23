# Fratoo — Project Docs

Living documentation for Fratoo: a custom IoT platform that intercepts telemetry from a
Plaato Airlock (ESP32 + Blynk legacy protocol), stores it in Postgres and shows it in a
React dashboard (it started out as a WordPress plugin, retired in 2.5.0).

This folder is the durable home for anything that isn't code — architecture, decisions,
deployment/ops runbooks, the admin user manual, and the roadmap. Code-level changes still
go in [`CHANGELOG.md`](../CHANGELOG.md) at the repo root; component-specific setup
(env vars, local dev commands) stays in each component's own `README.md`
(e.g. [`fratoo-bridge/README.md`](../fratoo-bridge/README.md)).

## Index

| Doc | What's in it |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | System overview, components, data flow, real device pin mapping |
| [DECISIONS.md](DECISIONS.md) | Why things are built the way they are — key architectural/design decisions and the reasoning behind them |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Installing, deploying, updating and operating a Fratoo server |
| [USER-MANUAL.md](USER-MANUAL.md) | How to use the dashboard — batches, charts, reports, notifications |
| [ROADMAP.md](ROADMAP.md) | Pending and future work |

## Conventions

- Keep entries dated (`YYYY-MM-DD`) when recording a decision or an operational event, so
  the history reads chronologically even as sections get edited in place.
- A "decision" belongs in `DECISIONS.md` if a future contributor could reasonably ask
  "why is it done this way instead of the obvious alternative?" — the obvious alternative
  and why it was rejected go in the entry.
- `DEPLOYMENT.md` is the runbook (how to install, deploy and operate), not a diary; the
  changelog is for shipped code changes.
- Never put real credentials, device tokens, private hostnames or IPs in the docs: use
  placeholders, and keep the real values in the git-ignored `ProjectDocs/private/`.
