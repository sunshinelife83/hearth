# DevSpace X — Architecture Decision Records (المرحلة الأولى من التنفيذ)

هذه ADRs موثقة لقرارات اتُّخذت فعليًا أثناء تنفيذ المرحلة الأولى على فرع `devspace-x`. كل قرار يتبع تعارضًا بين الخطة المعتمدة وواقع الكود، أو يحسم خيارًا معماريًا جديدًا.

---

## ADR-013: بوابة سياسة الأوامر بأربع رتب + أوضاع تنفيذ
- **Status:** accepted (2026-09-06)
- **Context:** كل أمر shell كان يُنفَّذ بصلاحيات المستخدم كاملة بلا أي بوابة (SEC-01/06). لا يوجد approval channel متزامن عبر MCP stateless.
- **Decision:**
  - مصنّف ثابت `classifyCommand` (regex conservative) برتب: 0 فحص، 1 عمل داخلي، 2 مؤثر خارجيًا، 3 محظور دائمًا (`src/policy/command-policy.ts`).
  - أوضاع للتنفيذ من config: `readonly | supervised (الافتراضي) | autonomous`. tier-2 في supervised يتطلب claim صريح `approvedByUser` من النموذج (بعد موافقة بشرية في المحادثة) ويُسجَّل كـ `policy_decision` في الـ audit. tier-3 محظور في كل الأوضاع بلا استثناء — لا يوجد مسار موافقة له.
  - البوابة واحدة `enforceShellPolicy` وتستدعى من `exec_command` و`bash` قبل أي spawn.
- **Consequences:** الرفض يعود للنموذج كنص إرشادي (يتصحح ذاتيًا)؛ التصنيف ثابت-speed bump وليس حدًّا أمنيًا نهائيًا — الحد الحقيقي: env allowlist (ADR-014) والجذور (ADR-015) والـ sandbox لاحقًا.
- **Rejected:** موافقة متزامنة عبر elicitation (لا يدعمه ChatGPT اليوم)؛ وضع trusted مع tier-3 (هجمات التدرج).

## ADR-014: فلترة بيئة العمليات للـ shell tools فقط
- **Status:** accepted
- **Context:** `processEnvironment` كانت تمرر `process.env` كاملًا لأوامر النموذج — قناة سرقة أسرار (SEC-02).
- **Decision:** أوامر الـ shell tools ترث allowlist (`PATH, HOME, SHELL, XDG_*, proxies, Windows essentials` + `DEVSPACE_WORKSPACE_*` + `DEVSPACE_ORIGIN`). Escape hatch: `execution.envAllowAll` أو `envAllowlist` إضافية.
- **قرار الحدود:** adapters الوكلاء (codex/claude/…) تُبقي env كاملًا عن قصد — فهي برامج المطور نفسه وتحتاج اعتمادياتها، ومسارها محمي بفرض الجذور (ADR-015) وبموثوقية OS.
- **Consequences:** أوامر تحتاج متغيرًا خارج القائمة تُمرَّر inline (`KEY=x cmd`) أو عبر config.

## ADR-015: إغلاق SEC-04 — الجذور تُفرض على كل المسارات
- **Status:** accepted
- **Context (تعارض خطة/كود):** `LocalAgentManager.authorizeWorkspace` تخطى فحص `allowedRoots` عندما يغيب `workspaceId`. الاختبار القائم `directOutside` كان *يوثّق* هذا السلوك كميزة CLI.
- **Decision:** الفحص يُفرض دائمًا عندما تكون `allowedRoots` مهيأة، لأي مستدعي (MCP/CLI/daemon). إضافةً: أوامر shell المسروعة من DevSpace تحمل `DEVSPACE_ORIGIN=devspace-shell`، و`devspace agents` يرفض العمل من داخلها بلا `DEVSPACE_WORKSPACE_ID` — يغلق تجاوز "النموذج يشغّل CLI بنفسه".
- **Consequences (breaking):** CLI على مشروعات خارج `allowedRoots` يفشل الآن — العلاج: أضف المجلد إلى `workspaces.allowedRoots`. الاختبار القائم حُدِّث ليعكس الجديد. **هذا قرار مقصود موثق وليس انزلاقًا.**

## ADR-016: Snapshots على git object model، قبل tier-2 في autonomous
- **Status:** accepted
- **Decision:** `refs/devspace/snapshots/<ws>/<epochMs>` عبر temp-index (نمط review-checkpoints). Rollback = diff بين شجرة snapshot الحالية والهدف + `git apply --binary` — لا يمس HEAD/branches. أدوات MCP: `create_snapshot/list_snapshots/rollback_snapshot` (rollback يخضع لبوابة tier-2).
- **قرار حاسم:** الالتقاط قبل tier-2 في autonomous **best-effort** — فشل snapshot (مثل workspace بلا git) يسجل `snapshot_failed` ويستمر التنفيذ. السبب: جعل autonomous يتطلب snapshots كست حظه على مشاريع غير-git. الربط الإلزامي يأتي مع sandbox adapters.
- **حد معروف:** ملفات .gitignore لا تُلتقط ولا تُستعاد.

