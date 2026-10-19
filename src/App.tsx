import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  FileText,
  Globe2,
  Inbox,
  LayoutDashboard,
  LoaderCircle,
  Mail,
  MessageSquareText,
  MoreHorizontal,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  UsersRound,
} from "lucide-react";

type Page = "overview" | "knowledge" | "inbox" | "scopes" | "activity";
type Overview = {
  articles: number; questions: number; open_tasks: number; scopes: number;
  pending_approvals: number; last_sync: string | null; source_url: string | null; ai_mode: string;
  recent_questions: Array<{ id: number; question: string; confidence: number; created_at: string }>;
};
type Article = {
  url: string; title: string; category: string; content: string; excerpt: string;
  updated_at: string; images: Array<{ src: string; alt: string }>; demo: boolean;
};
type Source = { title: string; url: string; excerpt?: string; relevance?: number; demo?: boolean };
type InboxThread = {
  id: string; name: string; email: string; subject: string; body: string; category: string;
  status: "new" | "drafted" | "sent"; draft: string; reply: string; confidence: number;
  createdAt: string; sentAt: string | null; sourceTitles: string[]; wasEdited: boolean; autoSent: boolean;
};
type InboxMetrics = { total: number; new: number; drafted: number; sent: number; edited: number; unchanged: number };
type Scope = {
  id: string; client: string; title: string; summary: string; status: string; created_at: string;
  total_hours: number; requirements: Array<{ title: string; description: string; hours: number; type: string; included: boolean }>;
  questions: string[]; risks: string[]; proposal: string; changes?: { added: Array<{ title: string }>; removed: Array<{ title: string }>; outside_scope: Array<{ title: string }> };
  knowledge_suggestions?: Source[]; transcript_chunks?: number; review_note?: string;
};
type ActivityEvent = { id: number; label: string; created_at: string; kind: string; confidence?: number };
type KnowledgeAnswer = { answer: string; sources: Source[]; confidence: number; needs_human: boolean; mode: string };

const sampleTranscript = `Client: We're running a small professional association website and want members to find local providers more easily.
Consultant: What is happening today?
Client: Search works, but people cannot filter by the certification they hold. We also want to add a new category for independent studios. Our staff currently updates the directory by hand every week.
Consultant: Any other must-haves for the first release?
Client: We'd like to clean up the homepage and connect our existing domain. The domain is registered with Namecheap. Keep the current member profiles and payments working.
Consultant: What should we leave out of this first phase?
Client: No mobile app for now. We'd like a first version before our September conference, but we need help deciding what fits our budget.`;

const navItems: Array<{ id: Page; title: string; icon: typeof LayoutDashboard }> = [
  { id: "overview", title: "Overview", icon: LayoutDashboard },
  { id: "knowledge", title: "Knowledge brain", icon: BookOpen },
  { id: "inbox", title: "Inbox agent", icon: Inbox },
  { id: "scopes", title: "Meeting to scope", icon: FileText },
  { id: "activity", title: "Activity", icon: Activity },
];

const titleForPage: Record<Page, { eyebrow: string; title: string; description: string }> = {
  overview: { eyebrow: "YOUR WORKSPACE", title: "Your work, in focus", description: "A clear view of the work moving your clients forward." },
  knowledge: { eyebrow: "TASK 01 · KNOWLEDGE BRAIN", title: "Your shared memory", description: "Find an answer, explore its sources, or teach the brain something new." },
  inbox: { eyebrow: "TASK 02 · INBOX AGENT", title: "A calmer inbox", description: "Research each question. Draft a reply. Let a person decide what gets sent." },
  scopes: { eyebrow: "TASK 03 · MEETING TO SCOPE", title: "Turn talk into a plan", description: "Make the next step clear, estimate effort, then get a human sign-off." },
  activity: { eyebrow: "WORKSPACE HISTORY", title: "Everything in motion", description: "A shared, chronological record of knowledge and scope work." },
};

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...options?.headers },
  });
  const body = await response.json().catch(() => ({})) as { detail?: string; error?: string };
  if (!response.ok) throw new Error(body.detail || body.error || `Request failed (${response.status})`);
  return body as T;
}

