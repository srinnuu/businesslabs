from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient

from services.api import main

KNOWLEDGE_EVALS = [
    ("How can I change a membership plan?", "membership plan"),
    ("Where can I rename my membership level?", "membership plan"),
    ("How do I update benefits on a paid plan?", "membership plan"),
    ("Can an admin change a member's level?", "membership plan"),
    ("Where can a member update their billing information?", "billing information"),
    ("A customer needs to update a payment method. How?", "billing information"),
    ("How do I find the subscription and invoice details?", "billing information"),
    ("Where does a member change their card?", "billing information"),
    ("How do I cancel a membership?", "cancel a membership"),
    ("What should I check before I cancel someone's subscription?", "cancel a membership"),
    ("How do I customize website colors and branding?", "website colors"),
    ("Where can I change my logo and theme?", "website colors"),
    ("How do I connect a custom domain?", "custom domain"),
    ("Which DNS records do I need for my custom domain?", "custom domain"),
    ("How can I import members from a CSV file?", "import members"),
    ("How do I map CSV columns for an import?", "import members"),
    ("Where do I set automatic renewal reminders?", "automatic renewal"),
    ("How can I enable subscription renewal notifications?", "automatic renewal"),
    ("Where can I add a new listing category?", "listing category"),
    ("How do I create a parent category for new directory listings?", "listing category"),
]

SCOPE_EVALS = [
    "The client wants a new listing category for independent studios and asks for a developer estimate.",
    "The client needs new website brand colors and asks for a draft implementation scope.",
    "We want to improve member search and add a filter for professional certifications.",
    "The client would like to connect their custom domain before the planned launch.",
    "The meeting covered an import of current member details from a clean CSV export.",
    "The customer asked us to change membership plans and review their renewal schedule.",
    "They need the provider directory to have separate categories for each city.",
    "Please build a clearer homepage and let staff update membership information.",
    "The client wants us to configure renewal reminders for their annual plan.",
    "We need to add a configurable field to capture each provider's certifications.",
    "They requested a custom analytics dashboard and an export for the board.",
    "The customer would like to improve the mobile layout and simplify registration.",
    "We need to transfer a directory domain and preserve all existing member profiles.",
    "The owner requests two staff roles with different administrative permissions.",
    "A new feature should allow members to edit their own public business listing.",
    "The client wants payment processing and a recurring membership plan configured.",
    "We should investigate slow search before proposing a custom search redesign.",
    "The association asks for an integration that synchronizes members from their CRM.",
    "They would like the website logo updated and a category page improved.",
    "The team wants a launch plan, an estimate, and a clear list of assumptions.",
]


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DB_PATH", tmp_path / "fieldnote-test.db")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with TestClient(main.app) as test_client:
        yield test_client


@pytest.mark.parametrize(("question", "expected"), KNOWLEDGE_EVALS)
def test_knowledge_brain_retrieves_relevant_article(client, question, expected):
    response = client.post("/api/knowledge/ask", json={"question": question})
    assert response.status_code == 200
    answer = response.json()
    assert answer["sources"]
    assert expected in " ".join(source["title"].lower() for source in answer["sources"])
    assert answer["needs_human"] is False


@pytest.mark.parametrize("transcript", SCOPE_EVALS)
def test_scope_workflow_returns_reviewable_structured_draft(client, transcript):
    response = client.post(
        "/api/scopes/analyze",
        json={"transcript": f"Client meeting notes. {transcript}", "client": "Eval Studio"},
    )
    assert response.status_code == 200
    scope = response.json()
    assert scope["status"] == "pending_review"
    assert scope["client"] == "Eval Studio"
    assert isinstance(scope["requirements"], list)
    assert isinstance(scope["questions"], list)
    assert isinstance(scope["proposal"], str)
    assert scope["transcript_chunks"] == 1


def test_unknown_question_creates_human_task(client):
    response = client.post(
        "/api/knowledge/ask",
        json={"question": "Which undocumented private discount did the CEO promise to our account?"},
    )
    assert response.status_code == 200
    assert response.json()["needs_human"] is True
    tasks = client.get("/api/knowledge/tasks").json()["tasks"]
    assert len(tasks) == 1
    assert tasks[0]["status"] == "open"