## ADR-017: دورة حياة الوكلاء الكاملة فوق daemon protocol v4
- **Status:** accepted
- **Context:** تصحيح #5 (start/status/output/send/pause/resume/stop/cancel) مقابل واقع: لا إلغاء لكل وكيل، والإخراج يُخزَّن عند اكتمال الدورة فقط (B-13).
- **Decision:**
  - البروتوكول → v4 بثلاث طرق: `agent.pause/agent.resume/agent.stop` (+ `force`). `cancel` = `stop{force:true}`. `output` عبر `agent.get` (الحقل الجديد `latestOutput`).
  - حالة جديدة `paused` + migration 7 (`latest_output`، ذيل 64KB).
  - إلغاء لكل وكيل: `LocalAgentRuntimePool.cancelRuntimeKey(key)` — يغلق الـ runtime فورًا؛ سبب الإغلاق `agent_cancelled` يتجاوز انتظار الجولات النشطة (كان يسبب deadlock).
  - بث الإخراج: `onOutput` callback عبر Runtime/pool إلى المخزن؛ مُفعّل في ACP (chunk stream) وCodex (عناصر agentMessage) وClaude (assistant deltas). **Pi وOpenCode يظهران الإخراج عند اكتمال الدورة فقط** — قيد مزود موثق، لا حاجب.
  - إيقاف أثناء دورة ناجحة لا يعيد الحالة إلى idle: مسار النجاح يحترم `interruptedAgents`.
- **Consequences:** "pause" = إيقاف مع الحفاظ على `providerSessionId` والاستئناف بجولة جديدة (المزودون لا يدعمون إيقافًا حرفيًا داخل دورة).

## ADR-018: تحصين OAuth — CSRF مرتبط بالحقول + rate limits
- **Status:** accepted
- **Decision:**
  - توكن CSRF = HMAC-SHA256 بمفتاح مشتق من owner token فوق الحقول الخفية — stateless وغير قابل للتزوير، مع `X-Frame-Options: DENY` و`frame-ancestors 'none'` على صفحة الموافقة (SEC-07).
  - حد معدل sliding-window بالعملية (`src/rate-limit.ts`): /authorize 20/sa/IP، /register 30/sa/IP، /token 120/sa/IP، وفشل owner password 8/sa/IP مع reset عند النجاح (SEC-03). مفاتيح IP تتبع `trustProxy` — **بدون tunnel حقيقي لا يمكن تزوير المفاتيح**؛ مع tunnel فعّل `server.trustProxy`.
  - Dynamic client registration يبقى مفتوحًا (متطلب MCP) لكنه مقيد بالحصة.
- **Known trade-off:** بدون trustProxy خلف tunnel تتشارك جميع العملاء مفتاح IP واحد (fail-closed).

## ADR-019 (تعديل اعتماد): أهداف التصحيحات العشرة على الخطة
- **Status:** accepted
- **المحتوى:** حذف Local Models/ModelRouter من النطاق (تصحيح #1) — Agent Runtime ينسق عوامل خارجية (CLI agents عبر daemon) وعملاء MCP خارجيين يقودون الحلقة؛ MCP هو الواجهة المعيارية (تصحيح #3)؛ أولوية التنفيذ: Security → MCP interop → Agent capabilities → Reliability → Performance → DX (تصحيح #10). السلوك الحالي لا يخالفها: لا يوجد أي كود نماذج محلية في المستودع، والـ P5 الأصلي (ModelRouter) أُسقط من خارطة الطريق.

---

## خارطة ما بقي (مقابل الخطة المعتمدة)
| المرحلة | الحالة |
|---|---|
| P0 stability/security fixes | **منفذة** (node range, .env.example, init --force rotation, auth atomic, drain timeout, daemon spawn listener, codex version, CI build step, CSRF+frame, rate limits) |
| P1 policy core (tiers + modes + env allowlist + audit) | **منفذة** |
| Snapshots + rollback + أدوات MCP + autonomous auto-snapshot | **منفذة** |
| Agent lifecycle كامل + أدوات MCP + SEC-04 | **منفذة** |
| P2 stdio transport + device tokens + فصل issuer | قادمة |
| P3 Task state machine كاملة + Verification gates | جزئي (Snapshots جاهزة كأساس) |
| P4 sandbox adapters (bwrap/seatbelt) + probing | قادمة |
| P6 Context Engine | قادمة |
