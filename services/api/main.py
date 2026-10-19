from __future__ import annotations

import asyncio
import base64
import ipaddress
import json
import logging
import os
import re
import socket
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env")
DB_PATH = Path(os.getenv("DATABASE_PATH", str(ROOT / "data" / "consultant.db")))
MODEL = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-20250514")
MAX_PAGE_BYTES = 2_000_000
SYNC_INTERVAL_SECONDS = int(os.getenv("SYNC_INTERVAL_SECONDS", "86400"))
CRAWL_DELAY_SECONDS = max(0.0, float(os.getenv("CRAWL_DELAY_SECONDS", "0.15")))
LOGGER = logging.getLogger("fieldnote.knowledge")

SEED_ARTICLES = [
    {
        "title": "Change your membership plan",
        "category": "Billing & plans",
        "url": "https://support.brilliantdirectories.com/support/solutions/articles/120000000001-change-your-membership-plan",
        "content": "Account owners can review membership levels and recurring plan details in the admin dashboard under Finance, then Membership Levels. Edit a plan to change its name, price, billing frequency, or included features. Changes to an existing paid plan may affect future renewals; review the confirmation screen before saving. To assign a different level to one member, open that member's profile and update their membership level. This example article is starter demo content; sync your own help center before using answers with customers.",
        "images": [],
    },
    {
        "title": "Update a member's billing information",
        "category": "Billing & plans",
        "url": "https://support.brilliantdirectories.com/support/solutions/articles/120000000002-update-billing-information",
        "content": "A member can update their payment method through the member dashboard billing section. An administrator can locate the member in Members, open their profile and review subscription and invoice details. Never ask a customer to send full card numbers or security codes by email. Payment processor availability and the customer portal depend on how the site has been configured. This example article is starter demo content; sync your own help center before using answers with customers.",
        "images": [],
    },
    {
        "title": "Cancel a membership",
        "category": "Billing & plans",
        "url": "https://support.brilliantdirectories.com/support/solutions/articles/120000000003-cancel-a-membership",
        "content": "An administrator can manage a member's subscription from the member profile. Check the subscription status, renewal date, and cancellation terms before making a change. Cancellation timing and access after cancellation depend on the subscription and the business's policy. Confirm the request with the account owner and explain what happens to existing access. This example article is starter demo content; sync your own help center before using answers with customers.",
        "images": [],
    },
    {
        "title": "Customize your website colors and branding",
        "category": "Design & website",
        "url": "https://support.brilliantdirectories.com/support/solutions/articles/120000000004-customize-website-branding",
        "content": "Brand colors, fonts, logo, and common visual settings are managed in the website admin design or theme settings. Preview changes on desktop and mobile before publishing. Site templates may offer different theme controls, and changes to advanced templates can require a developer. Keep a copy of the current logo and theme colors so they can be restored if needed. This example article is starter demo content; sync your own help center before using answers with customers.",
        "images": [],
    },
    {
        "title": "Connect a custom domain",
        "category": "Domains & setup",
        "url": "https://support.brilliantdirectories.com/support/solutions/articles/120000000005-connect-custom-domain",
        "content": "Add the domain in website settings, then update its DNS records with the domain registrar. DNS changes can take up to 48 hours to propagate. Keep existing DNS records until you have confirmed the new domain works. The specific A, CNAME, and verification records depend on the hosting configuration; copy the exact values shown in the admin panel rather than guessing. This example article is starter demo content; sync your own help center before using answers with customers.",
        "images": [],
    },
    {
        "title": "Import members from a CSV file",
        "category": "Members & directory",
        "url": "https://support.brilliantdirectories.com/support/solutions/articles/120000000006-import-members-csv",
        "content": "Prepare a CSV with a header row and columns matching the fields in your directory. Export a backup before the import. In the admin area open Members and choose the import option, map each CSV column to a member field, and review the preview and validation errors before confirming. Do not import passwords or unnecessary sensitive data. Start with a small test file if you are unsure about field mappings. This example article is starter demo content; sync your own help center before using answers with customers.",
        "images": [],
    },
    {
        "title": "Set up automatic renewal reminders",
        "category": "Billing & plans",
        "url": "https://support.brilliantdirectories.com/support/solutions/articles/120000000007-automatic-renewal-reminders",
        "content": "Review subscription notification settings in the admin email or billing configuration. Check that renewal reminders are enabled, the sender address is verified, and the reminder schedule matches your policy. Send a test notification before relying on the workflow. Exact options vary with the payment provider and installed plan. This example article is starter demo content; sync your own help center before using answers with customers.",
        "images": [],
    },
    {
        "title": "Add a new listing category",
        "category": "Members & directory",
        "url": "https://support.brilliantdirectories.com/support/solutions/articles/120000000008-add-listing-category",
        "content": "Listing categories are configurable from the directory or content settings in the admin dashboard. Create a category with a clear label, select its parent category if applicable, and choose whether members can select it on their profile. Review category visibility and any custom fields before publishing. This example article is starter demo content; sync your own help center before using answers with customers.",
        "images": [],
    },
]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    return connection


