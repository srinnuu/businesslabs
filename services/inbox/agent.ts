import { z } from "zod";

export const CategorySchema = z.enum([
  "how_to",
  "billing",
  "cancellation",
  "bug",
  "sales",
  "feature_request",
  "complaint",
  "follow_up",
  "account",
  "security",
  "other"
]);

export type Category = z.infer<typeof CategorySchema>;
export type ThreadStatus = "new" | "drafted" | "sent";

export interface EmailSeed {
  name: string;
  subject: string;
  category: Category;
  body: string;
}

export interface EmailThread extends EmailSeed {
  id: string;
  email: string;
  status: ThreadStatus;
  draft: string;
  reply: string;
  confidence: number;
  createdAt: string;
  sentAt: string | null;
  wasEdited: boolean;
  autoSent: boolean;
  sourceTitles: string[];
}

export interface LearningState {
  streaks: Partial<Record<Category, number>>;
  automation: Partial<Record<Category, boolean>>;
  editedCount: number;
  unchangedCount: number;
  sentCount: number;
}

export interface InboxStore {
  threads: EmailThread[];
  learning: LearningState;
}

export const ReplySchema = z.object({
  reply: z.string().trim().min(3).max(12000)
});

const RULES: Array<[Category, RegExp]> = [
  ["security", /\b(hacked|breach|security|unauthori[sz]ed|privacy|data leak|phishing)\b/i],
  ["cancellation", /\b(cancel|cancellation|unsubscribe|close my account|end my plan)\b/i],
  ["billing", /\b(refund|invoice|billing|charged|charge|payment|price|pricing|receipt|subscription|renewal)\b/i],
  ["complaint", /\b(unhappy|disappointed|complaint|frustrat|poor service|still waiting|unacceptable)\b/i],
  ["bug", /\b(error|bug|broken|crash|doesn't work|does not work|not loading|issue|failed|failure)\b/i],
  ["feature_request", /\b(feature|would love|could you add|please add|suggestion|request|roadmap)\b/i],
  ["sales", /\b(quote|proposal|pricing|interested|demo|new website|hire|project|estimate|budget)\b/i],
  ["follow_up", /\b(follow.?up|checking in|following up|status update|any update|last week|previous email)\b/i],
  ["account", /\b(password|login|sign.?in|account|locked out|email address|access)\b/i],
  ["how_to", /\b(how do i|how can i|how to|where can i|steps|configure|set up|change|update)\b/i]
];

export function classifyIntent(subject: string, body: string): Category {
  const combined = `${subject}\n${body}`;
  for (const [category, pattern] of RULES) {
    if (pattern.test(combined)) return category;
  }
  return "other";
}

export function shouldAutoSend(category: Category, learning: LearningState, confidence: number): boolean {
  const sensitive = new Set<Category>(["billing", "cancellation", "complaint", "security", "sales", "other"]);
  return Boolean(learning.automation[category]) && !sensitive.has(category) && confidence >= 0.6;
}

export function recordHumanSend(
  learning: LearningState,
  category: Category,
  draftedReply: string,
  humanReply: string
): { edited: boolean; learning: LearningState } {
  const edited = normalizeReply(draftedReply) !== normalizeReply(humanReply);
  const streaks = { ...learning.streaks };
  const automation = { ...learning.automation };
  if (edited) {
    streaks[category] = 0;
    automation[category] = false;
  } else {
    streaks[category] = (streaks[category] ?? 0) + 1;
    if (streaks[category]! >= 20) automation[category] = true;
  }
  return {
    edited,
    learning: {
      ...learning,
      streaks,
      automation,
      editedCount: learning.editedCount + Number(edited),
      unchangedCount: learning.unchangedCount + Number(!edited),
      sentCount: learning.sentCount + 1
    }
  };
}

export function normalizeReply(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export async function requestKnowledgeAnswer(
  question: string,
  baseUrl = process.env.KNOWLEDGE_API_URL ?? "http://127.0.0.1:8000"
): Promise<{
  answer: string;
  sources: Array<{ title: string; url: string; relevance: number }>;
  confidence: number;
  needs_human: boolean;
  mode: string;
}> {
  const response = await fetch(`${baseUrl}/api/knowledge/ask`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question })
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Knowledge Brain returned ${response.status}: ${message.slice(0, 300)}`);
  }
  return response.json() as Promise<{
    answer: string;
    sources: Array<{ title: string; url: string; relevance: number }>;
    confidence: number;
    needs_human: boolean;
    mode: string;
  }>;
}

export async function writeDraft(
  thread: EmailThread,
  knowledge: Awaited<ReturnType<typeof requestKnowledgeAnswer>>
): Promise<string> {
  if (knowledge.needs_human) {
    return `Hi ${thread.name.split(" ")[0]},\n\nThanks for reaching out. I want to make sure we give you an accurate answer, so I have asked a team member to review this for you. We will follow up as soon as we have confirmed the details.\n\nBest,\nThe team`;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (apiKey) {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514",
        max_tokens: 500,
        messages: [
          {
            role: "user",
            content: `Write a warm, concise customer email reply. Only state facts present in the knowledge answer below. Do not invent policy, pricing, or promises. If the question needs a human decision, say so and do not approve it.\n\nCustomer email:\n${thread.body}\n\nVerified Knowledge Brain answer:\n${knowledge.answer}\n\nRelevant sources:\n${knowledge.sources.map((source) => `${source.title}: ${source.url}`).join("\n")}`
          }
        ]
      })
    });
    if (!response.ok) {
      throw new Error(`Claude draft request failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
    }
    const payload = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = payload.content?.find((item) => item.type === "text")?.text?.trim();
    if (!text) throw new Error("Claude returned an empty inbox draft");
    return text;
  }

  return `Hi ${thread.name.split(" ")[0]},\n\nThanks for getting in touch. ${knowledge.answer}\n\nIf you have any other questions, just reply to this email and we'll be happy to help.\n\nBest,\nThe team`;
}

