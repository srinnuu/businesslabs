import "dotenv/config";
import express, { type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  CategorySchema,
  ReplySchema,
  classifyIntent,
  recordHumanSend,
  requestKnowledgeAnswer,
  shouldAutoSend,
  writeDraft,
  type Category,
  type EmailThread,
  type InboxStore,
  type LearningState
} from "./agent.ts";
import { EMAIL_SEEDS } from "./seed.ts";

const PORT = Number(process.env.INBOX_PORT ?? 8001);
const STORE_PATH = resolve(process.cwd(), "data", "inbox.json");
const DEFAULT_LEARNING: LearningState = {
  streaks: {},
  automation: {},
  editedCount: 0,
  unchangedCount: 0,
  sentCount: 0
};

const server = express();
server.use(express.json({ limit: "1mb" }));
const NewEmailSchema = z.object({
  name: z.string().trim().min(1).max(160),
  email: z.string().trim().email().max(254),
  subject: z.string().trim().min(1).max(300),
  body: z.string().trim().min(3).max(20000)
});

function makeThread(
  seed: { name: string; email: string; subject: string; category: Category; body: string },
  id: string,
  createdAt: string
): EmailThread {
  return {
    ...seed,
    id,
    category: classifyIntent(seed.subject, seed.body),
    status: "new",
    draft: "",
    reply: "",
    confidence: 0,
    createdAt,
    sentAt: null,
    wasEdited: false,
    autoSent: false,
    sourceTitles: []
  };
}

function makeSeedThreads(): EmailThread[] {
  return EMAIL_SEEDS.map((seed, index) => makeThread(
    {
      ...seed,
      email: `${seed.name.toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, ".")}@example.com`
    },
    `email-${String(index + 1).padStart(3, "0")}`,
    new Date(Date.now() - index * 47 * 60_000).toISOString()
  ));
}

