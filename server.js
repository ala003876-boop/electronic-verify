// server.js
const express = require("express");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public"))); // يخدم public/index.html

// ====== ENV ======
const {
  BASE_URL,
  CLIENT_ID,
  CLIENT_SECRET,
  BOT_TOKEN,
  GUILD_ID,
  APPROVED_ROLE_ID,
  UNAPPROVED_ROLE_ID,
  EXTRA_ROLE_ID,
  KEEP_ROLE_IDS,
  LOG_CHANNEL_ID
} = process.env;

if (
  !BASE_URL ||
  !CLIENT_ID ||
  !CLIENT_SECRET ||
  !BOT_TOKEN ||
  !GUILD_ID ||
  !APPROVED_ROLE_ID ||
  !UNAPPROVED_ROLE_ID
) {
  console.error("❌ نقص في متغيرات البيئة (Render ENV).");
  process.exit(1);
}

// ====== Helpers ======
function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach((part) => {
    const [k, ...v] = part.trim().split("=");
    if (!k) return;
    out[k] = decodeURIComponent(v.join("=") || "");
  });
  return out;
}

function setCookie(res, name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.httpOnly) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  if (opts.path) parts.push(`Path=${opts.path}`);
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  res.setHeader("Set-Cookie", parts.join("; "));
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function toSet(listStr) {
  return new Set(
    (listStr || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

// ====== إعدادات التفعيل ======
const QUESTIONS_PER_ATTEMPT = 10;  // كم سؤال يظهر كل مرة
const ALLOWED_WRONG = 2;           // سماحية خطأين

// ====== Cooldown (محاولة واحدة/15 دقيقة فقط عند الرسوب) ======
const cooldown = new Map(); // userId -> lastFailTimestamp
const COOLDOWN_MS = 15 * 60 * 1000;

// ====== بنك أسئلة كبير + تلخبط (صح مو دايم فوق) ======
const QUESTION_BANK = [
  {
    id: "q1",
    title: "ماهو الرول بلاي برأيك؟",
    options: [
      { k: "a", text: "تقمص الشخصية وتمثيل الحياة الواقعية داخل اللعبة", correct: true },
      { k: "b", text: "اللعب بدون تقمص", correct: false },
      { k: "c", text: "التحدث خارج الرول بلاي مسموح دائمًا", correct: false },
      { k: "d", text: "تجاهل القوانين إذا ما فيه إدارة", correct: false }
    ],
  },
  {
    id: "q2",
    title: "ماهو (VDM)؟",
    options: [
      { k: "a", text: "استخدام المركبة كسلاح ودهس اللاعبين", correct: true },
      { k: "b", text: "صدم عرضي بسيط", correct: false },
      { k: "c", text: "القيادة بسرعة عالية داخل المدينة دائمًا", correct: false },
      { k: "d", text: "مسموح دهس أي شخص بدون سبب", correct: false }
    ],
  },
  {
    id: "q3",
    title: "ماهو (RDM)؟",
    options: [
      { k: "a", text: "قتل اللاعبين بدون سبب/تهديد وبشكل عشوائي", correct: true },
      { k: "b", text: "الدفاع عن النفس عند التهديد", correct: false },
      { k: "c", text: "إطلاق نار بعد مفاوضات وسبب واضح", correct: false },
      { k: "d", text: "الرد على تهديد مباشر داخل الرول بلاي", correct: false }
    ],
  },
  {
    id: "q4",
    title: "متى يحق لك الصدم الاحترافي؟",
    options: [
      { k: "a", text: "بعد مرور 5 دقائق من المطاردة وأخذ الإذن من مركز العمليات", correct: true },
      { k: "b", text: "مباشرة بعد بدء المطاردة", correct: false },
      { k: "c", text: "بدون إذن بأي وقت", correct: false },
      { k: "d", text: "إذا كنت معصب فقط", correct: false }
    ],
  },
  {
    id: "q5",
    title: "إذا كنت برتبة رئيس رقباء يحق لك الاصطفاف العسكري؟",
    options: [
      { k: "a", text: "لا", correct: true },
      { k: "b", text: "نعم", correct: false }
    ],
  },
  {
    id: "q6",
    title: "في حال كانت عندك حالة اضطراري هل يحق لك قطع بلاغ زميلك؟",
    options: [
      { k: "a", text: "لا", correct: true },
      { k: "b", text: "نعم", correct: false },
      { k: "c", text: "مسموح بدون أي شروط", correct: false }
    ],
  },
  {
    id: "q7",
    title: "هل يحق لك صعود الجبل بسيارة سيدان أو رياضية؟",
    options: [
      { k: "a", text: "لا", correct: true },
      { k: "b", text: "نعم", correct: false }
    ],
  },
  {
    id: "q8",
    title: "هل يحق لك قطع بلاغ زميلك؟",
    options: [
      { k: "a", text: "لا", correct: true },
      { k: "b", text: "نعم", correct: false }
    ],
  },
  {
    id: "q9",
    title: "يجب عليك الالتزام بقوانين العسكر وعدم القيادة بتهور أو بسرعات غير واقعية",
    options: [
      { k: "a", text: "نعم", correct: true },
      { k: "b", text: "لا", correct: false }
    ],
  },
  {
    id: "q10",
    title: "يجب أن يكون لديك ميكروفون يعمل في اللعبة ومضبوط بشكل صحيح",
    options: [
      { k: "a", text: "نعم", correct: true },
      { k: "b", text: "لا", correct: false }
    ],
  },
  {
    id: "q11",
    title: "في حال طلعت جبل بسيارة افرود يجب القيادة بشكل واقعي",
    options: [
      { k: "a", text: "نعم", correct: true },
      { k: "b", text: "لا", correct: false }
    ],
  },
  {
    id: "q12",
    title: "حال القبض عليك وطلب منك الشرطي تسديد المخالفات يجب عليك تسديدها",
    options: [
      { k: "a", text: "نعم", correct: true },
      { k: "b", text: "لا", correct: false }
    ],
  },
  {
    id: "q13",
    title: "ملاحظة: يمنع التحدث خارج الرول بلاي في جميع الأحوال",
    options: [
      { k: "a", text: "نعم ممنوع", correct: true },
      { k: "b", text: "لا عادي", correct: false }
    ],
  },
  {
    id: "q14",
    title: "أي معلومة من خارج المدينة (يوتيوب/بث/ديسكورد) تعتبر مخالفة للرول بلاي",
    options: [
      { k: "a", text: "نعم مخالفة", correct: true },
      { k: "b", text: "لا مو مخالفة", correct: false }
    ],
  },
  {
    id: "q15",
    title: "احترم تحترم",
    options: [
      { k: "a", text: "نعم", correct: true },
      { k: "b", text: "لا", correct: false }
    ],
  }
];

// ====== Discord REST ======
async function discordRequest(method, url, body) {
  const res = await fetch("https://discord.com/api/v10" + url, {
    method,
    headers: {
      Authorization: `Bot ${BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`${method} ${url} failed: ${res.status} ${t}`);
  }
  return res.status === 204 ? null : res.json();
}

async function sendLogEmbed({ title, description, color = 0x2b2d31, fields = [] }) {
  if (!LOG_CHANNEL_ID) return;
  try {
    await discordRequest("POST", `/channels/${LOG_CHANNEL_ID}/messages`, {
      embeds: [
        {
          title,
          description,
          color,
          fields,
          timestamp: new Date().toISOString()
        }
      ]
    });
  } catch (e) {
    console.error("LOG_EMBED_FAILED:", e?.message || e);
  }
}

// ====== Discord OAuth ======
app.get("/auth/login", (req, res) => {
  const redirectUri = `${BASE_URL}/auth/callback`;
  const url =
    "https://discord.com/api/oauth2/authorize" +
    `?client_id=${encodeURIComponent(CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent("identify")}`;
  res.redirect(url);
});

app.get("/auth/callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send("Missing code");

    const redirectUri = `${BASE_URL}/auth/callback`;

    const body = new URLSearchParams();
    body.set("client_id", CLIENT_ID);
    body.set("client_secret", CLIENT_SECRET);
    body.set("grant_type", "authorization_code");
    body.set("code", code);
    body.set("redirect_uri", redirectUri);

    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    if (!tokenRes.ok) {
      const t = await tokenRes.text();
      return res.status(400).send("OAuth token error: " + t);
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    const meRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!meRes.ok) {
      const t = await meRes.text();
      return res.status(400).send("Fetch user error: " + t);
    }

    const me = await meRes.json();

    // cookie uid
    setCookie(res, "uid", me.id, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 60 * 60 * 24
    });

    res.redirect("/");
  } catch (e) {
    console.error(e);
    res.status(500).send("Server error in callback");
  }
});

app.get("/auth/logout", (req, res) => {
  setCookie(res, "uid", "", { path: "/", maxAge: 0 });
  res.redirect("/");
});

// ====== Serve page ======
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ====== API: get randomized questions ======
app.get("/api/questions", (req, res) => {
  const cookies = parseCookies(req);
  const uid = cookies.uid || null;

  const selected = shuffle(QUESTION_BANK)
    .slice(0, Math.min(QUESTIONS_PER_ATTEMPT, QUESTION_BANK.length))
    .map((q) => {
      const options = shuffle(q.options).map((o) => ({ k: o.k, text: o.text }));
      return { id: q.id, title: q.title, options };
    });

  const left =
    uid && cooldown.has(uid)
      ? Math.max(0, COOLDOWN_MS - (Date.now() - cooldown.get(uid)))
      : 0;

  res.json({
    loggedIn: !!uid,
    questions: selected,
    cooldown: left,
    allowedWrong: ALLOWED_WRONG,
  });
});

// ====== Submit ======
app.post("/submit", async (req, res) => {
  try {
    const cookies = parseCookies(req);
    const uid = cookies.uid;

    if (!uid) {
      return res.status(401).json({ ok: false, message: "لازم تسجل دخول ديسكورد أول." });
    }

    // cooldown فقط لو سبق ورسب
    const lastFail = cooldown.get(uid) || 0;
    const now = Date.now();
    if (now - lastFail < COOLDOWN_MS) {
      const leftSec = Math.ceil((COOLDOWN_MS - (now - lastFail)) / 1000);
      return res.status(429).json({
        ok: false,
        message: `محاولة واحدة فقط كل 15 دقيقة عند الرسوب. باقي ${leftSec} ثانية.`,
      });
    }

    const { answers, agree } = req.body;

    if (String(agree) !== "true") {
      return res.json({ ok: false, message: "لازم توافق على الشروط." });
    }

    // answers: array [{id, k}]
    let parsed = [];
    try {
      parsed = Array.isArray(answers) ? answers : JSON.parse(answers);
      if (!Array.isArray(parsed)) throw new Error("bad answers");
    } catch {
      return res.status(400).json({ ok: false, message: "إجابات غير صالحة." });
    }

    // لازم يجاوب كل الأسئلة المعروضة
    if (parsed.length === 0) {
      return res.status(400).json({ ok: false, message: "لازم تجاوب على الأسئلة." });
    }

    const bankMap = new Map(QUESTION_BANK.map((q) => [q.id, q]));
    let correctCount = 0;

    for (const a of parsed) {
      const q = bankMap.get(a.id);
      if (!q) continue;
      const opt = q.options.find((o) => o.k === a.k);
      if (opt && opt.correct) correctCount++;
    }

    const required = parsed.length;
    const wrongCount = required - correctCount;
    const passed = wrongCount <= ALLOWED_WRONG;

    // جلب العضو (لازم يكون داخل السيرفر)
    const member = await discordRequest("GET", `/guilds/${GUILD_ID}/members/${uid}`);

    const keep = toSet(KEEP_ROLE_IDS);
    keep.add(APPROVED_ROLE_ID);
    keep.add(UNAPPROVED_ROLE_ID);
    if (EXTRA_ROLE_ID) keep.add(EXTRA_ROLE_ID);

    if (passed) {
      // اعطاء موافق + حذف غير موافق
      await discordRequest("PUT", `/guilds/${GUILD_ID}/members/${uid}/roles/${APPROVED_ROLE_ID}`);
      await discordRequest("DELETE", `/guilds/${GUILD_ID}/members/${uid}/roles/${UNAPPROVED_ROLE_ID}`).catch(() => null);

      // حذف باقي الرولات (إلا keep)
      const rolesToRemove = (member.roles || []).filter((rid) => !keep.has(rid));
      for (const rid of rolesToRemove) {
        await discordRequest("DELETE", `/guilds/${GUILD_ID}/members/${uid}/roles/${rid}`).catch(() => null);
      }

      // رول إضافي (اختياري)
      if (EXTRA_ROLE_ID) {
        await discordRequest("PUT", `/guilds/${GUILD_ID}/members/${uid}/roles/${EXTRA_ROLE_ID}`).catch(() => null);
      }

      const msg =
        wrongCount > 0
          ? `✅ تم التفعيل. عندك ${wrongCount} خطأ وسامحناك (السماحية ${ALLOWED_WRONG}).`
          : "✅ تم التفعيل بنجاح وتم إعطاؤك رتبة (موافق على الشروط).";

      await sendLogEmbed({
        title: "✅ تفعيل إلكتروني - نجاح",
        color: 0x57f287,
        description: `تم تفعيل العضو <@${uid}>.`,
        fields: [
          { name: "الصحيح", value: `${correctCount}/${required}`, inline: true },
          { name: "الأخطاء", value: `${wrongCount}`, inline: true }
        ]
      });

      return res.json({ ok: true, passed: true, message: msg });
    }

    // رسوب => نسجل كولداون
    cooldown.set(uid, now);

    await discordRequest("PUT", `/guilds/${GUILD_ID}/members/${uid}/roles/${UNAPPROVED_ROLE_ID}`).catch(() => null);
    await discordRequest("DELETE", `/guilds/${GUILD_ID}/members/${uid}/roles/${APPROVED_ROLE_ID}`).catch(() => null);

    await sendLogEmbed({
      title: "❌ تفعيل إلكتروني - رسوب",
      color: 0xed4245,
      description: `العضو <@${uid}> رسب في الاختبار.`,
      fields: [
        { name: "الصحيح", value: `${correctCount}/${required}`, inline: true },
        { name: "الأخطاء", value: `${wrongCount}`, inline: true },
        { name: "محاولة جديدة بعد", value: "15 دقيقة", inline: true }
      ]
    });

    return res.json({
      ok: true,
      passed: false,
      message: `❌ عندك ${wrongCount} أخطاء. المسموح ${ALLOWED_WRONG} فقط. حاول بعد 15 دقيقة.`,
    });
  } catch (e) {
    console.error("SUBMIT_ERROR:", e?.message || e);

    if (String(e?.message || "").includes("GET /guilds") && String(e?.message || "").includes("404")) {
      return res.status(400).json({
        ok: false,
        message: "❌ لازم تكون داخل السيرفر قبل التفعيل. ادخل السيرفر ثم جرّب.",
      });
    }

    if (String(e?.message || "").includes("403")) {
      return res.status(400).json({
        ok: false,
        message: "❌ البوت ما عنده صلاحية كافية. تأكد من Manage Roles وأن رتبة البوت فوق الرتب المطلوبة.",
      });
    }

    return res.status(500).json({
      ok: false,
      message: `❌ خطأ بالسيرفر: ${e?.message || "غير معروف"}`,
    });
  }
});

// ====== Start ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Web Verify running: ${BASE_URL} (port ${PORT})`);
});
