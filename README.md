# Fieldnote

Fieldnote is a small AI tech-consulting workspace for answering customer questions, drafting inbox replies, and turning meeting notes into a reviewed project scope.

## Run locally

Requirements: Python 3.11+, Node.js 20+, and npm.

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
npm install
Copy-Item .env.example .env
npm run dev
```

Open **http://localhost:5173**. The app starts the React dashboard, Python API, and TypeScript inbox agent together. No model key is required for the local demo. To use Claude, add `ANTHROPIC_API_KEY` to `.env` and restart. `ANTHROPIC_MODEL` can select a model; the default is `claude-sonnet-4-20250514`.

The demo starts with clearly marked example help articles and 50 sample emails. The emails and replies are local examples: sending a reply updates the demo record; it does not contact a real customer. Connect a public help-center sitemap before relying on answers for a real business. Do not add real customer information to this demo deployment.

## What works

- **Knowledge Brain (Python):** searches indexed help articles, returns cited sources, hands unanswered questions to a human, stores expert answers as new knowledge, and syncs added, changed, and removed sitemap pages. A polite serial crawler has a configurable delay, a 500-page limit, page-size and timeout limits, and keeps old articles when a crawl is incomplete. Once a sitemap has been connected, sync runs every 24 hours while the API is running.
- **Inbox Agent (TypeScript):** includes 50 realistic email fixtures and accepts new sample emails, classifies their intent, calls the Knowledge Brain over HTTP, drafts grounded responses, and records whether a human edited or approved the draft. Low-risk automation is gated by 20 consecutive unchanged sends of that kind and adequate answer confidence. Sensitive intents remain human-reviewed. Sending is simulated, not connected to an email provider.
- **Meeting to Scope (Python):** chunks long notes, checks the Knowledge Brain for relevant product configuration, drafts deliverables, preliminary hours, open questions, risks, and a proposal, tracks follow-up changes, and requires approval before a scope is marked ready.
- **Claude is optional:** when configured, Claude is used for source-grounded answers, inbox wording, meeting extraction, and screenshot descriptions. Without a key, the app clearly reports Local demo mode and uses simple local retrieval and extraction; this fallback is not a substitute for a production model.

## Tests and build

```powershell
npm test
npm run test:python
npm run build
```

The deterministic test suite has 20 knowledge retrieval cases, 20 scope-drafting cases, and 20 inbox classification cases, plus workflow, safety, and learning-gate tests. These are functional fixtures, not evidence of Claude model accuracy, cost, or latency. See [EVALS.md](./EVALS.md) before making quality claims.

## API quick start

The Python API is at `http://localhost:8000`; interactive OpenAPI docs are at `/docs`. The TypeScript Inbox API is at `http://localhost:8001`.

```http
POST /api/knowledge/ask
Content-Type: application/json

{"question":"How do I change a member's plan?"}
```

The response contains an `answer`, article `sources`, `confidence`, and `needs_human`. The inbox calls this API directly; scope generation uses the same article retrieval function in the Python service. See [DESIGN.md](./DESIGN.md) for the complete handoff and endpoint contract.

## Notes

SQLite persists knowledge, scope drafts, human tasks, and activity in `data/consultant.db`. Inbox examples, learning streaks, and reply records persist in `data/inbox.json`. Both data files are ignored by Git. No authentication or production email delivery is configured.
