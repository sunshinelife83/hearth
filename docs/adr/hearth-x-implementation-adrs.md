# Hearth — Architecture Decision Records (المرحلة الأولى من التنفيذ)

هذه ADRs موثقة لقرارات اتُّخذت فعليًا أثناء تنفيذ المرحلة الأولى على فرع `hearth-x`. كل قرار يتبع تعارضًا بين الخطة المعتمدة وواقع الكود، أو يحسم خيارًا معماريًا جديدًا.

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
- **Decision:** أوامر الـ shell tools ترث allowlist (`PATH, HOME, SHELL, XDG_*, proxies, Windows essentials` + `HEARTH_WORKSPACE_*` + `HEARTH_ORIGIN`). Escape hatch: `execution.envAllowAll` أو `envAllowlist` إضافية.
- **قرار الحدود:** adapters الوكلاء (codex/claude/…) تُبقي env كاملًا عن قصد — فهي برامج المطور نفسه وتحتاج اعتمادياتها، ومسارها محمي بفرض الجذور (ADR-015) وبموثوقية OS.
- **Consequences:** أوامر تحتاج متغيرًا خارج القائمة تُمرَّر inline (`KEY=x cmd`) أو عبر config.

## ADR-015: إغلاق SEC-04 — الجذور تُفرض على كل المسارات
- **Status:** accepted
- **Context (تعارض خطة/كود):** `LocalAgentManager.authorizeWorkspace` تخطى فحص `allowedRoots` عندما يغيب `workspaceId`. الاختبار القائم `directOutside` كان *يوثّق* هذا السلوك كميزة CLI.
- **Decision:** الفحص يُفرض دائمًا عندما تكون `allowedRoots` مهيأة، لأي مستدعي (MCP/CLI/daemon). إضافةً: أوامر shell المسروعة من Hearth تحمل `HEARTH_ORIGIN=hearth-shell`، و`hearth agents` يرفض العمل من داخلها بلا `HEARTH_WORKSPACE_ID` — يغلق تجاوز "النموذج يشغّل CLI بنفسه".
- **Consequences (breaking):** CLI على مشروعات خارج `allowedRoots` يفشل الآن — العلاج: أضف المجلد إلى `workspaces.allowedRoots`. الاختبار القائم حُدِّث ليعكس الجديد. **هذا قرار مقصود موثق وليس انزلاقًا.**

## ADR-016: Snapshots على git object model، قبل tier-2 في autonomous
- **Status:** accepted
- **Decision:** `refs/hearth/snapshots/<ws>/<epochMs>` عبر temp-index (نمط review-checkpoints). Rollback = diff بين شجرة snapshot الحالية والهدف + `git apply --binary` — لا يمس HEAD/branches. أدوات MCP: `create_snapshot/list_snapshots/rollback_snapshot` (rollback يخضع لبوابة tier-2).
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

---

## ADR-020: نقل MCP محلي عبر stdio + توكنات الأجهزة
- **Status:** accepted (2026-09-06، المرحلة الثانية)
- **Decision:** أمر `hearth mcp` يشغّل نفس سطح الأدوات عبر StdioServerTransport — بلا HTTP ولا OAuth (العميل عملية أطلقها المستخدم بنفسه). نفس النواة: policy gate، workspaces، snapshots، agent tools، task tools — بالبناء المشترك `buildLocalMcpServer`.
- **device tokens:** للعملاء المحليين عبر HTTP/LAN الذين لا يدعمون تدفق OAuth: `hearth token create/list/revoke` — توكن يُعرض مرة واحدة، يُخزَّن hashed (migration 8)، يمنح نفس صلاحية scope `hearth` ويُربط بمورد الخادم في verifyAccessToken.
- **issuerMode:** `derived` (افتراضي، سلوك اليوم) أو `local` — يثبّت هوية OAuth على العنوان المحلي بحيث لا يكسر تغيير tunnel هوية العملاء (للنشر المحلي/LAN فقط؛ العملاء البعيدون يحتاجون derived).

