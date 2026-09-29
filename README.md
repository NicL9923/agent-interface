# Agent Interface

An installable web interface for a shared Hermes agent installation.

The planned experience centers on persistent assistant conversations, clear
progress and approval requests, and notifications that bring people back to their
work. Personal defaults simplify navigation for each household member.

## Status

Planning. No application code or deployment exists yet. React, TypeScript, Vite,
Fastify, and SQLite are proposed choices, pending the architecture review and a
Hermes integration spike.

Hermes owns agent execution, tools, memory, and canonical session history. The
interface will own presentation, human preferences, and notification delivery.

Private operating notes, account details, credentials, and transcripts stay
outside this public repository.
