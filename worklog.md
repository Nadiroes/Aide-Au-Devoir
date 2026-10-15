# Worklog — Aide au Devoir ( Homework Help App )

Project: Next.js 16 + TypeScript + Tailwind 4 + shadcn/ui + Prisma/SQLite.
Goal (from user's pasted spec): French homework-help app.
- Import courses (PDF, DOCX, TXT, PNG, JPEG) with title + subject.
- Ingestion agents scan documents and announce when ready (real-time SSE).
- Multi-agent chat pipeline: Planificateur → Chercheur (RAG) → Solveur → Tuteur, streamed agent-by-agent.
- API key management for Mistral + Agnes (test / save encrypted / delete / status) + built-in Z.ai provider so the app works without keys.
- Single visible route `/` (tab navigation: Accueil, Cours, Assistant, Paramètres).

Key decisions (Task 1):
- Everything in Next.js (no separate Python backend). Node ports of ingestion + retrieval + LLM router.
- PDF text: `unpdf`; DOCX: `mammoth`; TXT/MD: direct read; PNG/JPEG: z-ai VLM (base64 data URL) with tesseract CLI fallback.
- Vector store replaced by BM25 lexical search over Chunks in SQLite (French-aware normalization: accent-strip, stopwords, plural-stem) — robust, zero external services.
- API keys encrypted with AES-256-GCM (`src/lib/secretbox.ts`), master key from env MASTER_KEY or auto-generated `db/master.key`. Never returned raw — masked only.
- LLM providers: `zai` (built-in SDK, default, no key), `mistral` (api.mistral.ai, streaming SSE), `agnes` (OpenAI-compatible adapter configured via AGNES_BASE_URL/AGNES_MODEL/AGNES_TEST_PATH/AGNES_AUTH_STYLE env vars).
- SSE contract defined in `src/lib/types.ts` (shared client/server types).

---
Task ID: 1
Agent: main (Z.ai Code)
Task: Init worklog, Prisma schema, db push, install deps

Work Log:
- Read pasted spec (upload/Pasted Content_1792062759835.txt) and loaded LLM/VLM skill docs.
- Inspected project scaffold (package.json, prisma, db.ts, ui components all present).
- Created this worklog.

Stage Summary:
- Schema defined in prisma/schema.prisma: Document, Chunk, ApiKey, ChatMessage.
- Dependencies installed: unpdf (PDF), mammoth (DOCX).

---
Task ID: 2
Agent: main (Z.ai Code)
Task: Backend — API routes + SSE pipelines (documents upload, chat, keys, stats)

Work Log:
- src/lib/types.ts: shared DTOs + SSE event contracts (ChatEvent, IngestEvent).
- src/lib/secretbox.ts: AES-256-GCM encryption of API keys (master key env or db/master.key).
- src/lib/ingestion.ts: extractText (unpdf/mammoth/txt-md/VLM vision OCR + tesseract fallback) + French-aware chunkText (~900 chars, sentence boundaries, overlap).
- src/lib/search.ts: BM25 over Chunk rows (accent-strip, stopwords, plural stem), in-memory cache + invalidateSearchCache().
- src/lib/llm.ts: providers zai (built-in SDK, simulated token streaming, system→assistant role mapping), mistral (real SSE streaming), agnes (OpenAI-compatible via env AGNES_BASE_URL/MODEL/TEST_PATH/AUTH_STYLE); getStoredKey decrypts from DB.
- src/lib/agents.ts: runChatPipeline(opts, emit) — Planificateur → Chercheur (BM25 RAG) → Solveur (token stream) → Tuteur; persists ChatMessage; abort-aware.
- src/lib/sse-server.ts: sseResponse(handler, signal) → text/event-stream Response; wire format `data: {json}\n\n` (client parses `type` field).
- Routes: /api/documents (GET list, POST upload→SSE ingest events), /api/documents/[id] DELETE, /api/keys GET, /api/keys/test POST, /api/keys/save POST, /api/keys/[provider] DELETE, /api/chat (GET history, POST SSE pipeline), /api/stats GET.
- layout.tsx switched to French (lang="fr"), new metadata, sonner Toaster.

Verified with curl:
- GET /api/keys, /api/stats, /api/documents ✓
- POST /api/documents (txt) → SSE: Lecteur → Découpeur → Indexeur → ingest.done ✓
- POST /api/chat (zai) → pipeline.start, agent.start/log/done ×4, answer.token stream, retrieval.hit (BM25 score 1.857 on uploaded course), pipeline.done with persisted messageId ✓

Stage Summary:
- Backend 100% functional; API contract stable for frontend:
  - SSE format: single `data:` line per event, JSON with `type` discriminator.
  - Types importable client-side from "@/lib/types" (type-only imports).

---
Task ID: 3
Agent: full-stack-developer
Task: Frontend — single-page UI (tabs Accueil/Cours/Assistant/Paramètres), SSE clients, all sections

Work Log:
- Read worklog + src/lib/types.ts (contract) and inspected ui components (card/button/alert/select/collapsible/progress APIs confirmed).
- src/lib/sse-client.ts: postSse<T>(url, body, onEvent, signal?) — POST JSON or FormData, reads res.body.getReader(), buffers, splits on \n\n (CRLF-tolerant), parses `data:` lines, supports AbortSignal; throws server {message|error} on non-ok; exports isAbortError helper.
- src/lib/api-client.ts: typed wrappers (fetchDocuments, deleteDocument, fetchProviders, testApiKey, saveApiKey, deleteApiKey, fetchChatHistory, fetchStats) + ApiError; key test/save treat HTTP 400 {ok:false,message} as a normal result (not an exception).
- src/app/globals.css: appended `.scroll-thin` utility (6px webkit scrollbar + scrollbar-width: thin, thumb bg-border).
- src/components/app-header.tsx: sticky border-b header, emerald-600 logo square + bold title, 4 nav buttons (active bg-emerald-600 text-white), labels hidden sm:inline, nav overflow-x-auto; exports TabId type.
- src/components/app-footer.tsx: border-t, mt-auto, centered muted text, pb uses max(1rem, env(safe-area-inset-bottom)).
- src/components/agent-status.tsx: reusable AgentStatusList (chat + ingest agents) — status icons (Circle/Loader2-spin/CheckCircle2-emerald/AlertCircle-red), badges "en attente / en cours… / prêt / erreur", last 3 logs, done content in pre-wrap block; per-agent amber/teal/emerald/rose accents.
- src/components/markdown-view.tsx: shared react-markdown renderer with prose-like Tailwind arbitrary-variant styling (headings, lists, code, tables, blockquote; links emerald).
- src/components/dashboard-section.tsx: fetches /api/stats + /api/chat on mount; 4 stat cards (BookOpen/Layers/MessageSquare/KeyRound) with skeletons; 3 quick-action buttons navigating tabs; "Comment ça marche" 3 steps; "Dernières questions" (last 3, max-h-56 scroll).
- src/components/documents-section.tsx: upload card (title/subject inputs, drag & drop zone + hidden input, accepted formats, emerald Importer button disabled unless file+title), live Progress + AgentStatusList driven by POST /api/documents SSE events (agent.start/log/done/error, ingest.start/done/error), success Alert auto-hide 6s, toast on done/error; documents list (count heading, empty state, per-doc card with subject/kind badges, fr-FR formatted stats, AlertDialog delete confirm + toast, max-h-[480px] scroll).
- src/components/assistant-section.tsx: question card (Textarea, Ctrl/⌘+Enter submit, mode Select cours/libre, provider Select from /api/keys with disabled "(non configurée)" options + auto-correct selection, emerald Envoyer flex-1, Stop outline Square button aborting the stream and reverting running agents to idle); full ChatEvent state machine (pipeline.start/agent.*/retrieval.hit/answer.token/tutor.token/pipeline.done/pipeline.error) with toasts; answer card (fade-in via framer-motion, streamed markdown + pulsing ▍ cursor while solver runs, auto-scroll, Separator + "👨‍🏫 Fiche élève" tutor block); collapsible Historique (default collapsed while busy, expandable items with full answer + tutor + sources count); right column sticky: Agents list (planner plan shown via content) + "📎 Passages retenus" hits card (title, subject badge, score, line-clamp-3 preview, max-h-80 scroll).
- src/components/settings-section.tsx: fetches /api/keys; per-provider cards with badges (Inclus/Configurée emerald/Non configurée); agnes serverReady=false → amber AlertTriangle alert + disabled form; zai = no form ("Aucune clé nécessaire"); mistral/agnes password input with Eye/EyeOff + KeyRound, inline test Alert (CheckCircle2/XCircle), Tester (outline, FlaskConical) + Vérifier & enregistrer (emerald, Save) with Loader2 states, Enter triggers test; configured row shows masked key + Clock verifiedAt + Trash2 AlertDialog delete; security card (ShieldCheck, 4 bullets).
- src/app/page.tsx: "use client" root — min-h-screen flex flex-col, AppHeader, main max-w-6xl mx-auto px-4 py-6 md:py-8 flex-1 with tab-conditional sections, AppFooter (sticky-footer rule respected). No other routes created.

Stage Summary:
- bun run lint: PASS (0 errors/warnings). GET / → 200, dev.log shows only "✓ Compiled" (no errors).
- Verified /api/keys, /api/stats, /api/documents response shapes match api-client parsing; live POST /api/chat SSE stream (pipeline.start → planner plan content → retrieval.hit → answer.token) matches sse-client parser.
- Full French UI, emerald accent (no blue/indigo), responsive mobile-first, ≥44px touch targets on primary controls, thin scrollbars on all long lists, sonner toasts on every action outcome.
- Files: src/lib/{sse-client,api-client}.ts, src/components/{app-header,app-footer,agent-status,markdown-view,dashboard-section,documents-section,assistant-section,settings-section}.tsx, src/app/page.tsx (replaced), src/app/globals.css (appended utility only). No backend files touched, layout.tsx untouched.

---
Task ID: 4 & 5
Agent: main (Z.ai Code)
Task: Frontend review + Agent Browser E2E verification

Work Log:
- Reviewed subagent code (page.tsx, sse-client, api-client, assistant/documents/settings sections, agent-status): contract-correct, typed, lint clean.
- Agent Browser E2E on http://localhost:3000/ :
  - Dashboard: renders (stats 1 cours / 1 segment / 1 question / 0 clés at first load), quick actions navigate.
  - Cours tab: uploaded a generated PNG course ("Maths - Les fractions") via the UI -> SSE agent progress shown (Lecteur "en cours" with log, Découpeur, Indexeur) -> document created with "Extraction : OCR (vision)", 308 chars extracted by the VLM (accents preserved, verified chunk content).
  - Assistant tab: asked "Comment additionne-t-on deux fractions ?..." -> Planificateur prêt (plan displayed), Chercheur: "1 passage pertinent trouvé" + Passages retenus card (score 1.17), Solveur streamed markdown answer citing "d'après le cours Maths - Les fractions" with the exact 1/4+2/4=3/4 example from the OCR'd PNG, Tuteur fiche élève complete, Historique updated to 2.
  - Paramètres tab: 3 provider cards (Z.ai inclus, Mistral, Agnes); tested an INVALID Mistral key -> live verification against api.mistral.ai returned 401 -> red inline alert + toast "Clé Mistral refusée (401)". Agnes disabled with serverNote. Security card present.
  - Delete dialog: opens and cancels correctly.
  - Responsive: mobile 375px nav collapses to icons, layout stacks.
  - Footer: min-h-screen flex-col + mt-auto verified; on long pages pushed naturally (docH 1420 > viewport 812), at viewport bottom when scrolled.
  - No console errors, no page errors, no hydration warnings; bun run lint passes.

Stage Summary:
- App fully verified end-to-end in a real browser: import (TXT + PNG/OCR), multi-agent RAG chat with citations, API key live verification, settings CRUD paths, responsive layout, sticky footer.
- Test data left intentionally: 2 demo courses (SVT txt + Maths PNG-OCR) so the user can try RAG immediately.