## ADR-021: Task Runtime — آلة حالة دائمة وبوابات تحقق غير قابلة للتحايل
- **Status:** accepted
- **Decision:**
  - جدول `tasks` (migration 9) + آلة حالة محروسة: planning → executing → verifying → {completed | repairing} → …؛ انتقال غير شرعي = `TaskTransitionError`.
  - **الإكمال حكم نظام لا ادعاء نموذج:** `task_complete` يشغّل بوابات التحقق المكتشفة (package.json/Cargo/go/pyproject/Makefile) قبل أي حالة `completed`؛ `verified_complete` فقط بعد نجاح كل البوابات؛ `model_complete` ممكنة صراحةً فقط عبر `acceptUnverified: true` عند غياب أي بوابات (مُدقَّقة كـ evidence kind=model_claim).
  - **قاعدة مانعة للتحايل (اكتشفتها الاختبارات):** البوابة الفاشلة تبقى في مجموعة التحقق حتى تنجح — `task_complete` من حالة `repairing` يُرفض، و`task_verify` يعيد البوابات الفاشلة سابقًا دائمًا مع أي بوابات جديدة. لا يمكن "تبديل" بوابات فاشلة بأخرى أسهل.
  - Crash recovery: عند الإقلاع، المهام in-flight (executing/verifying/repairing) تُعلَّم failed بسبب صريح — العميل يعيد إنشاءها أو استئنافها بوعي.
  - Budget: سقف زمني للمهمة (30 دقيقة افتراضيًا) يفشل المهمة عند التجاوز.
- **Consequences:** أدوات MCP: `task_create/task_plan/task_status/task_list/task_verify/task_complete/task_cancel`. بوابات التحقق تمر عبر نفس بوابة السياسة (readonly يمنع التحقق — موثق).

## ADR-022: Sandbox adapters — best-effort بقدرات معلنة
- **Status:** accepted
- **Decision:** `probeSandboxAdapter` (مرة لكل عملية): bubblewrap على Linux، seatbelt (sandbox-exec) على macOS، none غير ذلك. الوصفة: bwrap = ro-bind للجذر + rw للمساحة + tmpfs لـ /tmp و/run (+ `--unshare-net` عند sandboxNetwork=deny)؛ seatbelt = ملف تعريف يمنع الكتابة خارج الـ workspace و/tmp.
- **متى يُطبَّق:** الوضع `autonomous` فقط افتراضيًا (auto)، وأوامر التحقق ضمنه؛ `execution.requireSandboxForAutonomous: true` يحوّل غياب الـ sandbox إلى رفض لـ tier-2 في autonomous.
- **حدود موثقة:** Windows بلا adapter (الحاوية هي المسار الموصى به لاحقًا). profile seatbelt تقريبي وليس عزلًا صارمًا. (ملاحظة الجولة الثالثة: قيد `bash` عبر Pi أُغلق في ADR-024 — كل الأسطح تمر الآن عبر `ProcessSessionManager`.)

## ADR-023: Context Engine — الشريحة الأولى (خريطة مستودع + بحث)
- **Status:** accepted
- **Decision:** `context_overview` (خريطة محلية حتمية: ملفات/لغات/manifests/أكبر مجلدات، مع استبعاد dependencies وحدود 5000 ملف) و`search` (ripgrep عند التوفر وإلا grep -E، argv array بلا shell، مهلة 10 ثوان، سقف إخراج 40KB، استبعاد node_modules/.git).
- **Consequences:** لا embeddings ولا شبكة — الأساس الدلالي (ONNX محليًا) يبقى في P6 اللاحقة فوق هذه الواجهة.

