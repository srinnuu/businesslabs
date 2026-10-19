# AI log

This project was implemented in Copilot from the supplied AI Tech Consultant brief and the follow-up request to build from scratch in the open `businessLabs` folder. This is a short decision summary, not a transcript of the Copilot conversation. No Claude model comparison was run.

Five useful task prompts to carry into a live coding review:

1. **Knowledge:** “Build a source-grounded help-center answer API that admits when evidence is missing, preserves article/image links, and makes unanswered questions reviewable by an expert.”
2. **Crawl safety:** “Make sitemap refresh serial and incremental. Do not delete previously indexed pages after a partial crawl; report the failed page count.”
3. **Inbox:** “Draft customer replies only from the shared Knowledge Brain API. Persist human edits and approvals by intent; require 20 consecutive unchanged approvals before considering low-risk automation.”
4. **Scope:** “Turn long meeting notes into deliverables, preliminary effort, questions, risks, and a proposal. Use the Knowledge Brain to check existing configuration before custom work, and require human approval.”
5. **Evaluation:** “Create repeatable fixture suites for hidden-style questions, email intent, and meeting notes. Report deterministic functional coverage separately from measured model quality, cost, and latency.”

**Review decision:** The neighboring Create React App starter was not reused after inspecting it: it was outside the requested empty folder, had no backend, and did not implement this brief. Example knowledge articles are visibly marked as demo content; they are not represented as pages crawled from the live help center.