def test_expert_answer_becomes_searchable_knowledge(client):
    asked = client.post(
        "/api/knowledge/ask",
        json={"question": "What is the exact process for a Zorblax customer?"},
    ).json()
    task = client.get("/api/knowledge/tasks").json()["tasks"][0]
    saved = client.post(
        f"/api/knowledge/tasks/{task['id']}/answer",
        json={"answer": "Zorblax administrators submit a verified support ticket."},
    )
    assert saved.status_code == 200
    assert saved.json()["added_to_knowledge"] is True
    learned = client.post(
        "/api/knowledge/ask",
        json={"question": "How do Zorblax administrators get support?"},
    ).json()
    assert any(source["title"].startswith("Expert answer") for source in learned["sources"])


def test_scope_is_private_until_explicit_human_approval(client):
    scope = client.post(
        "/api/scopes/analyze",
        json={"transcript": "Client wants a new member search and clear launch estimate.", "client": "Northstar"},
    ).json()
    assert scope["status"] == "pending_review"
    approval = client.post(
        f"/api/scopes/{scope['id']}/approval",
        json={"approved": True, "note": "Estimate reviewed by engineering."},
    )
    assert approval.status_code == 200
    assert approval.json()["status"] == "approved"
    persisted = client.get("/api/scopes").json()["scopes"][0]
    assert persisted["status"] == "approved"


def test_follow_up_scope_reports_changes_from_original(client):
    original = client.post(
        "/api/scopes/analyze",
        json={"transcript": "Client wants a listing category and a homepage refresh.", "client": "Acme"},
    ).json()
    follow_up = client.post(
        "/api/scopes/analyze",
        json={
            "transcript": "Client now wants an additional custom billing integration.",
            "client": "Acme",
            "previous_scope_id": original["id"],
        },
    )
    assert follow_up.status_code == 200
    assert "changes" in follow_up.json()
    assert isinstance(follow_up.json()["changes"]["added"], list)


def test_long_meeting_transcript_is_chunked(client):
    transcript = "\n\n".join(
        f"Speaker {index}: The client wants to review a different project requirement and discuss a practical launch plan."
        for index in range(120)
    )
    result = client.post(
        "/api/scopes/analyze",
        json={"transcript": transcript, "client": "Long Meeting"},
    )
    assert result.status_code == 200
    assert result.json()["transcript_chunks"] > 1


def test_invalid_or_private_sitemap_url_is_rejected(client):
    response = client.post(
        "/api/knowledge/sync",
        json={"sitemap_url": "http://127.0.0.1:8000/sitemap.xml"},
    )
    assert response.status_code == 400


def test_article_listing_marks_demo_content(client):
    articles = client.get("/api/knowledge/articles").json()["articles"]
    assert len(articles) >= 8
    assert all("content" in article and "images" in article for article in articles)
    assert all(article["demo"] for article in articles)


def test_health_and_overview_expose_service_status(client):
    assert client.get("/api/health").json()["status"] == "ok"
    overview = client.get("/api/overview").json()
    assert overview["articles"] >= 8
    assert "ai_mode" in overview


def test_empty_question_is_rejected(client):
    assert client.post("/api/knowledge/ask", json={"question": ""}).status_code == 422


def test_bad_expert_task_id_is_not_silently_accepted(client):
    result = client.post("/api/knowledge/tasks/9999/answer", json={"answer": "A verified answer."})
    assert result.status_code == 404


def test_scope_changes_can_be_requested(client):
    scope = client.post(
        "/api/scopes/analyze",
        json={"transcript": "Client needs a new member registration page.", "client": "Review Co"},
    ).json()
    result = client.post(
        f"/api/scopes/{scope['id']}/approval",
        json={"approved": False, "note": "Please confirm the launch date first."},
    )
    assert result.json()["status"] == "changes_requested"


def test_missing_previous_scope_is_reported(client):
    result = client.post(
        "/api/scopes/analyze",
        json={
            "transcript": "Client wants a homepage update and member registration.",
            "previous_scope_id": "missing-scope",
        },
    )
    assert result.status_code == 404


def test_source_references_are_http_articles_or_internal_expert_notes(client):
    result = client.post(
        "/api/knowledge/ask",
        json={"question": "Where can I change the membership level and plan price?"},
    ).json()
    assert all(source["url"].startswith(("https://", "http://", "internal://")) for source in result["sources"])