## ADR-024: إغلاق مسار bash الجانبي + إصلاح تغليف sandbox في pipe spawn
- **Status:** accepted (2026-09-07، الجولة الثالثة)
- **Decision:**
  - سطح claude `bash` لم يعد يستخدم `runShellTool` (Pi SDK spawn) — ينفّذ الآن عبر `ProcessSessionManager` مثل كل أدوات shell: بوابة `enforceShellPolicy` + `sandboxDecision` + قائمة بيئة + `commandWrapper` + سجل العمليات. `runShellTool` حُذفت.
  - اكتُشف أثناء الاختبار E2E أن `startPipe` كان يستخدم خيار `shell:` في `spawn` — Node يلحق `-c <command>` بأي executable يُعطى له، فكان `bwrap` يستقبل `-c` كخيار له (`bwrap: Unknown option -c`). الإصلاح: spawn مباشر `spawn(shell.executable, shell.args)` — `resolveShellCommand` يضمّن الأمر أصلًا — مع فاصل `--` قبل الأمر في وصفة bwrap حتى لا يبتلع bwrap وسائط shell مثل `-lc`.
  - مسار PTY كان صحيحًا أصلًا (`nodePty.spawn(executable, args)`).
- **Consequences:** كل تنفيذ أوامر — MCP/agent/claude/codex/tasks — يمر بنفس الحد الأمني. لا special paths.

## ADR-025: صلاحيات مستقلة لكل workspace (profiles)
- **Status:** accepted (2026-09-07، الجولة الثالثة)
- **Decision:**
  - `workspaces.profiles[]`: `{ path, mode?, sandbox?, sandboxNetwork?, requireSandboxForAutonomous?, commandAllow[], commandDeny[], agentsAllowed? }` — المطابقة بأطول بادئة مسار، والباقي يرث الإعدادات العامة. إعداد workspace واحد لا يمنح شيئًا لغيره.
  - `resolveExecutionForWorkspace` هو المصدر الوحيد للحقيقة؛ `enforceShellPolicy` و`sandboxDecision` وبوابات التحقق (`runGate`) وأدوات الوكلاء وأغلفة الأوامر كلها تحلّ عبره (مع `workspaceRoot` صريح).
  - `commandDeny` يفوز دائمًا؛ `commandAllow` غير الفارغة تقيّد؛ regex غير صالح = رفض مغلق (fail-closed). أدوات الوكلاء: قراءة (`status/output/list`) تتطلب `agentsAllowed`، والكتابة (`start/send/pause/resume/stop/cancel`) تتطلب أيضًا وضعًا غير readonly — وتُرجع أخطاء أدوات `isError` لا protocol errors.
  - `task_create` يرث وضع الـ workspace؛ بوابات التحقق تخضع لقوائم الأوامر والسياسة الخاصة بالـ workspace.
- **Consequences:** مخطط JSON (`schema/v1/hearth.schema.json`) أُعيد توليده. اختبار `workspace-profiles.test.ts` يغطي العزل بين workspaces.

## ADR-026: تشديد Task Runtime — سقف إصلاح + استئناف
- **Status:** accepted (2026-09-07، الجولة الثالثة)
- **Decision:**
  - سقف حلقات الإصلاح: بعد 5 جولات تحقق فاشلة تُعلَّم المهمة `failed` (سبب صريح) بدل `repairing` للأبد — يُحسب من evidence `verifying → repairing` بلا migration.
  - أداة `task_resume`: تُعيد المهمة `failed` فقط إلى `planning` مع أثر تدقيق؛ `completed/cancelled` نهائية، والحية تستخدم الانتقالات العادية. هذا يعطي مسار استرداد صريح بعد `reconcileOnBoot` أو استنفاد ميزانية الإصلاح.
- **Consequences:** `task_verify`/`task_complete` الفاشلة تحترم السقف. الاختبارات تغطي السقف والاستئناف ورفض استئناف الحية.

## ADR-027: سجل العمليات + جامع اليتامى + ربط الوكلاء بالمهام
- **Status:** accepted (2026-09-07، الجولة الثالثة)
- **Decision:**
  - `process-journal.ts`: كل عملية حية تُسجَّل (`{ pid, pgid, workspaceId, workspaceRoot, commandPreview }`، وضع 0600) وتُحذف عند الخروج الطبيعي. عند الإقلاع (`server.ts` + `stdio-server.ts`) يُمسح السجل: PID الميت يُسقط، وPID المُعاد استخدامه (cmdline لا يطابق) لا يُقتل أبدًا — فقط المطابق يُنهى (group ثم مفرد) مع حدث تدقيق. المنصات بلا /proc/ps تُسقط بأمان دون قتل.
  - ربط الوكيل بالمهمة: `agent_start` يقبل `taskId?` + `correlationId?`؛ `taskId` مجهول = خطأ صريح قبل أي spawn؛ عند النجاح يُسجَّل evidence في المهمة عبر `linkAgentToTask` (مُصدَّرة ومُختبَرة وحدويًا). يتطلب `taskStore` اختياريًا في سياق أدوات الوكلاء (يُمرَّر من `createMcpServer`).