function timeAgo(value: string | null): string {
  if (!value) return "Not synced yet";
  const minutes = Math.max(1, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} hr ago`;
  return `${Math.floor(minutes / 1440)} days ago`;
}

function initials(name: string): string {
  return name.split(" ").map((part) => part[0]).slice(0, 2).join("").toUpperCase();
}

export default function App() {
  const [page, setPage] = useState<Page>("overview");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [articles, setArticles] = useState<Article[]>([]);
  const [threads, setThreads] = useState<InboxThread[]>([]);
  const [inboxMetrics, setInboxMetrics] = useState<InboxMetrics | null>(null);
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const [summary, articleData, inboxData, metrics, scopeData, activityData] = await Promise.all([
        api<Overview>("/api/overview"),
        api<{ articles: Article[] }>("/api/knowledge/articles"),
        api<{ threads: InboxThread[] }>("/inbox/threads"),
        api<InboxMetrics>("/inbox/metrics"),
        api<{ scopes: Array<{ data: Scope; id: string; status: string }> }>("/api/scopes"),
        api<{ events: ActivityEvent[] }>("/api/activity"),
      ]);
      setOverview(summary);
      setArticles(articleData.articles);
      setThreads(inboxData.threads);
      setInboxMetrics(metrics);
      setScopes(scopeData.scopes.map((item) => ({ ...item.data, id: item.id, status: item.status })));
      setEvents(activityData.events);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not connect to the application services.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const header = titleForPage[page];
  const today = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(new Date());
  const inboxCounts = useMemo(() => ({
    total: threads.length,
    new: threads.filter((thread) => thread.status === "new").length,
  }), [threads]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#" onClick={(event) => { event.preventDefault(); setPage("overview"); }}>
          <span className="brand-mark"><Sparkles size={17} strokeWidth={2.5} /></span>
          <span className="brand-name">fieldnote<span>.</span></span>
        </a>
        <div className="workspace-switcher">
          <div className="workspace-avatar">N</div>
          <span className="workspace-copy"><strong>Northstar Studio</strong><small>Workspace</small></span>
          <ChevronDown size={15} className="muted" />
        </div>
        <p className="side-label">WORKSPACE</p>
        <nav className="nav-list">
          {navItems.map(({ id, title, icon: Icon }) => (
            <button key={id} className={`nav-item ${page === id ? "active" : ""}`} onClick={() => setPage(id)}>
              <Icon size={17} strokeWidth={1.8} />
              <span>{title}</span>
              {id === "inbox" && inboxCounts.new > 0 && <span className="nav-count">{inboxCounts.new}</span>}
              {id === "scopes" && overview?.pending_approvals ? <span className="nav-dot" /> : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-status">
            <span className="status-pulse" />
            <span><strong>All systems ready</strong><small>{overview?.ai_mode ?? "Checking connection"}</small></span>
            <ShieldCheck size={16} />
          </div>
          <button className="profile-button">
            <div className="profile-avatar">JD</div>
            <span className="workspace-copy"><strong>Jordan Davis</strong><small>Studio admin</small></span>
            <MoreHorizontal size={17} className="muted" />
          </button>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumbs"><span>Northstar Studio</span><ChevronRight size={14} /><strong>{header.title}</strong></div>
          <div className="topbar-actions">
            <div className="live-indicator"><span className="status-pulse" /> All systems operational</div>
            <button className="icon-button" title="Refresh data" onClick={() => void refresh()}><RefreshCw size={16} /></button>
            <div className="profile-avatar top-avatar">JD</div>
          </div>
        </header>
        <div className="page-content">
          <div className="page-heading">
            <div><p className="eyebrow">{header.eyebrow}</p><h1>{header.title}</h1><p className="page-description">{header.description}</p></div>
            <div className="heading-actions"><span className="date-chip"><Clock3 size={14} /> {today}</span></div>
          </div>
          {error && <div className="error-banner"><CircleHelp size={17} /><span>{error}</span><button onClick={() => void refresh()}>Retry</button></div>}
          {isLoading ? <div className="loading-state"><LoaderCircle className="spin" size={23} /> Connecting your workspace…</div> : (
            <>
              {page === "overview" && <OverviewPage
                overview={overview} inboxMetrics={inboxMetrics} articles={articles} threads={threads} scopes={scopes} events={events}
                onNavigate={setPage} onRefresh={() => void refresh()}
              />}
              {page === "knowledge" && <KnowledgePage articles={articles} overview={overview} onToast={setToast} onUpdated={() => void refresh()} />}
              {page === "inbox" && <InboxPage threads={threads} metrics={inboxMetrics} onToast={setToast} onUpdated={() => void refresh()} />}
              {page === "scopes" && <ScopesPage scopes={scopes} onToast={setToast} onUpdated={() => void refresh()} />}
              {page === "activity" && <ActivityPage events={events} />}
            </>
          )}
        </div>
        <footer className="app-footer"><span><Sparkles size={13} /> Fieldnote AI</span><span>Grounded in your knowledge · Human decisions stay human</span></footer>
      </main>
      {toast && <div className="toast"><CheckCircle2 size={17} />{toast}</div>}
    </div>
  );
}

function StatCard({ label, value, sub, icon: Icon, tone }: { label: string; value: string | number; sub: string; icon: typeof BookOpen; tone: string }) {
  return <div className="stat-card">
    <div className={`stat-icon ${tone}`}><Icon size={17} strokeWidth={1.9} /></div>
    <div className="stat-label">{label}</div>
    <div className="stat-value">{value}</div>
    <div className="stat-sub">{sub}</div>
  </div>;
}

function OverviewPage(props: {
  overview: Overview | null; inboxMetrics: InboxMetrics | null; articles: Article[];
  threads: InboxThread[]; scopes: Scope[]; events: ActivityEvent[];
  onNavigate: (page: Page) => void; onRefresh: () => void;
}) {
  const { overview, inboxMetrics, articles, threads, scopes, events, onNavigate, onRefresh } = props;
  const waitingThreads = threads.filter((thread) => thread.status !== "sent").slice(0, 4);
  const pendingScopes = scopes.filter((scope) => scope.status === "pending_review").slice(0, 3);
  return <div className="dashboard-grid">
    <section className="welcome-card">
      <div className="welcome-copy"><div className="welcome-kicker"><span className="sparkle-mini"><Sparkles size={12} /></span> YOUR AI CONSULTANT IS ON IT</div>
        <h2>Good work starts<br />with <em>better context.</em></h2>
        <p>Your knowledge, inbox and project scopes — one thoughtful place to move client work forward.</p>
        <button className="button button-dark" onClick={() => onNavigate("knowledge")}>Ask your knowledge brain <ArrowRight size={15} /></button>
      </div>
      <div className="orbit-art" aria-hidden="true"><div className="orbit orbit-one"><span className="orbit-center"><Sparkles size={23} /></span></div><div className="orbit orbit-two"><span className="orbit-node node-top"><BookOpen size={15} /></span><span className="orbit-node node-right"><Mail size={15} /></span><span className="orbit-node node-bottom"><FileText size={15} /></span></div><span className="orbit-star star-one">✳</span><span className="orbit-star star-two">✳</span><span className="orbit-star star-three">✳</span></div>
    </section>
    <section className="stats-row">
      <StatCard label="Knowledge articles" value={overview?.articles ?? 0} sub={overview?.last_sync ? `Synced ${timeAgo(overview.last_sync)}` : "Starter library · sync your help center"} icon={BookOpen} tone="lavender" />
      <StatCard label="Emails in queue" value={inboxMetrics?.new ?? 0} sub={`${inboxMetrics?.total ?? 0} sample conversations`} icon={Inbox} tone="peach" />
      <StatCard label="Scopes to review" value={overview?.pending_approvals ?? 0} sub={`${overview?.scopes ?? 0} scopes drafted`} icon={FileText} tone="mint" />
      <StatCard label="Open questions" value={overview?.open_tasks ?? 0} sub="Need an expert answer" icon={CircleHelp} tone="blue" />
    </section>
    <section className="content-card queue-card">
      <div className="card-heading"><div><p className="eyebrow">NEEDS YOUR ATTENTION</p><h3>In your queue <span className="heading-count">{waitingThreads.length + pendingScopes.length}</span></h3></div><button className="text-action" onClick={() => onNavigate("inbox")}>Open inbox <ArrowRight size={14} /></button></div>
      {waitingThreads.length === 0 && pendingScopes.length === 0 ? <div className="empty-inline"><CheckCircle2 size={18} /> Nothing waiting for review. Nice work.</div> : <div className="queue-list">
        {waitingThreads.map((thread) => <button className="queue-row" key={thread.id} onClick={() => onNavigate("inbox")}><div className="queue-avatar">{initials(thread.name)}</div><div className="queue-main"><strong>{thread.subject}</strong><span>{thread.name} · {thread.category.replaceAll("_", " ")}</span></div><span className={`status-pill ${thread.status}`}>{thread.status === "new" ? "New email" : "Review draft"}</span><ChevronRight size={15} className="muted" /></button>)}
        {pendingScopes.map((scope) => <button className="queue-row" key={scope.id} onClick={() => onNavigate("scopes")}><div className="queue-avatar scope-avatar"><FileText size={15} /></div><div className="queue-main"><strong>{scope.title}</strong><span>{scope.client} · {scope.total_hours}h estimate</span></div><span className="status-pill review">Needs approval</span><ChevronRight size={15} className="muted" /></button>)}
      </div>}
    </section>
    <section className="content-card brain-card">
      <div className="card-heading"><div><p className="eyebrow">KNOWLEDGE BRAIN</p><h3>Always learning, always grounded</h3></div><button className="more-button" onClick={onRefresh} aria-label="Refresh"><RefreshCw size={15} /></button></div>
      <div className="brain-summary"><div className="brain-glyph"><BookOpen size={19} /></div><div><strong>{overview?.source_url ? "Your help center is connected" : "Ready for your help center"}</strong><span>{overview?.source_url ?? "Connect a sitemap to index your source of truth."}</span></div></div>
      <div className="brain-meta"><span><span className="status-pulse" /> {overview?.articles ?? articles.length} articles indexed</span><span>Updated {timeAgo(overview?.last_sync ?? null)}</span></div>
      <button className="card-link" onClick={() => onNavigate("knowledge")}>Manage knowledge <ArrowUpRight size={14} /></button>
    </section>
    <section className="content-card activity-card">
      <div className="card-heading"><div><p className="eyebrow">RECENT ACTIVITY</p><h3>Good things are moving</h3></div><button className="text-action" onClick={() => onNavigate("activity")}>View all <ArrowRight size={14} /></button></div>
      {events.length ? <div className="activity-list">{events.slice(0, 4).map((event, index) => <div className="activity-row" key={`${event.kind}-${event.id}`}><span className={`activity-icon activity-${index % 3}`}>{event.kind === "knowledge" ? <MessageSquareText size={15} /> : <FileText size={15} />}</span><span className="activity-text"><strong>{event.label}</strong><small>{event.kind === "knowledge" ? "Knowledge answer" : event.kind.replaceAll("_", " ")}</small></span><time>{timeAgo(event.created_at)}</time></div>)}</div> : <div className="empty-inline">Your workspace activity will show up here.</div>}
    </section>
    <div className="dashboard-note"><ShieldCheck size={14} /><span>Human review is always in control. No email or proposal is sent without approval.</span><button onClick={() => onNavigate("scopes")}>How it works <ArrowRight size={13} /></button></div>
  </div>;
}

function KnowledgePage({ articles, overview, onToast, onUpdated }: { articles: Article[]; overview: Overview | null; onToast: (message: string) => void; onUpdated: () => void }) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Article | null>(articles[0] ?? null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<KnowledgeAnswer | null>(null);
  const [sitemap, setSitemap] = useState(overview?.source_url ?? "");
  const [busy, setBusy] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");
  const [expertAnswer, setExpertAnswer] = useState("");
  const [tasks, setTasks] = useState<Array<{ id: number; question: string; status: string }>>([]);
  const filtered = articles.filter((article) => `${article.title} ${article.category} ${article.content}`.toLowerCase().includes(search.toLowerCase()));
  const ask = async () => {
    if (question.trim().length < 3) return;
    setBusy(true); setAnswer(null);
    try {
      setAnswer(await api<KnowledgeAnswer>("/api/knowledge/ask", { method: "POST", body: JSON.stringify({ question }) }));
      onUpdated();
    } catch (error) { onToast(error instanceof Error ? error.message : "Could not ask the knowledge brain."); }
    finally { setBusy(false); }
  };
  const sync = async () => {
    setBusy(true); setSyncMessage("");
    try {
      const result = await api<{ added: number; updated: number; unchanged: number; removed: number; failed: number; pages_seen: number }>("/api/knowledge/sync", { method: "POST", body: JSON.stringify({ sitemap_url: sitemap }) });
      setSyncMessage(`${result.pages_seen} pages checked · ${result.added} added · ${result.updated} updated · ${result.removed} removed · ${result.failed} failed`);
      onToast("Help center sync finished."); onUpdated();
    } catch (error) { setSyncMessage(error instanceof Error ? error.message : "Sync failed."); }
    finally { setBusy(false); }
  };
  const loadTasks = async () => {
    try { setTasks((await api<{ tasks: Array<{ id: number; question: string; status: string }> }>("/api/knowledge/tasks")).tasks); }
    catch (error) { onToast(error instanceof Error ? error.message : "Could not load expert tasks."); }
  };
  useEffect(() => { void loadTasks(); }, []);
  const answerTask = async (id: number) => {
    if (expertAnswer.trim().length < 3) return;
    try {
      await api(`/api/knowledge/tasks/${id}/answer`, { method: "POST", body: JSON.stringify({ answer: expertAnswer }) });
      setExpertAnswer(""); await loadTasks(); onUpdated(); onToast("Expert answer added to shared knowledge.");
    } catch (error) { onToast(error instanceof Error ? error.message : "Could not save expert answer."); }
  };
  return <div className="knowledge-layout">
    <div className="knowledge-main">
      <div className="content-card ask-card">
        <div className="ask-topline"><div className="ask-icon"><Sparkles size={17} /></div><div><span className="eyebrow">ASK YOUR KNOWLEDGE BRAIN</span><p>Answers backed by your own help center.</p></div><span className="grounded-badge"><ShieldCheck size={13} /> Source grounded</span></div>
        <div className="ask-input-wrap"><textarea rows={2} value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void ask(); } }} placeholder="Try “How do I change a member's plan?”" /><button className="button button-dark" onClick={() => void ask()} disabled={busy || question.trim().length < 3}>{busy ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />} Ask</button></div>
        {answer && <div className="answer-result"><div className="answer-heading"><strong>Here’s what I found</strong><span className={`confidence ${answer.needs_human ? "low" : ""}`}>{answer.needs_human ? "Needs expert review" : `${Math.round(answer.confidence * 100)}% relevance`}</span></div><p>{answer.answer}</p>{answer.sources.length > 0 && <div className="source-stack">{answer.sources.map((source) => <a className="source-chip" href={source.url} target="_blank" rel="noreferrer" key={source.url}><BookOpen size={13} /><span>{source.title}</span><ArrowUpRight size={12} /></a>)}</div>}</div>}
      </div>
      <div className="content-card article-card">
        <div className="card-heading"><div><p className="eyebrow">YOUR KNOWLEDGE LIBRARY</p><h3>One source of truth <span className="heading-count">{articles.length}</span></h3></div><button className="more-button" onClick={onUpdated} aria-label="Reload articles"><RefreshCw size={15} /></button></div>
        {articles.some((article) => article.demo) && <div className="demo-notice"><CircleHelp size={14} /><span>Example starter articles are shown for the demo. Sync your own help center before relying on these answers.</span></div>}
        <div className="article-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search articles and topics…" /><span>{filtered.length} results</span></div>
        <div className="article-browser">
          <div className="article-list">{filtered.map((article) => <button key={article.url} onClick={() => setSelected(article)} className={`article-row ${selected?.url === article.url ? "selected" : ""}`}><span className="article-type"><BookOpen size={15} /></span><span className="article-label"><strong>{article.title}</strong><small>{article.category}</small></span><ChevronRight size={14} /></button>)}{filtered.length === 0 && <div className="empty-inline">No articles match your search.</div>}</div>
          <article className="article-detail">{selected ? <><span className="category-tag">{selected.category}</span><h3>{selected.title}</h3><div className="article-meta"><Globe2 size={13} /> {new URL(selected.url).hostname}<span>·</span>{timeAgo(selected.updated_at)}</div><p>{selected.content}</p>{selected.images.length > 0 && <div className="article-images">{selected.images.map((image) => <a href={image.src} target="_blank" rel="noreferrer" key={image.src}><img src={image.src} alt={image.alt || "Help article image"} /><span>{image.alt || "Article image"}</span></a>)}</div>}<a className="card-link" href={selected.url} target="_blank" rel="noreferrer">Open original article <ArrowUpRight size={14} /></a></> : <div className="empty-inline">Choose an article to read it.</div>}</article>
        </div>
      </div>
      {tasks.some((task) => task.status === "open") && <div className="content-card tasks-card"><div className="card-heading"><div><p className="eyebrow">EXPERT REVIEW</p><h3>Questions to teach the brain</h3></div><span className="status-pill review">{tasks.filter((task) => task.status === "open").length} waiting</span></div>{tasks.filter((task) => task.status === "open").map((task) => <div className="expert-task" key={task.id}><strong>{task.question}</strong><textarea rows={2} value={expertAnswer} onChange={(event) => setExpertAnswer(event.target.value)} placeholder="Write the confirmed answer…" /><button className="button button-dark button-small" disabled={expertAnswer.trim().length < 3} onClick={() => void answerTask(task.id)}><Check size={14} /> Save to brain</button></div>)}</div>}
    </div>
    <aside className="knowledge-aside">
      <div className="content-card sync-card"><span className="aside-icon"><RefreshCw size={17} /></span><p className="eyebrow">KEEP IT FRESH</p><h3>Sync your help center</h3><p>We check your sitemap for new, updated and removed pages.</p><label className="field-label" htmlFor="sitemap-url">SITEMAP URL</label><input id="sitemap-url" className="text-input" value={sitemap} onChange={(event) => setSitemap(event.target.value)} placeholder="https://example.com/sitemap.xml" /><button className="button button-dark button-full" onClick={() => void sync()} disabled={busy || sitemap.length < 8}>{busy ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={14} />} Sync help center</button>{syncMessage && <div className="sync-result">{syncMessage}</div>}<div className="sync-last"><Clock3 size={13} /> Last sync: {timeAgo(overview?.last_sync ?? null)}</div><div className="safe-note"><ShieldCheck size={14} /><span>Public websites only. Pages are fetched gently, with a 2 MB page limit.</span></div></div>
      <div className="content-card brain-health"><p className="eyebrow">BRAIN HEALTH</p><div className="health-line"><span>Source coverage</span><strong>{articles.length ? "Building" : "Waiting"}</strong></div><div className="health-track"><span style={{ width: `${Math.min(100, Math.max(12, articles.length * 7))}%` }} /></div><div className="health-line"><span>Questions answered</span><strong>{overview?.questions ?? 0}</strong></div><div className="health-line"><span>Human review queue</span><strong>{overview?.open_tasks ?? 0}</strong></div><div className="privacy-caption"><ShieldCheck size={13} /> Every answer includes its sources.</div></div>
      <div className="tip-card"><div><Sparkles size={16} /><strong>Built to learn</strong></div><p>When an answer is missing, an expert can write it once. It becomes part of the shared brain.</p></div>
    </aside>
  </div>;
}

function InboxPage({ threads: initialThreads, metrics, onToast, onUpdated }: { threads: InboxThread[]; metrics: InboxMetrics | null; onToast: (message: string) => void; onUpdated: () => void }) {
  const [threads, setThreads] = useState(initialThreads);
  const [selectedId, setSelectedId] = useState(initialThreads[0]?.id ?? "");
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [reply, setReply] = useState("");
  const [knowledge, setKnowledge] = useState<KnowledgeAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setThreads(initialThreads); if (!selectedId && initialThreads[0]) setSelectedId(initialThreads[0].id); }, [initialThreads, selectedId]);
  const visible = threads.filter((thread) => {
    const categoryMatch = filter === "all"
      || (["new", "drafted", "sent"].includes(filter) ? thread.status === filter : thread.category === filter);
    const searchMatch = !search || `${thread.name} ${thread.subject} ${thread.body}`.toLowerCase().includes(search.toLowerCase());
    return categoryMatch && searchMatch;
  });
  const selected = threads.find((thread) => thread.id === selectedId) ?? visible[0] ?? null;
  const pickThread = (thread: InboxThread) => { setSelectedId(thread.id); setReply(thread.draft || ""); setKnowledge(null); };
  const draftReply = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const result = await api<{ thread: InboxThread; knowledge: KnowledgeAnswer; auto_sent: boolean }>(`/inbox/threads/${selected.id}/draft`, { method: "POST", body: "{}" });
      setThreads((items) => items.map((item) => item.id === selected.id ? result.thread : item));
      setReply(result.thread.draft); setKnowledge(result.knowledge);
      if (result.auto_sent) onToast("A previously approved, low-risk reply was sent automatically.");
      onUpdated();
    } catch (error) { onToast(error instanceof Error ? error.message : "Could not draft a reply."); }
    finally { setBusy(false); }
  };
  const sendReply = async () => {
    if (!selected || reply.trim().length < 3) return;
    setBusy(true);
    try {
      const result = await api<{ thread: InboxThread; learning: { message: string } }>(`/inbox/threads/${selected.id}/reply`, { method: "POST", body: JSON.stringify({ reply }) });
      setThreads((items) => items.map((item) => item.id === selected.id ? result.thread : item));
      onToast(result.learning.message); setKnowledge(null); onUpdated();
    } catch (error) { onToast(error instanceof Error ? error.message : "Could not send the reply."); }
    finally { setBusy(false); }
  };
  return <div className="inbox-workspace">
    <div className="inbox-toolbar"><div className="inbox-tabs"><button onClick={() => setFilter("all")} className={filter === "all" ? "active" : ""}>All <span>{threads.length}</span></button><button onClick={() => setFilter("new")} className={filter === "new" ? "active" : ""}>Needs reply <span>{metrics?.new ?? 0}</span></button><button onClick={() => setFilter("sent")} className={filter === "sent" ? "active" : ""}>Replied</button></div><div className="inbox-tools"><div className="article-search compact"><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search inbox…" /></div><button className="filter-button" onClick={() => setFilter(filter === "all" ? "how_to" : "all")}>Category <ChevronDown size={14} /></button></div></div>
    <div className="inbox-columns">
      <div className="thread-list">{visible.map((thread) => <button key={thread.id} onClick={() => pickThread(thread)} className={`thread-row ${selected?.id === thread.id ? "selected" : ""}`}><div className={`queue-avatar thread-avatar ${thread.category === "security" ? "security-avatar" : ""}`}>{initials(thread.name)}</div><div className="thread-preview"><div className="thread-preview-top"><strong>{thread.name}</strong><time>{timeAgo(thread.createdAt)}</time></div><span className="thread-subject">{thread.subject}</span><span className="thread-snippet">{thread.body}</span><div className="thread-tags"><span className="category-tag">{thread.category.replaceAll("_", " ")}</span>{thread.status === "new" && <span className="unread-dot" />}{thread.status === "drafted" && <span className="status-pill review">Draft ready</span>}{thread.status === "sent" && <CheckCheck size={13} className="sent-check" />}</div></div></button>)}{visible.length === 0 && <div className="empty-inline">No conversations match.</div>}</div>
      {selected ? <div className="conversation-panel">
        <div className="conversation-heading"><div><span className="category-tag">{selected.category.replaceAll("_", " ")}</span><h3>{selected.subject}</h3><div className="sender-line"><span className="queue-avatar small-avatar">{initials(selected.name)}</span><strong>{selected.name}</strong><span>&lt;{selected.email}&gt;</span></div></div><button className="more-button" aria-label="More options"><MoreHorizontal size={17} /></button></div>
        <div className="conversation-body"><div className="message-bubble"><div className="message-meta"><span>{selected.name}</span><time>{new Date(selected.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</time></div><p>{selected.body}</p></div>
          {selected.reply && selected.status === "sent" && <div className={`sent-bubble ${selected.autoSent ? "auto" : ""}`}><div className="message-meta"><span>{selected.autoSent ? "Fieldnote · auto-sent" : "Your reply"}</span><CheckCheck size={13} /></div><p>{selected.reply}</p></div>}
        </div>
        <div className="reply-composer"><div className="composer-header"><span><Sparkles size={14} /> {selected.draft ? "AI-ASSISTED DRAFT" : "YOUR REPLY"}</span>{selected.confidence > 0 && <span className="confidence">{Math.round(selected.confidence * 100)}% source match</span>}</div><textarea value={reply} onChange={(event) => setReply(event.target.value)} placeholder="Write a thoughtful reply…" rows={5} disabled={selected.status === "sent" && !selected.autoSent} /><div className="composer-actions"><span className="composer-assurance"><ShieldCheck size={13} /> {selected.draft ? "Review before sending" : "No email is sent automatically"}</span><div>{selected.status !== "sent" && <button className="button button-light" onClick={() => void draftReply()} disabled={busy}>{busy ? <LoaderCircle className="spin" size={14} /> : <Sparkles size={14} />}{selected.draft ? "Redraft" : "Draft reply"}</button>}{selected.status !== "sent" && <button className="button button-dark" onClick={() => void sendReply()} disabled={busy || !selected.draft || reply.trim().length < 3}><Send size={14} /> Send reply</button>}</div></div>
          {knowledge && <div className="grounding-box"><div><BookOpen size={14} /><strong>Knowledge Brain checked</strong><span>{knowledge.needs_human ? "Needs a human answer" : `${Math.round(knowledge.confidence * 100)}% relevance`}</span></div><p>{knowledge.answer}</p>{knowledge.sources.map((source) => <a href={source.url} target="_blank" rel="noreferrer" key={source.url}>{source.title} <ArrowUpRight size={11} /></a>)}</div>}
        </div>
      </div> : <div className="conversation-empty"><Mail size={26} /><strong>Select an email</strong><span>Choose a conversation to read and reply.</span></div>}
    </div>
    <div className="learning-footer"><span><Sparkles size={14} /> The agent learns from every edit.</span><span>{metrics?.unchanged ?? 0} approved unchanged <span className="learning-divider">·</span> {metrics?.edited ?? 0} human edits <button className="text-action" onClick={onUpdated}>Refresh <RefreshCw size={12} /></button></span></div>
  </div>;
}

function ScopesPage({ scopes, onToast, onUpdated }: { scopes: Scope[]; onToast: (message: string) => void; onUpdated: () => void }) {
  const [transcript, setTranscript] = useState("");
  const [client, setClient] = useState("");
  const [previousId, setPreviousId] = useState("");
  const [selectedId, setSelectedId] = useState(scopes[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState<Scope | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  useEffect(() => { if (!scope && scopes[0]) { setScope(scopes[0]); setSelectedId(scopes[0].id); } }, [scope, scopes]);
  const selectScope = (id: string) => {
    setSelectedId(id);
    const value = scopes.find((item) => item.id === id);
    if (value) setScope(value);
  };
  const generate = async () => {
    if (transcript.trim().length < 20) return;
    setBusy(true);
    try {
      const generated = await api<Scope>("/api/scopes/analyze", { method: "POST", body: JSON.stringify({ transcript, client: client || "New client", previous_scope_id: previousId || null }) });
      setScope(generated); setSelectedId(generated.id); setReviewNote(""); onToast("Draft scope is ready for human review."); onUpdated();
    } catch (error) { onToast(error instanceof Error ? error.message : "Could not create the scope."); }
    finally { setBusy(false); }
  };
  const approve = async (approved: boolean) => {
    if (!scope) return;
    setBusy(true);
    try {
      await api(`/api/scopes/${scope.id}/approval`, { method: "POST", body: JSON.stringify({ approved, note: reviewNote }) });
      setScope({ ...scope, status: approved ? "approved" : "changes_requested", review_note: reviewNote });
      onToast(approved ? "Scope approved. It's ready to share." : "Changes requested. The scope stays internal."); onUpdated();
    } catch (error) { onToast(error instanceof Error ? error.message : "Could not save your review."); }
    finally { setBusy(false); }
  };
  const copyProposal = async () => {
    if (!scope) return;
    try { await navigator.clipboard.writeText(scope.proposal); onToast("Proposal copied to clipboard."); }
    catch { onToast("Clipboard access was denied by the browser."); }
  };
  return <div className="scope-layout">
    <div className="scope-main">
      <div className="content-card transcript-card"><div className="card-heading"><div><p className="eyebrow">MEETING INPUT</p><h3>Start with what you heard</h3></div><button className="text-action" onClick={() => setTranscript(sampleTranscript)}>Load a sample meeting <ArrowDownLeft size={14} /></button></div><div className="scope-fields"><label><span>CLIENT NAME</span><input value={client} onChange={(event) => setClient(event.target.value)} placeholder="e.g. Acme Association" /></label><label><span>FOLLOW-UP MEETING</span><select value={previousId} onChange={(event) => setPreviousId(event.target.value)}><option value="">First meeting / start new scope</option>{scopes.map((item) => <option value={item.id} key={item.id}>{item.client} — {item.title}</option>)}</select></label></div><label className="transcript-label" htmlFor="transcript-text">TRANSCRIPT OR MEETING NOTES</label><textarea id="transcript-text" className="transcript-area" value={transcript} onChange={(event) => setTranscript(event.target.value)} placeholder={"Paste the meeting notes here…\n\nLong transcripts are split into manageable chunks before analysis."} /><div className="transcript-footer"><span><ShieldCheck size={13} /> Long transcripts are chunked before analysis.</span><button className="button button-dark" onClick={() => void generate()} disabled={busy || transcript.trim().length < 20}>{busy ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />} Create a draft scope</button></div></div>
      <div className="content-card review-card"><div className="card-heading"><div><p className="eyebrow">SCOPE WORKSPACE</p><h3>{scope?.title ?? "Your project plan"}</h3></div>{scope && <span className={`status-pill ${scope.status === "approved" ? "sent" : "review"}`}>{scope.status.replaceAll("_", " ")}</span>}</div>{scope ? <>
        <p className="scope-summary">{scope.summary}</p>
        {scope.changes && <div className="change-summary"><strong>Follow-up changes</strong><span><i className="change-added">+ {scope.changes.added.length} added</i><i className="change-removed">− {scope.changes.removed.length} removed</i><i>{scope.changes.outside_scope.length} outside scope</i></span></div>}
        <div className="estimate-strip"><div><span>PRELIMINARY ESTIMATE</span><strong>{scope.total_hours} <small>hours</small></strong></div><span className="estimate-disclaimer">Planning estimate only · confirm with your developer</span></div>
        <div className="requirements-table"><div className="requirement-head"><span>DELIVERABLE</span><span>APPROACH</span><span>EFFORT</span></div>{scope.requirements.map((item, index) => <div className="requirement-row" key={`${item.title}-${index}`}><div><strong>{item.title}</strong><small>{item.description}</small></div><span className={`approach-tag ${item.type === "configuration" ? "config" : ""}`}>{item.type}</span><strong className="hours-cell">{item.hours}h</strong></div>)}{scope.requirements.length === 0 && <div className="empty-inline">No clear deliverables were extracted. Add more detailed notes or request a human discovery session.</div>}</div>
        {scope.knowledge_suggestions && scope.knowledge_suggestions.length > 0 && <div className="scope-knowledge"><div><BookOpen size={15} /><strong>Check configuration before custom work</strong></div>{scope.knowledge_suggestions.slice(0, 3).map((source) => <a key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.title} <ArrowUpRight size={12} /></a>)}</div>}
        <div className="scope-columns"><div><p className="eyebrow">OPEN QUESTIONS</p>{scope.questions.map((item, i) => <p className="scope-bullet" key={i}><CircleHelp size={13} />{item}</p>)}</div><div><p className="eyebrow">RISKS & ASSUMPTIONS</p>{scope.risks.map((item, i) => <p className="scope-bullet" key={i}><ShieldCheck size={13} />{item}</p>)}</div></div>
        <div className="proposal-block"><div className="proposal-heading"><div><p className="eyebrow">CLIENT-READY PROPOSAL · DRAFT</p><h4>Ready for your voice</h4></div><button className="button button-light button-small" onClick={() => void copyProposal()}><FileText size={13} /> Copy proposal</button></div><p>{scope.proposal}</p></div>
        {scope.status !== "approved" && <div className="approval-box"><div><ShieldCheck size={15} /><strong>Human approval required</strong><span>This draft is never sent to the client automatically.</span></div><input value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} placeholder="Add an optional review note…" /><div className="approval-actions"><button className="button button-light button-small" onClick={() => void approve(false)} disabled={busy}>Request changes</button><button className="button button-dark button-small" onClick={() => void approve(true)} disabled={busy}><Check size={14} /> Approve scope</button></div></div>}
        {scope.status === "approved" && <div className="approved-note"><CheckCircle2 size={16} /> Approved · {scope.review_note || "Ready for your team to share."}</div>}
      </> : <div className="empty-state"><FileText size={27} /><strong>Your scope will take shape here.</strong><span>Paste meeting notes to draft deliverables, effort, questions and a proposal.</span></div>}</div>
    </div>
    <aside className="scope-aside"><div className="content-card agent-card"><div className="agent-heading"><div className="agent-icon"><UsersRound size={17} /></div><div><strong>Your consulting team</strong><span>Three focused perspectives</span></div></div>{[{ icon: <MessageSquareText size={14} />, title: "Discovery", text: "Extracts clear needs and open questions." }, { icon: <BookOpen size={14} />, title: "Configuration check", text: "Checks the Knowledge Brain first." }, { icon: <FileText size={14} />, title: "Scope & estimate", text: "Drafts a plan for a human to review." }].map((item) => <div className="agent-step" key={item.title}><span>{item.icon}</span><div><strong>{item.title}</strong><small>{item.text}</small></div><CheckCircle2 size={13} /></div>)}</div><div className="content-card scope-history"><div className="card-heading"><div><p className="eyebrow">PAST SCOPES</p><h3>Project history</h3></div><span className="heading-count">{scopes.length}</span></div>{scopes.length ? scopes.map((item) => <button key={item.id} onClick={() => selectScope(item.id)} className={`history-row ${selectedId === item.id ? "selected" : ""}`}><span className="history-icon"><FileText size={14} /></span><span><strong>{item.title}</strong><small>{item.client} · {item.total_hours}h</small></span><span className={`status-indicator ${item.status === "approved" ? "green" : ""}`} /></button>) : <div className="empty-inline">Scopes you create are saved here.</div>}</div><div className="scope-safe-note"><ShieldCheck size={14} /><span>No scope, estimate or proposal leaves your workspace without your approval.</span></div></aside>
  </div>;
}

function ActivityPage({ events }: { events: ActivityEvent[] }) {
  return <div className="content-card full-activity-card"><div className="card-heading"><div><p className="eyebrow">YOUR WORKSPACE</p><h3>Recent decisions and answers</h3></div><span className="heading-count">{events.length}</span></div>{events.length ? <div className="full-activity-list">{events.map((event, index) => <div className="full-activity-row" key={`${event.kind}-${event.id}-${index}`}><span className={`activity-icon activity-${index % 3}`}>{event.kind === "knowledge" ? <MessageSquareText size={15} /> : <FileText size={15} />}</span><div><strong>{event.label}</strong><span>{event.kind === "knowledge" ? `Knowledge answer · ${event.confidence ? `${Math.round(event.confidence * 100)}% relevance` : "awaiting review"}` : event.kind.replaceAll("_", " ")}</span></div><time>{new Date(event.created_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</time></div>)}</div> : <div className="empty-state"><Activity size={26} /><strong>Your activity will appear here.</strong><span>Ask a question, draft an inbox response or build a client scope.</span></div>}</div>;
}
