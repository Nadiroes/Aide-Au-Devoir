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

---
Task ID: 2-c
Agent: full-stack-developer
Task: Backend — EPUB + audio ingestion (ffmpeg/ASR), scanned-doc review status, save-pdf (pdf-lib) + PDF serving

Work Log:
- Read worklog (tasks 1/2/2-a/2-b/3), frozen src/lib/types.ts (untouched), ingestion.ts, documents routes, asr/tts/search/db.
- src/lib/ingestion.ts:
  - SUPPORTED_EXTENSIONS += .epub, .mp3, .wav, .m4a, .ogg, .webm, .aac, .flac; KIND_OVERRIDES in kindFromFileName maps all audio extensions → kind "audio" (others keep ext-derived kind).
  - epubToText(buffer) via adm-zip (no XML parser dep): container.xml → <rootfile full-path> → OPF regex-parsed (manifest id→href/media-type, spine itemref order) → spine XHTML/HTML entries (media-type or .xhtml/.html/.htm), hrefs resolved relative to OPF dir (normalizeZipPath handles ../, ./, leading /, URL-decode, #anchors, case-insensitive entry fallback). htmlToText: strips script/style/head + comments, <br> & closing p/div/h1-6/li/tr/section/article/blockquote/figcaption/dd/dt → \n, strips remaining tags, decodes &lt; &gt; &quot; &apos; &nbsp; + numeric &#NNN;/&#xNN; (safeCodePoint guards surrogates/control codes) + ~40 common named entities (French/Latin-1 focus: &eacute; &egrave; &mdash; &oelig; …) with &amp; decoded LAST (single-pass, "&amp;lt;" stays "&lt;"), collapses 3+ \n → 2. French "EPUB illisible : …" errors (archive corrompue / container.xml manquant / rootfile sans full-path / OPF introuvable / manifest vide / aucun chapitre). Empty chapters skipped; chapters joined "\n\n"; returns {text, chapters}.
  - transcribeAudioFile(buffer, fileName, onProgress): 80 MB guard ("Fichier audio trop volumineux (max 80 Mo). Découpe-le ou convertis-le en mp3."), tmp /tmp/ad-audio-<ts>/input.<ext>, ffmpeg -vn -f segment -segment_time 420 -ac 1 -ar 16000 seg_%03d.wav (execFileAsync timeout 300 s) → French error "Conversion audio impossible (ffmpeg indisponible) : …" on failure; readdir+sort segments, per-segment base64 → getZaiClient().audio.asr.create({file_base64}) with the same multi-shape .text/.data.text extraction as /api/asr; failed segment → " [segment N non transcrit]" marker + continue; onProgress(`Transcription : segment i/total…`); join " " + collapse whitespace; all-empty (markers stripped) → "Aucune parole détectée dans le fichier audio."; temp dir rmSync recursive+force in finally.
  - extractText gains optional 3rd param onProgress, new "epub" branch (method "EPUB — N chapitre(s) extrait(s)", pages null) and "audio" branch (method "Transcription audio (ASR) — N segment(s)").
- src/lib/doc-dto.ts (NEW): getDocumentDetailDTO(id) — DocumentDetailDTO mapper identical to the frozen [id]/route.ts logic (no auto-heal), used by save-pdf only.
- src/app/api/documents/route.ts: extractText call passes onProgress → agent.log events on "reader" (same emit pattern); upload size guard now 80 MB for audio kind / 25 MB otherwise (dynamic message); invalid-format message lists EPUB + audio formats; after extraction, OCR image kinds (png/jpg/jpeg/webp) create with status "à vérifier" and note "Extraction : {method} — vérifie les mots mal reconnus avant d'enregistrer en PDF." (+ " Peu de texte détecté — la photo est-elle nette et complète ?" when text < 40 chars); other kinds keep "prêt". ingest.done DTO unchanged (status field already in contract).
- NEW POST src/app/api/documents/[id]/save-pdf/route.ts (runtime nodejs, force-dynamic): validates id (safe-char regex) + {text} non-empty (400 FR) + doc exists (404); step order per spec: 1) chunkText re-chunk in $transaction (deleteMany chunks → update doc {textContent, chars, chunks, kind "pdf", status "prêt", fileName `${sanitized title}.pdf` [strip non \p{L}\p{N}/space/dash, collapse spaces, ≤80, ".pdf", fallback "cours.pdf"], note "Texte corrigé par l'élève — PDF généré."} → createMany chunks) → 2) buildCoursePdf (pdf-lib: A4 595.28×841.89, margins 56, Helvetica + Helvetica-Bold, title bold 18 wrapped, subject + fr-FR date line 10 pt gray, body 11 pt / line height 16, font-measured greedy word wrap (≈95 chars) with hard-slice for pathological tokens, blank \n → 8 pt spacing, page break under margin, 200-page cap + bottom "... (tronqué)" note, WinAnsi sanitization: curly quotes/apostrophes→', dashes→-, …→..., nbsp→space, bullet→-, tab→2 spaces, then drop chars outside CP1252 set — French accents « » é è ç pass through) → 3) fs.writeFileSync /home/z/my-project/upload/documents/{id}.pdf (mkdir recursive) → 4) invalidateSearchCache() → 5) 200 DocumentDetailDTO via doc-dto helper. PDF-gen failure → 500 FR (DB already committed per specified order).
- NEW GET src/app/api/documents/[id]/pdf/route.ts: safe-id + doc lookup → 404 {message "PDF non encore généré pour ce cours."} if doc/file missing; serves upload/documents/{id}.pdf with Content-Type application/pdf, Content-Disposition inline (ASCII fallback filename + filename*=UTF-8''), Content-Length, Cache-Control no-store.
- No changes to: types.ts, prisma schema, documents/[id]/route.ts (auto-heal untouched), sse-client, api-client, frontend files. Dev server not restarted.

Verified with curl (hot-reload server :3000):
- EPUB (hand-built minimal 2-chapter epub via zip CLI: mimetype stored, container.xml, OPF w/ manifest+spine incl. nested OEBPS/text/ch2.xhtml + css item + <script>): SSE ingest.done {kind "epub", chars 358, note "Extraction : EPUB — 2 chapitres extraits", status "prêt"}; detail textContent contains both chapters with entities decoded (— – é è ê ' « », &amp;→&), script/style/head stripped, <br>/<li> → newlines.
- Audio: /api/tts French text → speech.wav (RIFF PCM 24 kHz) upload → SSE reader logs "Transcription : segment 1/1…", ingest.done {kind "audio", note "Extraction : Transcription audio (ASR) — 1 segment"}, textContent non-empty (ASR output mangled by the engine but pipeline end-to-end OK). ffmpeg sine 440 Hz → hallucinated tiny text → clean ingest.error at chunker ("Aucun texte exploitable après découpage."). speech.mp3 (different ext) → same pipeline OK.
- PNG (sharp SVG→PNG): ingest.done {kind "png", status "à vérifier", note "Extraction : OCR (vision) — vérifie les mots mal reconnus avant d'enregistrer en PDF."} (201 chars → no short-text hint, as designed).
- save-pdf on that doc: 200 DocumentDetailDTO {kind "pdf", status "prêt", fileName "Maths - Les fractions photo.pdf", note "Texte corrigé par l'élève — PDF généré.", chunks re-counted, textContent updated}; file exists (1417 o); GET …/pdf → 200 application/pdf, content-length 1417, bytes identical (cmp OK), pdftotext shows title/subject-date/accents; 400 empty text, 404 unknown doc, 404 PDF never generated (FR messages); long-doc tests: 303 k chars → 67 pages 1.1 s; 960 k chars → exactly 200 pages + "(tronqué)" 1.8 s.
- GET /api/documents list shows new kinds (epub/audio/pdf→pdf) + updated notes; /api/stats chunks 235 after re-chunks; unsupported .rtf → new formats message. bun run lint: PASS (0 errors, 0 warnings). dev.log: only 200/400/404 as designed, no compile/runtime errors from task files.

Stage Summary:
- Ingestion now covers PDF, DOCX, EPUB (regex-parsed OPF/spine), TXT/MD, images (OCR) and 7 audio formats (ffmpeg 7-min 16 kHz mono segments → built-in ASR, per-segment progress + fault tolerance) — extractText(files, buffer, onProgress?) streams progress into the Lecteur agent.
- Scanned/photo imports land as status "à vérifier" with a proof-read note; the student corrects text → POST /api/documents/[id]/save-pdf re-chunks (same chunkText), stores kind "pdf"/status "prêt"/sanitized fileName/note, writes a clean A4 Helvetica PDF (accents-safe WinAnsi, 200-page cap) to upload/documents/{id}.pdf, invalidates BM25 cache, returns the detail DTO; GET /api/documents/[id]/pdf serves it inline.
- Files: modified src/lib/ingestion.ts, src/app/api/documents/route.ts; created src/lib/doc-dto.ts, src/app/api/documents/[id]/save-pdf/route.ts, src/app/api/documents/[id]/pdf/route.ts.
- Deviations: (1) ExtractResult.note doesn't exist — shape is {text, pages, method}, so the EPUB count lives in method → route note "Extraction : EPUB — N chapitres extraits" (spec's "adapt to the actual shape"); (2) audio upload limit raised to 80 Mo at the route guard for audio kinds only (otherwise the 80 MB extractText guard was unreachable behind the 25 MB check); (3) entity decoding extended beyond the listed set with ~40 common French/Latin-1 named entities (strict superset, same single-pass decode, &amp; last); (4) pdf line wrap uses font.widthOfTextAtSize (≈95 chars/line at 11 pt) instead of a hard 95-char cut so lines never overflow the margin; short-OCR hint threshold is text.trim().length < 40.

---
Task ID: 2-d
Agent: full-stack-developer (recovered by main — agent hit context deadline after implementation, before verification/worklog)
Task: Frontend — audio reader UX (auto-select, preparation state), new import formats UI, scanned-doc correction dialog + save-as-PDF flow

Work Log:
- revision-section.tsx: auto-select most recent doc on mount when none selected (line ~430), "Préparation du document pour la lecture…" loading state (line ~990), error Alert + Réessayer in audio card, empty-text hint.
- documents-section.tsx: accept = pdf,docx,txt,md,epub,png,jpg,jpeg,webp,mp3,wav,m4a,ogg,webm,aac,flac; format hint "PDF, DOCX, TXT, EPUB, MP3/WAV (transcrit), PNG/JPG (OCR) — 80 Mo max"; kind badges (EPUB=BookOpen, Audio=AudioLines amber, Image, PDF); status "à vérifier" amber PenLine badge (clickable → review dialog); post-ingest auto-open of ReviewDialog when doc.status === "à vérifier"; menu actions "Corriger le texte (OCR)" + "Ouvrir le PDF" (blob fetch + object URL, French error toast if 404).
- review-dialog.tsx created: editable textarea pre-filled with OCR textContent (fetched via fetchDocumentDetail), amber OCR explanation alert, [Enregistrer en PDF] (savePdf → toast → onDocumentsChanged + onImported(updatedDoc) → Révision greet), [Enregistrer sans PDF] (updateDocument), [Plus tard].
- api-client.ts: savePdf(id, text) + fetchDocumentPdf(id) → Blob appended.
- Main agent verified all pieces present + lint PASS after timeout.

Stage Summary:
- All frontend deliverables landed; E2E done by main (Task 4 below).

---
Task ID: 4
Agent: main (Z.ai Code)
Task: Audio repair (legacy docs), E2E verification of new formats + scanned flow, mobile fix, cleanup

Work Log:
- AUDIO BUG ROOT CAUSE: 3 legacy PDFs (pre-textContent column) had textContent="" → play button disabled (disabled={detail.textContent.trim().length===0}). FIX: auto-heal in GET /api/documents/[id] — rebuilds textContent from ordered chunks on first open and persists it. Verified: Doctrines Bibliques 0 → 85 159 chars; play → "Segment 1 / 666", POST /api/tts 200 (487 KB wav); button ACTIVÉ on desktop + auto-select most recent doc.
- EPUB E2E (UI): "Les Volcans (EPUB)" uploaded → "Extraction : EPUB — 2 chapitres extraits" → auto-redirect Révision + greet. EPUB badge in list.
- AUDIO E2E: TTS-generated French speech mp3 uploaded → ASR transcription "segment 1/1 — texte extrait", doc kind audio, 268 chars, révisable/TTS-able like any course.
- SCANNED FLOW E2E (UI): PNG (mitose, sharp-rendered text) → VLM OCR → status "à vérifier" → ReviewDialog auto-opens → corrected text → "Enregistrer en PDF" → doc kind pdf/status prêt/fileName "La Mitose scan.pdf"/note "Texte corrigé par l'élève — PDF généré", chunks re-indexed BEFORE response, upload/documents/{id}.pdf (1210 B, PDF 1.7) served via GET /pdf HTTP 200 → auto-redirect Révision with greet. Agents "pris connaissance" avant la fin de sauvegarde ✓.
- "Ouvrir le PDF": menu item present for kind pdf; underlying fetch verified HTTP 200 application/pdf (Radix menu closes between evals — tooling limitation, code path + API verified).
- MOBILE FIX: horizontal overflow (scrollW 464) caused by folder-bar header span "— filtré sur « … »" not shrinking → added min-w-0/flex-wrap/truncate. Re-verified scrollW=375.
- CLEANUP: deleted 7 agent test docs; kept 9 (3 new-format demos + user courses).
- bun run lint PASS; dev.log clean; console errors 0.

Stage Summary:
- Audio fixed everywhere incl. legacy docs (auto-heal on course open = "il parcourt le document pour la lecture" as requested).
- New formats live: EPUB (chapters), audio mp3/wav/m4a/ogg/webm/aac/flac (ffmpeg split → ASR), scanned/handwritten images (OCR → human correction → clean PDF → agents indexed → revision starts).
- Demos kept: Les Volcans (EPUB), Les Séismes (audio), La Mitose (scan→PDF corrigé), The Water Cycle (EN).

---
Task ID: 4
Agent: main (Z.ai Code)
Task: Voix TTS françaises (accent) + moteur voix système + testeur + Agnes configurable + Assistant (banque QCM, suppression historique, rubrique Réponses, Tab=envoyer)

Work Log:
- Test objectif des 7 voix serveur Z.ai en français : synthèse FR → re-transcription ASR → proxy WER. Toutes anglophones (76–100 % d'erreur) ; classement : chuichui < tongtong < jam < … (la meilleure reste médiocre en FR).
- types.ts : TtsEngine ("auto" | "system" | "serveur"), TTS_SAMPLE_TEXT, BIBLE_REF_PATTERN, descriptions TTS_VOICES honnêtes réordonnées, AgnesConfig.
- tts.ts : autoVoice(fr) → chuichui (meilleure mesurée), en → jam.
- use-tts-player.ts réécrit : moteur "system" via Web Speech API (voix FR natives de l'OS : Amélie/Hortense/Google…), tri qualité des voix, attente voiceschanged, pause/resume/stop, repli automatique sur la voix serveur si aucune voix système, engineUsed + voiceLabel exposés.
- settings-section.tsx : TtsPrefs.engine (LS ad_tts_engine), sélecteur « Moteur de lecture » avec explication accent, détection + libellé de la voix système (getSystemVoiceLabel), deux boutons test : « Tester la voix système » (SpeechSynthesis) et « Tester la voix serveur » (POST /api/tts, échantillon TTS_SAMPLE_TEXT).
- revision-section.tsx : engine passé aux 3 sites player.play (bouton Écouter, autoread coach, Réessayer).
- Bug « bouton lecture désactivé » : confirmé corrigé en E2E (auto-heal textContent existant côté GET /api/documents/[id] ; le bouton devient actif et charge tout le document, ex. Segment 1/974).
- Banque QCM → Assistant : lib/exam.ts matchQcmBank() (tokenisation FR partagée, overlap ≥ 0.22, top 3) ; agents.ts consulte la banque dans les DEUX modes, émet qcm.hit, injecte <banque_qcm> au Solveur, persiste qcmSources + category (classifyCategory : « Examens & QCM » > subject du cours > « Théologie & Bible » > « Général »).
- ChatMessage : colonnes category + qcmSources (db push) ; /api/chat GET (100 derniers, category/qcmSources), DELETE (efface tout) ; ChatEvent.qcm.hit + pipeline.done{qcm,category}.
- assistant-section.tsx : QcmBankCard (bonne option sur FOND VERT + ✓, refs 📖, score), cartes dans la réponse en cours + dans l'historique ; bascule Historique / Réponses par catégorie avec recherche ; bouton « Effacer tout l'historique » (AlertDialog) ; Tab = envoyer (Maj+Tab intact, Ctrl+Entrée conservé).
- Agnes : llm.ts dynamique (getAgnesConfig/saveAgnesConfig via AppSetting "agnes_config" par-dessus les env), serveur URL + modèle + style d'auth éditables ; /api/keys GET expose agnesConfig + serverReady dynamique ; /api/keys/save et /api/keys/test (route créée — elle manquait, le bouton Tester était en 404 !) acceptent agnesConfig ; carte Paramètres avec URL/modèle/auth style.

Stage Summary:
- L'accent français est résolu par les voix SYSTÈME du navigateur (accent natif réel) ; les voix serveur restent en repli avec la meilleure (chuichui) par défaut et un testeur d'écoute pour choisir.
- L'Assistant retrouve les réponses d'examens déjà traitées (fond vert sur la bonne option) et l'historique est gérable (effacement + rubrique par catégories + recherche).
- Agnes est entièrement configurable depuis l'UI ; bug latent /api/keys/test 404 corrigé.

---
Task ID: 5
Agent: main (Z.ai Code)
Task: Page « Examens » — import, association aux cours, résolution par les agents, réf. bibliques, QCM manuel, chat au fil de l'exercice

Work Log:
- Prisma : Exam (rawText, kind, linkStatus, documentIds JSON, theology), ExamQuestion (type, prompt, options JSON, answer, refs JSON, rationale), ExamMessage (role, content, refs) + AppSetting ; db push OK.
- lib/exam.ts : parseExamText (LLM JSON strict + fallback regex Q1/A) B)), detectTheology (mots-clés FR), extractBibleRefs (regex livres FR), retrieveForExam (BM25 restreint aux cours liés), solveExamQuestion (Résolveur JSON {answer,refs,rationale} + consigne théologie : réf. bibliques TOUJOURS, même non demandées ; Vérificateur fusionne refs LLM + regex), matchQcmBank, classifyCategory, runExamChat (historique + résumé questions/réponses + retrieval).
- Routes : /api/exams (GET liste, POST JSON/multipart via extractText : PDF/DOCX/TXT/MD/images OCR/audio ASR/EPUB), /api/exams/[id] (GET détail, DELETE), …/parse (SSE 📋 Examinateur), …/link (association, vide = sans), …/solve (SSE toutes ou une question : 🔍→✍️→🧾, question.answered par question), …/questions (QCM manuel), …/chat (SSE au fil de l'exercice, messages persistés).
- exams-section.tsx (~1500 lignes) : import (coller/fichier), parse auto → dialog d'association (« Les agents ont une question… ») → résolution automatique une fois validé ; liste d'examens (badges kind/théologie/cours liés/5-5, suppression) ; détail : progression, cartes questions (QCM avec BONNE OPTION SUR FOND VERT + ✓ Bonne réponse, refs 📖 ambre, rationale, Écouter la question), agents en direct, « Ajouter une question » (QCM manuel A-H), chat au fil de l'exercice (Tab/Ctrl+Entrée pour envoyer) ; épinglé responsive (lg:grid-cols-[320px_1fr]), footer collé.
- app-header/page.tsx : onglet « Examens » (ClipboardCheck) entre Révision et Assistant.
- Fix lint : boucle infinie évitée (player.stop stabilisé via stopPlayer dans les deps), dialog d'association remonté par key au lieu de setState-in-effect.
- E2E navigateur : import d'un examen théologie 4 questions → theology=True, subject auto ; liaison à 2 cours RBIF → résolution : Q1 B. Pierre (Luc 22:54-62…), Q2 visions d'Ézéchiel (Ézéchiel 1:4-28), Q3 B. Antioche (Actes 11:26), Q4 Agapè (1 Cor 13:4-7) — réf. bibliques systématiques ; QCM manuel 27 livres NT → C. 27 ; chat : Actes 11:26 confirmé ; Assistant : banque QCM hit score=1, catégorie « Examens & QCM », fond vert ✓ ; Tab-send OK ; suppression historique → 0 ; Révision : bouton Écouter actif, Segment 1/974, lecture réelle (logs [tts] cache MISS voix chuichui).

Stage Summary:
- Données de démo laissées en base : « Examen de théologie biblique — Session 2026 » (5 questions résolues avec références), lié à « Doctrine Biblique » et « La Personne du Saint-Esprit ».
- Vision candidats libres posée : cours + examens + banque QCM + mémoire agents = révision complète d'un programme.