- **Consequences:** لا مزيد من العمليات اليتيمة الصامتة بعد crash/restart؛ ملكية الوكيل قابلة للاستعلام عبر evidence المهمة.

## ADR-028: طبقة التنسيق — briefs + lanes + watchdog + snapshot + scopes
- **Status:** accepted (2026-09-07، الجولة الرابعة — بمرجع delegate-skills كإلهام لا تبعية)
- **Decision:**
  - `src/orchestration/brief.ts`: brief مكتمل ذاتيًا للمهمات المرتبطة (taskId) — header آلي + caller prompt + plan + scope/safety (بلا commit) + ملخص repo-map (1000 ملف) + تعليمات الريبو كمقتبس غير موثوق + بوابات التحقق المكتشفة + الإخفاقات السابقة + عقد التقرير. حتمي ومحدود الحجم. التشغيلات ad-hoc تمرر الـ prompt كما هو.
  - `src/orchestration/result.ts`: `touchedFiles` عبر `git status --porcelain` (null خارج الريبو، [] للشجرة النظيفة) تُلحق بردود status/output، وevidence منظم `agent_result` عند الحالات المستقرة مع منع التكرار. تقرير النموذج وحده ليس دليلًا أبدًا.
  - `src/orchestration/lanes.ts`: lanes اختيارية (global + overlay للمشروع `.hearth/fleet.json` بموافقة hash تفشل مغلقةً عند التعديل). `agent_start(lane?)`: أعلام صريحة تفوز، وتناقض target/lane خطأ صريح، ومزود معطل خطأ مبكر. أدوات `fleet_status` (قراءة) و`fleet_approve` (موافقة مدققة). لا تبديل تلقائي للمزودين أبدًا.
  - Watchdog لكل turn (افتراضي 30 دقيقة، سقف 7 أيام، `AGENT_TIMEOUT` قابلة لإعادة المحاولة) + تنبيه stall استشاري من نبض `updatedAt` (5 دقائق) دون قتل تلقائي. الـ timeout يفوز على stop/pause المتزامن لأنه الأصدق.
  - Snapshot تلقائي قبل التفويض الكتابي (best-effort، لا يحجب أبدًا) + حارس تداخل النطاقات (sequential by default، `scopePaths`/`allowConcurrentWrites` صريحان، مسارات هاربة مرفوضة).
  - `requireSandboxForAutonomous` أصبح `true` افتراضيًا (fail-closed على Windows/بلا adapter) مع توثيق صراحة المنصات في `docs/security.md`.
- **Consequences:** أدوات جديدة `fleet_status/fleet_approve` في سطح claude/codex؛ `agent_start/send/resume` تقبل `timeoutMs`؛ `agent_start` تقبل `lane/scopePaths/allowConcurrentWrites` و`target` اختيارية مع lane. المفاهيم تبقى منفصلة: AI Client / MCP / Runtime / Orchestrator / Adapter / Session / Process / Task / Workspace / Policy / Sandbox / Verification / Transport.

## ADR-029: لوحة تحكم محلية (واجهة Hearth)
- **Status:** accepted (2026-09-07، واجهة محلية)
- **Decision:**
  - `hearth serve` يخدم واجهة ops-console في `/dashboard` (ملفات ثابتة بلا build، تُنسخ إلى `dist/dashboard` عبر `build:dashboard`) مع APIs تحت `/dashboard/api`.
  - المصادقة: دخول بكلمة مرور المالك يُصدر session cookie موقعة HMAC (12 ساعة، HttpOnly، SameSite=Lax) — التوكن نفسه لا يُخزن في المتصفح أبدًا. كل APIs المغيّرة تشترط JSON content-type (دفاع CSRF للـ fetch فقط)، والدخول محدود المعدل.
  - القراءة: status/workspaces/tasks/agents/snapshots/logs/setup — نفس الحالة المرئية لسطح MCP، بلا تنفيذ مميز خاص باللوحة. السجلات حلقة محدودة (200) خالية من الأسرار بالبناء.
  - الكتابة: `PUT /dashboard/api/config` بقائمة سماح ضيقة (execution.mode/sandbox/sandboxNetwork/requireSandbox + fleet.lanes + workspaces.profiles) مع تحقق zod، وتتطلب restart للتطبيق.