async function readStore(): Promise<InboxStore> {
  await mkdir(dirname(STORE_PATH), { recursive: true });
  try {
    const contents = await readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(contents) as Partial<InboxStore>;
    return {
      threads: Array.isArray(parsed.threads) ? parsed.threads : makeSeedThreads(),
      learning: { ...DEFAULT_LEARNING, ...(parsed.learning ?? {}) }
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Could not read inbox store at ${STORE_PATH}`, { cause: error });
    }
    const initial = { threads: makeSeedThreads(), learning: { ...DEFAULT_LEARNING } };
    await writeStore(initial);
    return initial;
  }
}

async function writeStore(store: InboxStore): Promise<void> {
  await mkdir(dirname(STORE_PATH), { recursive: true });
  const temporary = `${STORE_PATH}.tmp`;
  await writeFile(temporary, JSON.stringify(store, null, 2), "utf8");
  await rename(temporary, STORE_PATH);
}

server.get("/inbox/health", (_request, response) => {
  response.json({ status: "ok", service: "inbox-agent" });
});

server.get("/inbox/threads", async (request, response, next) => {
  try {
    const store = await readStore();
    const search = String(request.query.q ?? "").trim().toLowerCase();
    const requestedCategory = String(request.query.category ?? "all");
    const category = requestedCategory === "all" ? null : CategorySchema.safeParse(requestedCategory);
    if (category && !category.success) {
      response.status(400).json({ error: "Unknown inbox category" });
      return;
    }
    const threads = store.threads.filter((thread) => {
      const matchesSearch = !search || `${thread.name} ${thread.subject} ${thread.body}`.toLowerCase().includes(search);
      const matchesCategory = !category || thread.category === category.data;
      return matchesSearch && matchesCategory;
    });
    response.json({ threads, total: store.threads.length, filtered: threads.length });
  } catch (error) {
    next(error);
  }
});

server.get("/inbox/metrics", async (_request, response, next) => {
  try {
    const store = await readStore();
    const categories = [...new Set(store.threads.map((thread) => thread.category))];
    response.json({
      total: store.threads.length,
      new: store.threads.filter((thread) => thread.status === "new").length,
      drafted: store.threads.filter((thread) => thread.status === "drafted").length,
      sent: store.learning.sentCount,
      edited: store.learning.editedCount,
      unchanged: store.learning.unchangedCount,
      categories: Object.fromEntries(categories.map((category) => [
        category,
        { streak: store.learning.streaks[category] ?? 0, autoEnabled: store.learning.automation[category] ?? false }
      ]))
    });
  } catch (error) {
    next(error);
  }
});

server.post("/inbox/threads", async (request, response, next) => {
  try {
    const parsed = NewEmailSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid email" });
      return;
    }
    const store = await readStore();
    const email = makeThread(
      { ...parsed.data, category: classifyIntent(parsed.data.subject, parsed.data.body) },
      `email-${crypto.randomUUID()}`,
      new Date().toISOString()
    );
    store.threads.unshift(email);
    await writeStore(store);
    response.status(201).json({ thread: email });
  } catch (error) {
    next(error);
  }
});

server.post("/inbox/threads/:id/draft", async (request, response, next) => {
  try {
    const store = await readStore();
    const thread = store.threads.find((item) => item.id === request.params.id);
    if (!thread) {
      response.status(404).json({ error: "Email not found" });
      return;
    }
    const knowledge = await requestKnowledgeAnswer(`${thread.subject}\n${thread.body}`);
    const draft = await writeDraft(thread, knowledge);
    const autoSend = shouldAutoSend(thread.category, store.learning, knowledge.confidence)
      && !knowledge.needs_human;
    thread.draft = draft;
    thread.confidence = knowledge.confidence;
    thread.sourceTitles = knowledge.sources.map((source) => source.title);
    if (autoSend) {
      thread.reply = draft;
      thread.status = "sent";
      thread.sentAt = new Date().toISOString();
      thread.autoSent = true;
      store.learning.sentCount += 1;
    } else {
      thread.status = "drafted";
      thread.autoSent = false;
    }
    await writeStore(store);
    response.json({
      thread,
      knowledge: {
        answer: knowledge.answer,
        sources: knowledge.sources,
        confidence: knowledge.confidence,
        needs_human: knowledge.needs_human,
        mode: knowledge.mode
      },
      auto_sent: autoSend
    });
  } catch (error) {
    next(error);
  }
});

server.post("/inbox/threads/:id/reply", async (request, response, next) => {
  try {
    const parsed = ReplySchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid reply" });
      return;
    }
    const store = await readStore();
    const thread = store.threads.find((item) => item.id === request.params.id);
    if (!thread) {
      response.status(404).json({ error: "Email not found" });
      return;
    }
    if (!thread.draft) {
      response.status(409).json({ error: "Create a draft before sending a reply" });
      return;
    }
    const learning = recordHumanSend(store.learning, thread.category, thread.draft, parsed.data.reply);
    store.learning = learning.learning;
    thread.reply = parsed.data.reply;
    thread.wasEdited = learning.edited;
    thread.status = "sent";
    thread.sentAt = new Date().toISOString();
    thread.autoSent = false;
    await writeStore(store);
    response.json({
      thread,
      learning: {
        edited: learning.edited,
        streak: store.learning.streaks[thread.category] ?? 0,
        auto_enabled: store.learning.automation[thread.category] ?? false,
        message: learning.edited
          ? "Your edit was saved. The automation streak was reset for this email type."
          : "Sent without edits. This email type's consecutive approval streak increased."
      }
    });
  } catch (error) {
    next(error);
  }
});

server.post("/inbox/threads/:id/reopen", async (request, response, next) => {
  try {
    const store = await readStore();
    const thread = store.threads.find((item) => item.id === request.params.id);
    if (!thread) {
      response.status(404).json({ error: "Email not found" });
      return;
    }
    if (thread.status === "sent" && thread.autoSent) {
      thread.status = "drafted";
      thread.autoSent = false;
      thread.reply = "";
      thread.sentAt = null;
      store.learning.automation[thread.category] = false;
      store.learning.streaks[thread.category] = 0;
      await writeStore(store);
    }
    response.json({ thread });
  } catch (error) {
    next(error);
  }
});

server.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  const message = error instanceof Error ? error.message : "Unexpected inbox service error";
  console.error(`[inbox] ${message}`);
  response.status(500).json({ error: message });
});

server.listen(PORT, () => {
  console.log(`Inbox Agent listening on http://127.0.0.1:${PORT}`);
});
