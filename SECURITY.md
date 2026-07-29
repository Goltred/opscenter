# Security policy

## Supported versions

This project is pre-1.0. Security fixes land on the default development branch; there is no long-term support promise yet.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security problems.

Prefer one of:

1. **GitHub private vulnerability reporting** on this repository (Security → Report a vulnerability), when enabled
2. Contact the maintainer privately via the profile linked from the repository

Include enough detail to reproduce (affected version/commit, setup sketch, impact). You should get an acknowledgement when someone is available; there is no formal SLA while the project is early.

## What this project controls

OpsCenter can start game-server processes, run Steam download jobs, and read/write files under configured Arma roots on hosts that run the agent. Treat the panel like production infrastructure: OAuth carefully, keep `deploy/control-plane.env` private, and do not expose the agent gateway to the open internet without TLS and a clear trust model.

Operational hardening notes (honest current state): **[docs/SECURITY.md](docs/SECURITY.md)**.