- **Consequences:** الواجهة مكملة لا بديلة — الوكلاء والمهام تُدار من عميل MCP، واللوحة للمراقبة والإعداد. مع tunneled host تبقى محمية بكلمة مرور المالك مثل بوابة OAuth.

## ADR-030: إعادة التسمية إلى Hearth + التعرض المباشر بلا relay
- **Status:** superseded by ADR-031 (2026-09-09)
- **Decision:**
  - الاسم الجديد Hearth في كل سطح هوية: ثنائيات `hearth`/`hearth-agentd`، حزمة النشر، `~/.hearth`، متغيرات `HEARTH_*`، المنفذ 7176، `hearth.sqlite`، `refs/hearth/`، نطاق OAuth‏ `hearth`.
  - لا يوجد تبنٍّ لإعدادات سابقة: التثبيت الجديد يبدأ من `hearth init`.
  - تعرض مباشر اختياري بلا relay: قسم `tls` (certFile/keyFile/acmeDir)، إنهاء HTTPS داخل `serve`، ومسار `/.well-known/acme-challenge/` لوضع certbot webroot. هوية ثابتة لكل PC (`hearth id`, ملف `machine.json` بوضع 0600) + أمر `hearth expose` التشخيصي الصادق: عنوان عام + حالة TLS + خطوات تالية مخصصة، مع التصريح الصريح بأن URL عام يتطلب مسار inbound ونطاقًا — لا سحر هنا.
- **Consequences:** أي منح OAuth صادرة عن نطاقات سابقة تحتاج إعادة موافقة. روابط schema تشير إلى مستودع `sunshinelife83/hearth`. النشر الأول على npm (`install.sh` يعمل من checkout حتى ذلك الحين).

## ADR-031: النفق حصريًا عبر ngrok — إسقاط Cloudflare والتعرض المباشر
- **Status:** accepted (2026-09-09 — supersedes the tunnel/direct-exposure parts of ADR-030)
- **Decision:**
  - المسار البعيد الوحيد: نفق ngrok مُدار لكل PC (`hearth ngrok setup` ثم `hearth serve --ngrok`). حُذف كود Cloudflare Tunnels كاملًا (الوحدة، الاختبارات، أوامر CLI، الإشراف) وحُذف التعرض المباشر (أمر `expose`، قسم `tls`، مسار ACME، إنهاء HTTPS).
  - الإعداد الجديد `tunnel: {provider: none|ngrok, domain}` في `config.jsonc` الحالي؛ الـ authtoken يبقى في إعداد ngrok نفسه ولا يُخزن في Hearth أبدًا.
  - مصدر الحقيقة للعنوان الحي: الـ agent API المحلي (`127.0.0.1:4040`)، وأي انحراف عن النطاق المحفوظ يفشل `serve` بصوت عالٍ بدل خدمة محلية مظلمة.
  - اللوحة وصفحة الهبوط مرفوضتان لنطاق النفق (404 حسب Host) ومتاحتان محليًا — بديل الترشيح المساري الذي كان يوفره cloudflared.
  - الإعدادات السابقة (قسم `tls` أو مفاتيح نفق قديمة) تُرفض بخطأ ترحيل صريح يوجه إلى `hearth ngrok setup` بدل تفريغ مخطط خام.
- **Consequences:** كسر مقصود لمرة واحدة — لا مسار ترحيل آلي من إعدادات النفق السابقة. النشر الأول أصبح `@sunshinelife83/hearth@1.0.0` ثم `1.1.0`/`1.2.0`.