def initialize_db() -> None:
    with connect() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS articles (
                url TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                category TEXT NOT NULL DEFAULT 'Help center',
                content TEXT NOT NULL,
                images TEXT NOT NULL DEFAULT '[]',
                content_hash TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                demo INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS questions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                question TEXT NOT NULL,
                answer TEXT NOT NULL,
                confidence REAL NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS human_tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                question_id INTEGER,
                question TEXT NOT NULL,
                answer TEXT,
                status TEXT NOT NULL DEFAULT 'open',
                created_at TEXT NOT NULL,
                answered_at TEXT
            );
            CREATE TABLE IF NOT EXISTS sync_state (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS scopes (
                id TEXT PRIMARY KEY,
                client TEXT NOT NULL,
                title TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending_review',
                data TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS scope_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                scope_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                detail TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            """
        )
        count = db.execute("SELECT COUNT(*) FROM articles").fetchone()[0]
        if not count:
            for article in SEED_ARTICLES:
                content_hash = _hash_content(article["content"])
                db.execute(
                    """INSERT OR IGNORE INTO articles
                    (url,title,category,content,images,content_hash,updated_at,demo)
                    VALUES (?,?,?,?,?,?,?,1)""",
                    (
                        article["url"],
                        article["title"],
                        article["category"],
                        article["content"],
                        json.dumps(article["images"]),
                        content_hash,
                        now_iso(),
                    ),
                )
        db.execute(
            "INSERT OR IGNORE INTO sync_state (key,value) VALUES ('source_url','')"
        )
        db.execute(
            "INSERT OR IGNORE INTO sync_state (key,value) VALUES ('last_sync','')"
        )
        db.execute(
            "INSERT OR IGNORE INTO sync_state (key,value) VALUES ('last_sync_error','')"
        )


def _hash_content(content: str) -> str:
    import hashlib

    return hashlib.sha256(content.encode("utf-8")).hexdigest()


@asynccontextmanager
async def lifespan(_: FastAPI):
    initialize_db()
    scheduler = asyncio.create_task(_daily_sync())
    try:
        yield
    finally:
        scheduler.cancel()
        try:
            await scheduler
        except asyncio.CancelledError:
            pass


app = FastAPI(title="Fieldnote Consultant API", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class AskRequest(BaseModel):
    question: str = Field(min_length=3, max_length=4000)


class SyncRequest(BaseModel):
    sitemap_url: str = Field(min_length=8, max_length=2000)


class HumanAnswer(BaseModel):
    answer: str = Field(min_length=3, max_length=12000)


class ScopeRequest(BaseModel):
    transcript: str = Field(min_length=20, max_length=200000)
    client: str = Field(default="New client", max_length=120)
    previous_scope_id: str | None = None


class ScopeApproval(BaseModel):
    approved: bool
    note: str = Field(default="", max_length=2000)


def _tokens(text: str) -> set[str]:
    return {
        word
        for word in re.findall(r"[a-z0-9]{2,}", text.lower())
        if word not in {"the", "and", "for", "are", "how", "can", "what", "with", "this", "that", "your", "you", "from"}
    }


async def _daily_sync() -> None:
    while True:
        await asyncio.sleep(SYNC_INTERVAL_SECONDS)
        with connect() as db:
            row = db.execute("SELECT value FROM sync_state WHERE key='source_url'").fetchone()
        source_url = row["value"] if row else ""
        if not source_url:
            continue
        try:
            result = await asyncio.to_thread(sync_knowledge, SyncRequest(sitemap_url=source_url))
            LOGGER.info("Scheduled help-center sync completed: %s", result)
        except Exception as exc:
            LOGGER.exception("Scheduled help-center sync failed")
            with connect() as db:
                db.execute(
                    "INSERT INTO sync_state(key,value) VALUES('last_sync_error',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    (str(exc)[:1000],),
                )


def retrieve_articles(question: str, limit: int = 4) -> list[dict[str, Any]]:
    query_tokens = _tokens(question)
    if not query_tokens:
        return []
    with connect() as db:
        rows = db.execute("SELECT * FROM articles").fetchall()
    scored: list[tuple[float, sqlite3.Row]] = []
    for row in rows:
        article_tokens = _tokens(f"{row['title']} {row['category']} {row['content']}")
        overlap = len(query_tokens & article_tokens)
        if overlap:
            score = overlap / (len(query_tokens) ** 0.5 * max(len(article_tokens) ** 0.5, 1))
            scored.append((score, row))
    scored.sort(key=lambda item: (item[0], item[1]["updated_at"]), reverse=True)
    return [
        {
            "title": row["title"],
            "category": row["category"],
            "url": row["url"],
            "excerpt": row["content"][:220],
            "images": json.loads(row["images"]),
            "relevance": round(score, 3),
            "demo": bool(row["demo"]),
        }
        for score, row in scored[:limit]
        if score >= 0.035
    ]


def _anthropic(prompt: str, max_tokens: int = 700, image: dict[str, str] | None = None) -> str | None:
    api_key = os.getenv("ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        return None
    request = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps(
            {
                "model": os.getenv("ANTHROPIC_MODEL", MODEL),
                "max_tokens": max_tokens,
                "messages": [
                    {
                        "role": "user",
                        "content": (
                            [
                                {
                                    "type": "image",
                                    "source": {
                                        "type": "base64",
                                        "media_type": image["media_type"],
                                        "data": image["data"],
                                    },
                                },
                                {"type": "text", "text": prompt},
                            ]
                            if image
                            else prompt
                        ),
                    }
                ],
            }
        ).encode(),
        headers={
            "content-type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=35) as response:
            payload = json.loads(response.read().decode())
        return "".join(
            block.get("text", "")
            for block in payload.get("content", [])
            if block.get("type") == "text"
        ).strip()
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=502, detail=f"Claude request failed: {exc}") from exc


def answer_question(question: str) -> dict[str, Any]:
    sources = retrieve_articles(question)
    confidence = sources[0]["relevance"] if sources else 0
    if not sources or confidence < 0.055:
        answer = "I don't have enough verified information to answer that confidently. I've sent this question to a human expert for review."
        confidence = min(confidence, 0.25)
        needs_human = True
    else:
        context = "\n\n".join(
            f"Source: {source['title']}\nURL: {source['url']}\n{source['excerpt']}"
            for source in sources
        )
        generated = _anthropic(
            "Answer the customer using only the supplied help-center excerpts. "
            "If a detail is missing, say it is not documented. Be concise and practical. "
            "Do not invent policies, prices, or settings.\n\n"
            f"Customer question: {question}\n\nHelp-center excerpts:\n{context}"
        )
        answer = generated or (
            f"Based on **{sources[0]['title']}**: {sources[0]['excerpt']} "
            "For details specific to your account, check with your administrator."
        )
        needs_human = False
    with connect() as db:
        cursor = db.execute(
            "INSERT INTO questions (question,answer,confidence,created_at) VALUES (?,?,?,?)",
            (question, answer, round(confidence, 4), now_iso()),
        )
        question_id = cursor.lastrowid
        if needs_human:
            db.execute(
                "INSERT INTO human_tasks (question_id,question,created_at) VALUES (?,?,?)",
                (question_id, question, now_iso()),
            )
    return {
        "answer": answer,
        "sources": sources,
        "confidence": round(confidence, 3),
        "needs_human": needs_human,
        "question_id": question_id,
        "mode": "claude" if os.getenv("ANTHROPIC_API_KEY") else "local demo",
    }


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "knowledge-brain", "time": now_iso()}


@app.get("/api/overview")
def overview() -> dict[str, Any]:
    with connect() as db:
        counts = {
            "articles": db.execute("SELECT COUNT(*) FROM articles").fetchone()[0],
            "questions": db.execute("SELECT COUNT(*) FROM questions").fetchone()[0],
            "open_tasks": db.execute("SELECT COUNT(*) FROM human_tasks WHERE status='open'").fetchone()[0],
            "scopes": db.execute("SELECT COUNT(*) FROM scopes").fetchone()[0],
            "pending_approvals": db.execute("SELECT COUNT(*) FROM scopes WHERE status='pending_review'").fetchone()[0],
        }
        last_sync = db.execute("SELECT value FROM sync_state WHERE key='last_sync'").fetchone()[0]
        sync_error = db.execute("SELECT value FROM sync_state WHERE key='last_sync_error'").fetchone()[0]
        source_url = db.execute("SELECT value FROM sync_state WHERE key='source_url'").fetchone()[0]
        recent = db.execute(
            "SELECT id,question,confidence,created_at FROM questions ORDER BY id DESC LIMIT 5"
        ).fetchall()
    return {
        **counts,
        "last_sync": last_sync or None,
        "last_sync_error": sync_error or None,
        "source_url": source_url or None,
        "ai_mode": "Claude" if os.getenv("ANTHROPIC_API_KEY") else "Local demo",
        "recent_questions": [dict(row) for row in recent],
    }


@app.get("/api/knowledge/articles")
def list_articles(q: str = Query(default="", max_length=250)) -> dict[str, Any]:
    with connect() as db:
        if q.strip():
            pattern = f"%{q.strip()}%"
            rows = db.execute(
                """SELECT url,title,category,content,images,updated_at,demo
                FROM articles WHERE title LIKE ? OR category LIKE ? OR content LIKE ?
                ORDER BY title LIMIT 100""",
                (pattern, pattern, pattern),
            ).fetchall()
        else:
            rows = db.execute(
                "SELECT url,title,category,content,images,updated_at,demo FROM articles ORDER BY title LIMIT 100"
            ).fetchall()
    return {
        "articles": [
            {
                **dict(row),
                "excerpt": row["content"][:220],
                "images": json.loads(row["images"]),
                "demo": bool(row["demo"]),
            }
            for row in rows
        ]
    }


@app.post("/api/knowledge/ask")
def ask_knowledge(request: AskRequest) -> dict[str, Any]:
    return answer_question(request.question.strip())


@app.get("/api/knowledge/tasks")
def list_human_tasks() -> dict[str, Any]:
    with connect() as db:
        rows = db.execute(
            "SELECT * FROM human_tasks ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, id DESC LIMIT 100"
        ).fetchall()
    return {"tasks": [dict(row) for row in rows]}


@app.post("/api/knowledge/tasks/{task_id}/answer")
def answer_human_task(task_id: int, request: HumanAnswer) -> dict[str, Any]:
    with connect() as db:
        task = db.execute(
            "SELECT * FROM human_tasks WHERE id=?", (task_id,)
        ).fetchone()
        if task is None:
            raise HTTPException(status_code=404, detail="Human task not found")
        db.execute(
            "UPDATE human_tasks SET answer=?,status='answered',answered_at=? WHERE id=?",
            (request.answer.strip(), now_iso(), task_id),
        )
        url = f"internal://expert-answer/{task_id}"
        content = f"Question: {task['question']}\nExpert answer: {request.answer.strip()}"
        db.execute(
            """INSERT INTO articles(url,title,category,content,images,content_hash,updated_at,demo)
            VALUES(?,?,?,?,?,?,?,0)
            ON CONFLICT(url) DO UPDATE SET content=excluded.content,content_hash=excluded.content_hash,updated_at=excluded.updated_at""",
            (
                url,
                f"Expert answer: {task['question'][:100]}",
                "Expert answers",
                content,
                "[]",
                _hash_content(content),
                now_iso(),
            ),
        )
    return {"status": "answered", "task_id": task_id, "added_to_knowledge": True}


def _public_url(url: str) -> urllib.parse.ParseResult:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise HTTPException(status_code=400, detail="Only public HTTP or HTTPS URLs are supported")
    try:
        addresses = socket.getaddrinfo(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80))
    except OSError as exc:
        raise HTTPException(status_code=400, detail=f"Could not resolve the supplied URL: {exc}") from exc
    for address in addresses:
        ip = ipaddress.ip_address(address[4][0])
        if not ip.is_global:
            raise HTTPException(status_code=400, detail="Private and local network URLs cannot be crawled")
    return parsed


def _fetch(url: str) -> bytes:
    _public_url(url)
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "FieldnoteKnowledgeBot/1.0 (+help-center indexing)"},
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            body = response.read(MAX_PAGE_BYTES + 1)
        if len(body) > MAX_PAGE_BYTES:
            raise HTTPException(status_code=413, detail="Page is larger than the 2 MB crawl limit")
        return body
    except urllib.error.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Help center returned HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise HTTPException(status_code=502, detail=f"Could not fetch the help center: {exc}") from exc


def _fetch_image(url: str) -> dict[str, str] | None:
    _public_url(url)
    request = urllib.request.Request(url, headers={"User-Agent": "FieldnoteKnowledgeBot/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            media_type = response.headers.get_content_type()
            if media_type not in {"image/jpeg", "image/png", "image/gif", "image/webp"}:
                return None
            data = response.read(1_000_001)
        if len(data) > 1_000_000:
            return None
        return {"media_type": media_type, "data": base64.b64encode(data).decode("ascii")}
    except (HTTPException, urllib.error.URLError, TimeoutError):
        return None


class PageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.title_parts: list[str] = []
        self.text_parts: list[str] = []
        self.images: list[dict[str, str]] = []
        self._in_title = False
        self._ignored = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if tag == "title":
            self._in_title = True
        if tag in {"script", "style", "noscript", "svg"}:
            self._ignored += 1
        if tag == "img" and attributes.get("src"):
            self.images.append(
                {
                    "src": urllib.parse.urljoin("", attributes["src"] or ""),
                    "alt": attributes.get("alt") or "",
                }
            )

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False
        if tag in {"script", "style", "noscript", "svg"} and self._ignored:
            self._ignored -= 1

    def handle_data(self, data: str) -> None:
        cleaned = " ".join(data.split())
        if not cleaned:
            return
        if self._in_title:
            self.title_parts.append(cleaned)
        elif not self._ignored:
            self.text_parts.append(cleaned)


def _sitemap_urls(url: str) -> list[str]:
    root = ET.fromstring(_fetch(url))
    namespace = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}
    locs = [node.text.strip() for node in root.findall(".//sm:loc", namespace) if node.text]
    if root.tag.endswith("sitemapindex"):
        discovered: list[str] = []
        for child in locs[:10]:
            child_root = ET.fromstring(_fetch(child))
            discovered.extend(
                node.text.strip()
                for node in child_root.findall(".//sm:loc", namespace)
                if node.text
            )
            if len(discovered) >= 500:
                break
        locs = discovered
    return list(dict.fromkeys(locs))[:500]


def _article_from_page(url: str) -> dict[str, Any]:
    parser = PageParser()
    parser.feed(_fetch(url).decode("utf-8", errors="replace"))
    title = " ".join(parser.title_parts).strip() or urllib.parse.urlparse(url).path.rstrip("/").split("/")[-1].replace("-", " ").title()
    category = "Help center"
    path_parts = [part for part in urllib.parse.urlparse(url).path.split("/") if part]
    if len(path_parts) > 1:
        category = path_parts[-2].replace("-", " ").title()
    images: list[dict[str, str]] = []
    descriptions: list[str] = []
    for image in parser.images[:40]:
        image_url = urllib.parse.urljoin(url, image["src"])
        alt = image["alt"].strip()
        description = alt
        if not description and os.getenv("ANTHROPIC_API_KEY"):
            payload = _fetch_image(image_url)
            if payload:
                description = _anthropic(
                    "Describe the useful product instructions, labels, controls, or steps visible in this help-center screenshot. "
                    "If it is decorative or unreadable, say so. Be precise and do not infer information that is not visible.",
                    max_tokens=180,
                    image=payload,
                ) or ""
        images.append(
            {"src": image_url, "alt": alt, "description": description or "Image is attached to this help-center article."}
        )
        if description:
            descriptions.append(f"Screenshot description: {description}")
    content = " ".join(parser.text_parts + descriptions)
    return {
        "url": url,
        "title": title[:300],
        "category": category[:100],
        "content": content[:50000],
        "images": images,
    }


@app.post("/api/knowledge/sync")
def sync_knowledge(request: SyncRequest) -> dict[str, Any]:
    sitemap_url = request.sitemap_url.strip()
    _public_url(sitemap_url)
    try:
        urls = _sitemap_urls(sitemap_url)
    except ET.ParseError as exc:
        raise HTTPException(status_code=422, detail="The URL did not return a valid XML sitemap") from exc
    if not urls:
        raise HTTPException(status_code=422, detail="The sitemap did not contain any page URLs")
    added = updated = unchanged = failed = 0
    seen: set[str] = set()
    with connect() as db:
        for url in urls:
            if url in seen:
                continue
            if seen and CRAWL_DELAY_SECONDS:
                time.sleep(CRAWL_DELAY_SECONDS)
            seen.add(url)
            try:
                page = _article_from_page(url)
            except (HTTPException, UnicodeError, ValueError):
                failed += 1
                continue
            digest = _hash_content(page["content"] + json.dumps(page["images"], sort_keys=True))
            old = db.execute("SELECT content_hash FROM articles WHERE url=?", (url,)).fetchone()
            if old and old["content_hash"] == digest:
                unchanged += 1
                continue
            db.execute(
                """INSERT INTO articles(url,title,category,content,images,content_hash,updated_at,demo)
                VALUES(?,?,?,?,?,?,?,0)
                ON CONFLICT(url) DO UPDATE SET title=excluded.title,category=excluded.category,
                content=excluded.content,images=excluded.images,content_hash=excluded.content_hash,
                updated_at=excluded.updated_at,demo=0""",
                (url, page["title"], page["category"], page["content"], json.dumps(page["images"]), digest, now_iso()),
            )
            if old:
                updated += 1
            else:
                added += 1
        removed = 0
        if not failed:
            current = db.execute("SELECT url FROM articles WHERE demo=0").fetchall()
            for row in current:
                if row["url"] not in seen and not row["url"].startswith("internal://"):
                    db.execute("DELETE FROM articles WHERE url=?", (row["url"],))
                    removed += 1
        db.execute(
            "INSERT INTO sync_state(key,value) VALUES('source_url',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (sitemap_url,),
        )
        synced = now_iso()
        db.execute(
            "INSERT INTO sync_state(key,value) VALUES('last_sync',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (synced,),
        )
        sync_error = (
            f"{failed} article(s) could not be fetched; removed articles were retained until a full successful sync."
            if failed
            else ""
        )
        db.execute(
            "INSERT INTO sync_state(key,value) VALUES('last_sync_error',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (sync_error,),
        )
    return {
        "status": "partial" if failed else "completed",
        "sitemap_url": sitemap_url,
        "pages_seen": len(seen),
        "added": added,
        "updated": updated,
        "unchanged": unchanged,
        "removed": removed,
        "failed": failed,
        "warning": sync_error or None,
        "last_sync": synced,
    }


def _split_transcript(transcript: str, max_chars: int = 9000) -> list[str]:
    paragraphs = re.split(r"\n\s*\n", transcript.strip())
    chunks: list[str] = []
    current = ""
    for paragraph in paragraphs:
        if len(current) + len(paragraph) + 2 > max_chars and current:
            chunks.append(current)
            current = ""
        while len(paragraph) > max_chars:
            if current:
                chunks.append(current)
                current = ""
            chunks.append(paragraph[:max_chars])
            paragraph = paragraph[max_chars:]
        current = f"{current}\n\n{paragraph}".strip()
    if current:
        chunks.append(current)
    return chunks


def _derive_scope(transcript: str, client: str, previous: dict[str, Any] | None) -> dict[str, Any]:
    chunk_summaries: list[str] = []
    for chunk in _split_transcript(transcript):
        summary = _anthropic(
            "Extract only explicit requirements, constraints, open questions, and changes from this meeting excerpt. "
            "Return concise bullet points. Do not invent requirements.\n\n" + chunk,
            max_tokens=500,
        )
        chunk_summaries.append(summary or chunk)
    digest = "\n\n".join(chunk_summaries)
    sources = retrieve_articles(digest, limit=6)
    system_config = [
        "plan, setting, membership, directory, search, domain, billing, CSV",
    ]
    matching = [
        source
        for source in sources
        if source["relevance"] >= 0.08
        and any(word in (source["title"] + source["excerpt"]).lower() for word in system_config[0].split(", "))
    ]
    if os.getenv("ANTHROPIC_API_KEY"):
        output = _anthropic(
            "Act as a senior software consultant. Produce one valid JSON object and no markdown. "
            "Schema: {\"title\":string,\"summary\":string,\"requirements\":[{\"title\":string,"
            "\"description\":string,\"hours\":number,\"type\":\"configuration\"|\"custom development\"|\"discovery\","
            "\"included\":boolean}],\"questions\":[string],\"risks\":[string],\"proposal\":string}. "
            "Use only explicit needs. Use the provided knowledge articles to identify configuration before custom code. "
            "Hours are rough engineering estimates, not commitments. Mark ambiguous work as discovery and list questions.\n\n"
            f"Client: {client}\nMeeting notes:\n{digest}\n\n"
            f"Knowledge Brain articles:\n{json.dumps(matching)}",
            max_tokens=1800,
        )
        try:
            result = json.loads(output or "")
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=502, detail="Claude returned invalid scope JSON; please retry") from exc
    else:
        sentences = [
            sentence.strip()
            for sentence in re.split(r"(?<=[.!?])\s+|\n+", digest)
            if len(sentence.strip()) > 24
        ]
        relevant = [
            sentence
            for sentence in sentences
            if any(
                keyword in sentence.lower()
                for keyword in ("need", "want", "should", "must", "add", "change", "build", "create", "improve", "allow", "integrate", "update")
            )
        ]
        candidates = (relevant or sentences)[:8]
        requirements = []
        for sentence in candidates:
            is_configuration = any(word in sentence.lower() for word in ("setting", "plan", "membership", "domain", "billing", "category"))
            requirements.append(
                {
                    "title": sentence[:90],
                    "description": sentence,
                    "hours": 1 if is_configuration else 4,
                    "type": "configuration" if is_configuration else "discovery",
                    "included": True,
                }
            )
        result = {
            "title": f"{client} — project scope",
            "summary": f"Draft scope based on {len(_split_transcript(transcript))} meeting transcript section(s). Review the extracted requirements before sharing.",
            "requirements": requirements,
            "questions": ["Confirm priorities, acceptance criteria, and the required launch date."],
            "risks": ["Estimates are preliminary and require developer review."],
            "proposal": f"Thank you for the conversation. This draft proposal outlines a preliminary discovery-first approach for {client}. Final pricing and delivery dates require human review.",
        }
    if not isinstance(result, dict) or not isinstance(result.get("requirements"), list):
        raise HTTPException(status_code=502, detail="Scope generation returned an unexpected format")
    result.setdefault("title", f"{client} — project scope")
    result.setdefault("summary", "")
    result.setdefault("questions", [])
    result.setdefault("risks", [])
    result.setdefault("proposal", "")
    for item in result["requirements"]:
        item.setdefault("included", True)
        item.setdefault("hours", 0)
        item.setdefault("type", "discovery")
    result["knowledge_suggestions"] = matching
    result["transcript_chunks"] = len(_split_transcript(transcript))
    result["status"] = "pending_review"
    if previous:
        old_items = {
            item.get("title", "").lower(): item
            for item in previous.get("requirements", [])
        }
        new_items = {item.get("title", "").lower(): item for item in result["requirements"]}
        result["changes"] = {
            "added": [item for key, item in new_items.items() if key not in old_items],
            "removed": [item for key, item in old_items.items() if key not in new_items],
            "outside_scope": [item for item in result["requirements"] if not item.get("included", True)],
        }
        result["summary"] = f"Follow-up draft: {len(result['changes']['added'])} new and {len(result['changes']['removed'])} removed requirements. Human review is required."
    return result


@app.get("/api/scopes")
def list_scopes() -> dict[str, Any]:
    with connect() as db:
        rows = db.execute("SELECT * FROM scopes ORDER BY created_at DESC LIMIT 50").fetchall()
    return {"scopes": [{**dict(row), "data": json.loads(row["data"])} for row in rows]}


@app.post("/api/scopes/analyze")
def analyze_scope(request: ScopeRequest) -> dict[str, Any]:
    previous = None
    if request.previous_scope_id:
        with connect() as db:
            row = db.execute("SELECT * FROM scopes WHERE id=?", (request.previous_scope_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Previous scope not found")
        previous = json.loads(row["data"])
    result = _derive_scope(request.transcript, request.client.strip() or "New client", previous)
    result["client"] = request.client.strip() or "New client"
    result["created_at"] = now_iso()
    result["total_hours"] = round(
        sum(float(item.get("hours", 0)) for item in result["requirements"]), 1
    )
    import uuid

    scope_id = str(uuid.uuid4())
    result["id"] = scope_id
    with connect() as db:
        db.execute(
            "INSERT INTO scopes(id,client,title,status,data,created_at) VALUES(?,?,?,?,?,?)",
            (scope_id, result["client"], result["title"], "pending_review", json.dumps(result), result["created_at"]),
        )
        db.execute(
            "INSERT INTO scope_events(scope_id,kind,detail,created_at) VALUES(?,?,?,?)",
            (scope_id, "draft_created", f"Draft created from {result['transcript_chunks']} transcript section(s)", result["created_at"]),
        )
    return result


@app.post("/api/scopes/{scope_id}/approval")
def approve_scope(scope_id: str, request: ScopeApproval) -> dict[str, Any]:
    with connect() as db:
        row = db.execute("SELECT * FROM scopes WHERE id=?", (scope_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Scope not found")
        result = json.loads(row["data"])
        status = "approved" if request.approved else "changes_requested"
        result["status"] = status
        result["review_note"] = request.note.strip()
        result["reviewed_at"] = now_iso()
        db.execute("UPDATE scopes SET status=?,data=? WHERE id=?", (status, json.dumps(result), scope_id))
        db.execute(
            "INSERT INTO scope_events(scope_id,kind,detail,created_at) VALUES(?,?,?,?)",
            (scope_id, status, request.note.strip() or status.replace("_", " ").title(), now_iso()),
        )
    return {"id": scope_id, "status": status, "review_note": request.note.strip()}


@app.get("/api/activity")
def activity() -> dict[str, Any]:
    with connect() as db:
        questions = db.execute(
            "SELECT id,question AS label,confidence,created_at,'knowledge' AS kind FROM questions ORDER BY id DESC LIMIT 8"
        ).fetchall()
        scope_events = db.execute(
            "SELECT e.id,e.detail AS label,e.created_at,e.kind FROM scope_events e ORDER BY e.id DESC LIMIT 8"
        ).fetchall()
    events = [dict(row) for row in questions] + [dict(row) for row in scope_events]
    events.sort(key=lambda row: row["created_at"], reverse=True)
    return {"events": events[:12]}
