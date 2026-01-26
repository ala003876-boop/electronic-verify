const express = require("express");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// ===== ENV =====
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
  console.error("❌ نقص في متغيرات البيئة (Render ENV)");
  process.exit(1);
}

// ===== Helpers =====
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

// ===== Settings =====
const QUESTIONS_PER_ATTEMPT = 10;
const ALLOWED_WRONG = 2;
const COOLDOWN_MS = 15 * 60 * 1000;
const cooldown = new Map();

// ===== Question Bank =====
const QUESTION_BANK = [
  {
    id: "q1",
    title: "ماهو الرول بلاي؟",
    options: [
      { k: "a", text: "تقمص الشخصية وتمثيل الحياة الواقعية داخل اللعبة", correct: true },
      { k: "b", text: "اللعب بدون تقمص", correct: false },
    ],
  },
  {
    id: "q2",
    title: "ماهو VDM؟",
    options: [
      { k: "a", text: "استخدام المركبة كسلاح ودهس اللاعبين", correct: true },
      { k: "b", text: "صدم عرضي بسيط", correct: false },
    ],
  },
];

// ===== Discord REST =====
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
    const t = await res.text();
    throw new Error(`${res.status} ${t}`);
  }

  return res.status === 204 ? null : res.json();
}

// ===== Routes =====
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/api/questions", (req, res) => {
  const cookies = parseCookies(req);
  const uid = cookies.uid;

  const questions = shuffle(QUESTION_BANK)
    .slice(0, QUESTIONS_PER_ATTEMPT)
    .map((q) => ({
      id: q.id,
      title: q.title,
      options: shuffle(q.options).map((o) => ({ k: o.k, text: o.text })),
    }));

  const left =
    uid && cooldown.has(uid)
      ? Math.max(0, COOLDOWN_MS - (Date.now() - cooldown.get(uid)))
      : 0;

  res.json({
    questions,
    cooldown: left,
    allowedWrong: ALLOWED_WRONG,
  });
});

app.post("/submit", async (req, res) => {
  try {
    const cookies = parseCookies(req);
    const uid = cookies.uid;

    if (!uid) {
      return res.status(401).json({ ok: false, message: "سجّل دخول ديسكورد أولًا" });
    }

    const lastFail = cooldown.get(uid) || 0;
    if (Date.now() - lastFail < COOLDOWN_MS) {
      return res.json({ ok: false, message: "انتظر 15 دقيقة قبل المحاولة" });
    }

    const { answers, agree } = req.body;
    if (String(agree) !== "true") {
      return res.json({ ok: false, message: "يجب الموافقة على الشروط" });
    }

    const parsed = Array.isArray(answers) ? answers : JSON.parse(answers);
    let wrong = 0;

    for (const a of parsed) {
      const q = QUESTION_BANK.find((x) => x.id === a.id);
      const opt = q?.options.find((o) => o.k === a.k);
      if (!opt?.correct) wrong++;
    }

    const passed = wrong <= ALLOWED_WRONG;

    if (passed) {
      await discordRequest(
        "PUT",
        `/guilds/${GUILD_ID}/members/${uid}/roles/${APPROVED_ROLE_ID}`
      );
      await discordRequest(
        "DELETE",
        `/guilds/${GUILD_ID}/members/${uid}/roles/${UNAPPROVED_ROLE_ID}`
      ).catch(() => null);

      return res.json({
        ok: true,
        passed: true,
        message:
          wrong > 0
            ? `تم التفعيل ✔️ عندك ${wrong} خطأ وسامحناك`
            : "تم التفعيل ✔️",
      });
    }

    cooldown.set(uid, Date.now());
    return res.json({
      ok: false,
      passed: false,
      message: `رسوب ❌ عندك ${wrong} أخطاء`,
    });
  } catch (e) {
    console.error("SUBMIT_ERROR:", e.message);
    return res.status(500).json({
      ok: false,
      message: "خطأ في السيرفر",
    });
  }
});

// ===== Start =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on ${PORT}`);
});
