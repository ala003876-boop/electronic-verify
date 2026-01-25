const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/public", express.static(path.join(__dirname, "public")));

const {
  PORT = 3000,
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
  console.error("❌ نقص في متغيرات .env");
  process.exit(1);
}

const KEEP_SET = new Set(
  (KEEP_ROLE_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

// ====== تطبيع عربي بسيط لتقليل اختلافات الكتابة ======
function normalize(s = "") {
  return String(s)
    .toLowerCase()
    .replace(/[ـ]/g, "")
    .replace(/[ًٌٍَُِّْ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function includesAll(text, words) {
  const t = normalize(text);
  return words.every((w) => t.includes(normalize(w)));
}
function isNo(text) {
  const t = normalize(text);
  return t === "لا" || t.includes("لا") || t.includes("لا يحق");
}
function isYes(text) {
  const t = normalize(text);
  return t === "نعم" || t.includes("نعم") || t.includes("موافق") || t.includes("اوافق") || t.includes("أوافق");
}

// ====== التحقق من الإجابات ======
function validateAnswers(a) {
  const q1ok =
    includesAll(a.q1, ["تقمص", "الشخصية"]) &&
    (normalize(a.q1).includes("الواقعي") || normalize(a.q1).includes("الواقع"));

  const q2ok =
    normalize(a.q2).includes("مركبة") &&
    (normalize(a.q2).includes("سلاح") || normalize(a.q2).includes("دهس"));

  const q3ok =
    (normalize(a.q3).includes("قتل") || normalize(a.q3).includes("قت")) &&
    (normalize(a.q3).includes("بدون سبب") || normalize(a.q3).includes("عشوائي"));

  const q4ok =
    normalize(a.q4).includes("5") &&
    normalize(a.q4).includes("دقائق") &&
    (normalize(a.q4).includes("اذن") || normalize(a.q4).includes("إذن")) &&
    normalize(a.q4).includes("مركز") &&
    normalize(a.q4).includes("العمليات");

  const q5ok = isNo(a.q5);
  const q6ok = isNo(a.q6);
  const q7ok = isNo(a.q7);
  const q8ok = isNo(a.q8);

  // الشروط 9-14 موافقة
  const agreeOk = isYes(a.agree);

  const ok = [q1ok, q2ok, q3ok, q4ok, q5ok, q6ok, q7ok, q8ok, agreeOk].every(Boolean);
  return { ok };
}

// ====== OAuth (تسجيل الدخول) ======
const states = new Map();

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/auth/login", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  states.set(state, Date.now());

  const redirectUri = encodeURIComponent(`${BASE_URL}/auth/callback`);
  const url =
    `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}` +
    `&response_type=code&redirect_uri=${redirectUri}` +
    `&scope=identify&state=${state}`;

  res.redirect(url);
});

app.get("/auth/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state || !states.has(state)) return res.status(400).send("Invalid state.");
    states.delete(state);

    const redirect_uri = `${BASE_URL}/auth/callback`;

    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri,
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) return res.status(400).send("OAuth token error.");

    const userRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const user = await userRes.json();
    if (!userRes.ok) return res.status(400).send("OAuth user error.");

    res.setHeader("Set-Cookie", `uid=${user.id}; Path=/; HttpOnly; SameSite=Lax`);
    res.redirect("/#authed");
  } catch (e) {
    console.error(e);
    res.status(500).send("Server error.");
  }
});

function getCookie(req, name) {
  const raw = req.headers.cookie || "";
  const m = raw.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

// ====== Helpers: Discord role add/remove ======
async function addRole(userId, roleId) {
  if (!roleId) return true;
  const r = await fetch(
    `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${userId}/roles/${roleId}`,
    { method: "PUT", headers: { Authorization: `Bot ${BOT_TOKEN}` } }
  );
  return r.ok || r.status === 204;
}

async function removeRole(userId, roleId) {
  if (!roleId) return true;
  const r = await fetch(
    `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${userId}/roles/${roleId}`,
    { method: "DELETE", headers: { Authorization: `Bot ${BOT_TOKEN}` } }
  );
  return r.ok || r.status === 204;
}

async function getMember(userId) {
  const r = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${userId}`, {
    headers: { Authorization: `Bot ${BOT_TOKEN}` },
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, data };
}

async function removeAllOtherRoles(userId, keepIds) {
  const { ok, data } = await getMember(userId);
  if (!ok) return false;

  const roles = Array.isArray(data.roles) ? data.roles : [];
  for (const rid of roles) {
    if (!keepIds.has(rid)) {
      await removeRole(userId, rid).catch(() => {});
    }
  }
  return true;
}

// ====== submit ======
app.post("/submit", async (req, res) => {
  try {
    const uid = getCookie(req, "uid");
    if (!uid) return res.status(401).json({ ok: false, msg: "لازم تسجّل دخول ديسكورد أول." });

    const answers = {
      q1: req.body.q1,
      q2: req.body.q2,
      q3: req.body.q3,
      q4: req.body.q4,
      q5: req.body.q5,
      q6: req.body.q6,
      q7: req.body.q7,
      q8: req.body.q8,
      agree: req.body.agree,
    };

    const verdict = validateAnswers(answers);

    if (!verdict.ok) {
      // ❌ غلط: أعطه غير موافق وشيل موافق
      await addRole(uid, UNAPPROVED_ROLE_ID).catch(() => {});
      await removeRole(uid, APPROVED_ROLE_ID).catch(() => {});
      if (EXTRA_ROLE_ID) await removeRole(uid, EXTRA_ROLE_ID).catch(() => {});
      return res.json({ ok: false, msg: "❌ إجاباتك فيها خطأ. تم وضعك: غير موافق على الشروط." });
    }

    // ✅ صح: شيل غير موافق
    await removeRole(uid, UNAPPROVED_ROLE_ID).catch(() => {});

    // ✅ أعطه موافق
    const okApproved = await addRole(uid, APPROVED_ROLE_ID);
    if (!okApproved) {
      return res.status(500).json({
        ok: false,
        msg: "❌ ما قدرت أعطيك رول الموافقة. تأكد البوت عنده Manage Roles ورتبته أعلى من رول الموافقة.",
      });
    }

    // ✅ رول إضافي (اختياري)
    if (EXTRA_ROLE_ID) await addRole(uid, EXTRA_ROLE_ID).catch(() => {});

    // ✅ حذف كل الرولات الأخرى (مع استثناءات)
    const mustKeep = new Set([
      APPROVED_ROLE_ID,
      UNAPPROVED_ROLE_ID, // نحطه ضمن keep عشان ما يتعطل لو كان موجود لحظة التبديل (بس حنا نشيله فوق)
      ...(EXTRA_ROLE_ID ? [EXTRA_ROLE_ID] : []),
      ...KEEP_SET,
    ]);

    await removeAllOtherRoles(uid, mustKeep).catch(() => {});

    return res.json({ ok: true, msg: "✅ تم التفعيل! تم إعطاؤك رول موافق على الشروط." });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, msg: "Server error." });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Web Verify running: ${BASE_URL}`);
});

