# Evaluation plan

## What the current numbers mean

`tests/test_api.py` has 20 fixed knowledge questions and 20 meeting-note inputs. `tests/inbox.test.ts` has 20 intent-routing inputs, plus automation-threshold and learning tests. These tests exercise deterministic retrieval and workflow behavior in local-demo mode. They do **not** evaluate Claude accuracy, customer satisfaction, end-to-end latency, or real email delivery. Run with `npm test` and `npm run test:python`; keep test pass rates separate from model-quality claims.

There are no genuine model-comparison results yet. The Claude provider is optional and was not benchmarked against another model. Quality %, cost per task, and model latency are therefore **not measured**. Do not treat one passing synthetic fixture suite as a score on unseen customer data. A real model comparison should record provider/model ID, prompt and fixture version, measured wall-clock latency, provider-reported token usage and price, citation support, factuality, escalation correctness, and human edits. Compare on the same data before changing `ANTHROPIC_MODEL`.

## Task 1 — Knowledge Brain

`tests/test_api.py::test_knowledge_brain_retrieves_relevant_article` contains 20 retrieval checks. The cases cover the named demo article areas and paraphrases: membership plans and levels (1–4); payment and billing details (5–8); subscription cancellation (9–10); website branding (11–12); domains and DNS (13–14); CSV imports and field mapping (15–16); renewal reminders and notifications (17–18); and listing categories (19–20).

Additional assertions cover honest low-confidence escalation, persistence of expert answers in the search index, image-field availability, article demo labeling, sitemap URL safety, service health, input validation, and broken task references. The HTTP sync loop's incremental and removal behavior still needs an integration test against a controlled local public test server; it is not part of the 20 retrieval cases. Screenshot understanding must be evaluated with real annotated screenshots and Claude enabled. The current fixture library is synthetic starter content.

## Task 2 — Inbox Agent

`tests/inbox.test.ts` contains 20 intent cases: how-to (1–4), billing (5–8), cancellation (9–10), bugs (11–12), sales (13–14), feature requests (15–16), complaints (17–18), and follow-ups (19–20). Additional checks cover the 20 unchanged-send gate, immediate revocation after an edit, independent intent streaks, normalization, confidence gating, and sensitive intent blocks.

The 50 customer-email fixtures in `services/inbox/seed.ts` are scenario coverage, not an unseen holdout. The current test measures rule-based intent routing, not quality of Claude-written replies. Before enabling auto-send in production, collect at least 20 appropriately representative human-reviewed replies per low-risk intent, inspect edits and complaints, and make a reversible kill switch and real send provider. Measure draft factuality against Knowledge Brain sources and ensure unresolved questions are escalated.

## Task 3 — Meeting to Scope

`tests/test_api.py::test_scope_workflow_returns_reviewable_structured_draft` contains 20 notes covering directory categories, site redesign, search, domains, CSV, memberships, billing, roles, integrations, accessibility, launch planning, and estimates. Additional workflow assertions cover long-transcript chunking, follow-up changes, approval and requested changes, missing previous scopes, and cited configuration suggestions.

The evaluation checks schema, persistence, and human gates. It does not assert that hour estimates match a developer's estimate, that a proposal is commercially appropriate, or that a model never misses a requirement. For a meaningful comparison, have at least two consultants independently label deliverables, questions, configuration opportunities, out-of-scope items, and hours for the same recorded meetings; report agreement and absolute estimate error. No recorded user interviews or model comparison results are included.

## Reproducibility

Use `npm test`, `npm run test:python`, and `npm run build` from the repository root. Functional tests run without an API key and reset their temporary data stores. If adding production evals, store raw transcripts and customer messages only with the business owner's permission and a documented retention policy.
