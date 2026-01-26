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
function setCookie(res, name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.httpOnly) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  if (opts.path) parts.push(`Path=${opts.path}`);
  if (opts.maxAge) parts.push(`Max-Age=${opts.maxAge}`);
  res.setHeader("Set-Cookie", parts.join("; "));
}

// ===== Discord OAuth Login =====
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

    setCookie(res, "uid", me.id, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 60 * 60 * 24, // يوم
    });

    res.redirect("/");
  } catch (e) {
    console.error("CALLBACK_ERROR:", e?.message || e);
    res.status(500).send("Server error in callback");
  }
});

app.get("/auth/logout", (req, res) => {
  setCookie(res, "uid", "", { path: "/", maxAge: 0 });
  res.redirect("/");
});

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
