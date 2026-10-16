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

---
Task ID: 2-a
Agent: full-stack-developer
Task: Backend — folders, document editing/re-chunking, revision Q&A + SSE pipeline, TTS/ASR, self-learning memory, stats

Work Log:
- Read worklog + frozen contract src/lib/types.ts (FolderDTO, DocumentDTO v2, DocumentDetailDTO, RevisionQADTO, AgentMemoryDTO, StatsDTO v2, RevisionEvent, RevisionRequestBody, TtsRequestBody, coach/evaluator/learner agents, TTS_VOICES) and followed existing patterns (db.ts, sse-server.ts, llm.ts, agents.ts, ingestion.ts, search.ts, documents/chat/stats routes).
- src/lib/language.ts: detectLanguage (accent count ×2 + FR/EN stopword scoring on first 4000 chars, tokenized split to avoid JS \b issues with accented words, ties/empty → "fr") + languageLabel ("Français (FR)" / "Anglais (EN)").
- src/lib/tts.ts (backend-only SDK): splitTtsText (sentence boundaries [.!?\n…], accumulate ≤900, hard-slice fallback), singleton ZAI.create() promise via getZaiClient() (also reused by /api/asr), autoVoice (fr→tongtong, en→jam), in-memory LRU cache Map keyed voice|speed|sha1(text) with 48 MB byte-budget eviction (oldest-inserted, recency refresh on hit), synthesizeSpeech (clamp speed 0.5–2, strip markdown chars [*#`|_~>], collapse whitespace, ≤900 chars via splitTtsText[0], zai.audio.tts.create({input,voice,speed,response_format:"wav",stream:false}) → arrayBuffer → Buffer, French error "Synthèse vocale indisponible : …").
- src/lib/memory.ts: buildMemoryContext (top 12 by weight desc/updatedAt desc, scope OR[documentId null, =doc], "- [kind] content (weight w)", "" on any failure), MemoryOp type, applyMemoryOps (add with case-insensitive dedupe→reinforce, reinforce weight+0.5 cap 5 & hits+1, weaken weight−0.3 floor 0.2; per-op + global try/catch so memory never breaks the pipeline), memoryToDTO (with documentTitle).
- src/lib/revision.ts: runRevision(body, emit) mirroring agents.ts — document validation before revision.start; provider via getProvider(body.provider ?? "zai"); memory profile block ("PROFIL DE L'ÉLÈVE…") + output-language rule injected into every system prompt; actions: greet (no LLM, deterministic French greeting streamed word-by-word /(\s+)/ + 12ms, coach start/done "Cours prêt", NO QA row), question (2 random chunk samples + last 8 QAs as "déjà posées (ne répète PAS)" + avoidIds filter, streamed via message.token, agent.done carries the question), answer (BM25 searchChunks(question) filtered to doc top-2 → courseContext else textContent[:1500]; non-streaming evaluator → robust JSON parse (fences stripped, first {…last }) with fallback verdict "info"/score 50/raw[:500]; emits evaluation → persists RevisionQA (source "coach" if qaId else "user") → qa.saved → agent.done "Verdict — score N/100" → learner agent (existing memories w/ ids in prompt, max-3 ops JSON parsed+sanitized, applyMemoryOps, new rows re-fetched and emitted as memory.saved, summary "N apprentissage(s) enregistré(s)" / "0 apprentissage notable")), ask (streamed coach answer from course passage only, saves QA verdict "info" source "user" → qa.saved). Whole pipeline wrapped: any throw → revision.error (friendly French) + console.error. Exports qaToDTO (reused by /api/qa routes).
- Routes created: /api/folders (GET sorted by name w/ _count.documents, POST name ≤60 + color #RRGGBB default #059669 → 201, 400 on invalid), /api/folders/[id] (PATCH same validations → FolderDTO, DELETE; schema SetNull detaches docs), /api/qa (GET documentId required, filter all|visible|hidden|arevoir|moyen|connu, sort recent|oldest|verdict(wrong,partly,correct,info)|rating(arevoir,moyen,connu,null) JS-side, limit ≤500, take 1000 then JS sort+slice), /api/qa/[id] (PATCH hidden/rating connu|moyen|arevoir|null/answer/feedback → bare RevisionQADTO, DELETE → {ok:true}), /api/qa/clear (POST shown→hide visible, hidden→delete hidden, all→delete if alsoDelete else hide; returns {count}), /api/tts (TtsRequestBody, guard ≤9000 then slice 900 via synthesizeSpeech, WAV response w/ Content-Type audio/wav + Content-Length + Cache-Control private max-age=86400, 400/500 JSON errors), /api/asr (FormData "audio" File → base64 → zai.audio.asr.create({file_base64}) → {text}, 400 no file/empty, 20 MB guard, multi-shape result extraction), /api/revision (POST → sseResponse + runRevision exactly like /api/chat, GET → 405), /api/memory (GET top 200 w/ document title → {memories}, DELETE ?id= one / no id → deleteMany, returns {ok, deleted}).
- Routes updated: /api/stats → StatsDTO v2 (documents, folders, chunks, questions=RevisionQA, chatQuestions=ChatMessage, memoryCount, keysConfigured, languages{fr,en} via 2 counts — single Promise.all); /api/documents GET → folder include + _count.revisionQAs + 3 groupBys (arevoir/connu/rated) merged in JS → language, folderId/Name/Color, qaCount, qaToReview, mastery=round(connu/rated×100) or 0; POST → textContent=text, language=detectLanguage(text), agent.log "Langue détectée : Français (FR)" emitted under Lecteur, ingest.done uses new toIngestDTO; /api/documents/[id] → +GET DocumentDetailDTO (per-doc counts incl. rated/connu for mastery) and +PATCH {title?,subject?,folderId?(null-able, existence-checked),language?(fr|en),textContent? — changed text ⇒ chunkText re-chunk in $transaction (deleteMany chunks → update doc w/ chars+chunks → createMany), invalidateSearchCache()} while keeping DELETE.
- Ops fix: the long-running dev server process predated the prisma client regeneration → globalThis singleton held a client WITHOUT Folder/RevisionQA/AgentMemory (db.folder undefined, 500s). Restarted the dev server (new process picked up the regenerated client). No db:push/migrate run; no types.ts/frontend/sse-client/api-client/globals.css file touched.

Verified with curl (server on :3000):
- Folders CRUD: GET [] → POST 201 (DTO w/ documentCount) → PATCH rename → GET → DELETE {ok:true}; POST {"name":""} → 400. Folder attach: PATCH doc {folderId} → folderName/folderColor in list & detail; folder DELETE → doc detached (SetNull).
- Upload /tmp/cours-fractions.txt (758 chars) → SSE ingest.* incl. "Langue détectée : Français (FR)"; ingest.done DTO has language/qaCount/qaToReview/mastery/folder*; GET /api/documents shows qaCount 2 / qaToReview 1 / mastery 0→100 after rating connu.
- PATCH doc: rename OK; textContent change → re-chunk 1→2 segments, chars 758→1250, chunks invalidated; empty title → 400.
- POST /api/revision greet → revision.start, agent.start coach, message.token word stream ("Bonjour ! J'ai fini de lire « Maths — Les fractions » (1 segment extrait, 758 caractères, langue Français)… On commence la révision ?"), agent.done "Cours prêt", revision.done (no QA row).
- POST /api/revision question → coach logs + streamed question "Comment additionner correctement les fractions 3/8 et 5/12 ?" + agent.done(content=question) + revision.done; second run adapted (2/5 et 3/10) with memory present.
- POST /api/revision answer → agent.start Évaluateur, retrieval logs, evaluation {verdict wrong, score 0, feedback, modelAnswer} → qa.saved → "À revoir — score 0/100" → 🧠 Mémoire: memory.saved weakness "Confond l'addition des fractions…" + "1 apprentissage enregistré" + revision.done. Re-run with correct answer → verdict correct/100, memory.saved strength "L'élève maîtrise l'addition de fractions de même dénominateur". Empty userAnswer → revision.error "Réponse vide"; GET /api/revision → 405; bad body → 400.
- POST /api/revision ask → streamed coach answer (2 phrases, exact course rule 2/3×3/5=6/15=2/5) + qa.saved (verdict info, source user) + revision.done.
- /api/qa: list (2 rows), filter=arevoir/hidden, sort=rating (arevoir before null), PATCH rating connu/arevoir + hidden true/false, POST clear mode=hidden → {count:1} (deleted), mode=shown → {count:1} (hidden).
- /api/memory: GET 1–2 insights w/ documentTitle, DELETE ?id → {ok:true,deleted:1}; DELETE all tested via count return.
- /api/stats: {"documents":4,"folders":0,"chunks":228,"questions":2,"chatQuestions":9,"memoryCount":1,"keysConfigured":1,"languages":{"fr":4,"en":0}}.
- /api/tts: 227 856 octets, file(1) = "RIFF … WAVE audio, PCM 16 bit, mono 24000 Hz" (http 200 in 2.0s); 2nd identical call = cache HIT (13 ms, same bytes; [tts] cache HIT logged server-side only); empty text → 400; language "en" (jam) → valid WAV.
- /api/asr: no file → 400; round-trip POST of the TTS wav → {"text":"Bonjour, Ceci S N test de lecture audio"} (200).
- eslint on the 20 task files: PASS (0/0). Full `bun run lint`: 1 error + 3 warnings ALL inside the parallel frontend agent's in-progress src/components/memory-card.tsx + revision-section.tsx (frozen zone for task 2-a). tsc --noEmit: zero errors in task files (remaining hits are pre-existing examples/skills/ingestion vision typing + frontend WIP). dev.log: no compile/runtime errors from task files.

Stage Summary:
- Full revision backend live and contract-exact: 4 SSE actions (greet deterministic, question adaptive w/ avoidIds, answer evaluator→JSON verdict/score/feedback/modelAnswer→RevisionQA persist→learner self-memory, ask course-grounded answer), memory profile injected in all prompts + output-language rule from Document.language.
- Deliverables: src/lib/{language,tts,memory,revision}.ts + routes folders, folders/[id], qa, qa/[id], qa/clear, tts, asr, revision, memory + updated documents, documents/[id], stats. qaToDTO shared from revision.ts, memoryToDTO from memory.ts (no contract duplication).
- Deviations: (1) dev server restart required — stale pre-regeneration PrismaClient in the old process; (2) greeting uses bare "Français/Anglais" inside the sentence (spec's "{Français|Anglais}") to avoid "…langue Français (FR))." double-paren artifact; (3) "question" chunk sampling = 2 random distinct chunks (recent-QA→chunk mapping isn't stored, so "prefer unused" degrades to random as the spec allows); (4) /api/qa/... PATCH/POST single-resource endpoints return the bare DTO (spec wording) while list endpoints keep the {items} wrapper of the existing style.

---
Task ID: 2-b
Agent: full-stack-developer (recovered by main — agent hit context deadline after implementation, before verification)
Task: Frontend — Révision tab (Q&A coach + TTS player + ASR mic), folders & document editing, post-import redirect, agent memory card, audio settings

Work Log:
- Implemented against frozen contract types.ts: revision-section.tsx (1494 lines), memory-card.tsx, hooks/use-tts-player.ts, hooks/use-recorder.ts, api-client.ts extensions, page.tsx/app-header.tsx (TabId + "Révision" nav), documents-section.tsx (folders bar, dropdown actions, language badges), settings-section.tsx (Audio & Voix + getTtsPrefs), assistant-section.tsx (Volume2 read-aloud + MemoryCard), dashboard-section.tsx (StatsDTO v2 cards).
- Main agent verified completeness via grep/lint after timeout: all contract pieces present, `bun run lint` PASS (0 errors).

Stage Summary:
- All frontend deliverables landed and lint-clean; E2E verification performed by main (Task 3).

---
Task ID: 3
Agent: main (Z.ai Code)
Task: E2E browser verification of the full revision + audio + folders + memory feature set

Work Log:
- agent-browser on http://localhost:3000: dashboard 5-tab nav (Accueil/Cours/Révision/Assistant/Paramètres).
- Cours: created folder "Théologie Biblique" (6-color palette popover, toast), moved "Doctrines Biblique" into it via actions menu (count 0→1, toast), folder chip filter shows "Mes cours (1)" only that doc; doc cards show FR/EN badges, question counts; actions menu = Réviser/Écouter/Renommer/Modifier le texte/Déplacer vers…/Supprimer.
- Post-import flow: uploaded "La Photosynthèse (SVT)" via UI → toast "importé — 2 segments indexés" → AUTO-redirect to Révision tab with doc preselected + greeting bubble "J'ai lu « La Photosynthèse (SVT) » en entier. On commence la révision ?" [Oui, commence !] [Plus tard]. ✅ user requirement met.
- Coach SSE: "Oui, commence !" → coach streamed Q1 "Quels sont les trois facteurs limitants de la photosynthèse…?" with agents strip (Coach/Évaluateur/Mémoire) + "Écouter la question du coach" button.
- Evaluation: submitted a partly-wrong answer → "🟡 Partiel — score 60/100" + precise feedback + "Réponse attendue" collapsible + rating buttons Je sais/Moyen/À revoir. Rated "À revoir 🔁" (toast OK).
- Clear/show: "Effacer les réponses" → card collapses to "Réponse effacée de l'écran — conservée dans la fiche 👁️" + Afficher button (stored, not deleted); "Tout afficher" restores; sort "À revoir d'abord" works; Exporter .md fires download; mastery shows 0% (À revoir) — correct math.
- Audio: "Lancer la lecture audio" → "Segment 1 / 10" + current sentence highlighted, server POST /api/tts 200 (892 KB WAV tongtong), Stop resets. Speed/voice selectors present (Voix auto (FR)). Settings "🔊 Audio & Voix" card: voice (Auto FR→Tongtong EN→Jam), speed, autoread switch, "Tester la voix".
- Adaptive self-learning: next coach question targeted the EXACT confusion mémorisée (photosynthèse vs respiration); correct answer → "✅ Correct"; /api/memory shows 3 insights incl. reinforced weakness (weight 1.5, hits 1); Assistant tab card "🧠 Mémoire de l'assistant (3)" lists kind badges + doc titles + Tout effacer.
- EN detection: curl upload "The Water Cycle" → "Langue détectée : Anglais (EN)", language "en", EN badge in list, /api/tts language:en → valid WAV (jam).
- Mobile 375px: nav scroll-x, 2 cards stacked, no h-scroll (scrollW=375), footer reachable. Desktop 1280/1440: 2-col grid.
- Console errors: 0. Page errors: 0. bun run lint: PASS. dev.log: only clean 200s (tts/qa/folders/documents), no compile errors.

Stage Summary:
- Feature set verified end-to-end in a real browser: import→auto-revision greeting→adaptive coaching→evaluation→self-assessment→clear/show/sort/export→TTS before/during/after→ASR mic wiring→folders/renaming/editing→EN/FR detection→persistent self-learning memory.
- Test data left: 6 docs (5 FR + 1 EN), folder "Théologie Biblique", 2 revision QAs on Photosynthèse, 3 memory insights — user can explore immediately.
