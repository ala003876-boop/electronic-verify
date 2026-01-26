// server.js
// Node 18+ (Render default) — Express + Discord bot + GitHub storage (mil_codes.json)

const express = require("express");
const path = require("path");
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  InteractionType,
} = require("discord.js");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// ===================== ENV =====================
const {
  // Discord bot
  BOT_TOKEN,
  CLIENT_ID, // Discord application client id (same as bot app)
  GUILD_ID,

  // GitHub storage
  GITHUB_TOKEN,
  GITHUB_OWNER,
  GITHUB_REPO,
  GITHUB_BRANCH,

  // Military codes
  MIL_CHANNEL_ID,
  MIL_PREFIX, // مثال: جيم-
  MIL_START,  // مثال: 123
} = process.env;

function needEnv(name) {
  return !process.env[name] || String(process.env[name]).trim() === "";
}

const required = [
  "BOT_TOKEN",
  "CLIENT_ID",
  "GUILD_ID",
  "GITHUB_TOKEN",
  "GITHUB_OWNER",
  "GITHUB_REPO",
  "GITHUB_BRANCH",
  "MIL_CHANNEL_ID",
  "MIL_PREFIX",
  "MIL_START",
];

for (const k of required) {
  if (needEnv(k)) {
    console.error(`❌ نقص في متغيرات البيئة: ${k}`);
    process.exit(1);
  }
}

const MIL_START_NUM = Number(MIL_START);
if (!Number.isFinite(MIL_START_NUM) || MIL_START_NUM < 0) {
  console.error("❌ MIL_START لازم يكون رقم صحيح");
  process.exit(1);
}

// ===================== Static pages =====================
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Health
app.get("/health", (req, res) => res.json({ ok: true }));

// ===================== GitHub helpers =====================
// We store data in repo file: mil_codes.json (at repo root)
const GH_API = "https://api.github.com";
const CODES_PATH = "mil_codes.json";

function ghHeaders() {
  return {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    "X-GitHub-Api-Version": "2022-11-28",
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "mil-codes-bot",
  };
}

async function ghGetFile(owner, repo, filePath, branch) {
  const url = `${GH_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(branch)}`;
  const r = await fetch(url, { headers: ghHeaders() });
  if (r.status === 404) return null;
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`GitHub GET failed ${r.status}: ${t}`);
  }
  return r.json(); // { content, sha, ...}
}

async function ghPutFile(owner, repo, filePath, branch, message, contentBase64, sha) {
  const url = `${GH_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}`;
  const body = {
    message,
    content: contentBase64,
    branch,
  };
  if (sha) body.sha = sha;

  const r = await fetch(url, {
    method: "PUT",
    headers: ghHeaders(),
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`GitHub PUT failed ${r.status}: ${t}`);
  }
  return r.json();
}

function b64EncodeUtf8(str) {
  return Buffer.from(str, "utf8").toString("base64");
}
function b64DecodeUtf8(b64) {
  return Buffer.from(b64, "base64").toString("utf8");
}

// Load / init file if missing
async function ensureCodesFile() {
  const file = await ghGetFile(GITHUB_OWNER, GITHUB_REPO, CODES_PATH, GITHUB_BRANCH);
  if (file) return true;

  const initData = {
    next: MIL_START_NUM,
    prefix: MIL_PREFIX,
    assigned: [], // [{ code, name, userId, at }]
  };

  await ghPutFile(
    GITHUB_OWNER,
    GITHUB_REPO,
    CODES_PATH,
    GITHUB_BRANCH,
    "init mil codes storage",
    b64EncodeUtf8(JSON.stringify(initData, null, 2)),
    undefined
  );
  return true;
}

// Atomic-ish allocation with retry (handles race)
async function allocateNextCodeAtomic({ userId, fullName }) {
  // retry few times if SHA conflict
  for (let attempt = 1; attempt <= 5; attempt++) {
    const file = await ghGetFile(GITHUB_OWNER, GITHUB_REPO, CODES_PATH, GITHUB_BRANCH);
    if (!file || !file.content) {
      await ensureCodesFile();
      continue;
    }

    const json = JSON.parse(b64DecodeUtf8(file.content.replace(/\n/g, "")));

    // sanity
    if (!json || typeof json.next !== "number") {
      throw new Error("mil_codes.json format invalid");
    }

    const codeNumber = json.next;
    const code = `${MIL_PREFIX}${codeNumber}`;

    // update structure
    json.next = codeNumber + 1;
    if (!Array.isArray(json.assigned)) json.assigned = [];
    json.assigned.push({
      code,
      name: fullName,
      userId,
      at: new Date().toISOString(),
    });

    const newContent = b64EncodeUtf8(JSON.stringify(json, null, 2));
    try {
      await ghPutFile(
        GITHUB_OWNER,
        GITHUB_REPO,
        CODES_PATH,
        GITHUB_BRANCH,
        `assign ${code} to ${fullName}`,
        newContent,
        file.sha
      );
      return { code, codeNumber };
    } catch (e) {
      // If conflict, retry
      const msg = String(e?.message || "");
      const isConflict = msg.includes("409") || msg.includes("sha") || msg.includes("does not match");
      if (isConflict && attempt < 5) continue;
      throw e;
    }
  }
  throw new Error("Failed to allocate code (too much contention)");
}

// ===================== Discord bot =====================
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// Slash command: /كود
const command = new SlashCommandBuilder()
  .setName("كود")
  .setDescription("استلام كود عسكري (يطلب الاسم والقبيلة ثم يعطيك الكود)");

// register commands on startup
async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);

  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
    body: [command.toJSON()],
  });

  console.log("✅ Registered /كود command");
}

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  try {
    await ensureCodesFile();
    await registerCommands();
  } catch (e) {
    console.error("BOOT_ERROR:", e?.message || e);
  }
});

client.on("interactionCreate", async (interaction) => {
  try {
    // /كود -> open modal
    if (interaction.isChatInputCommand() && interaction.commandName === "كود") {
      const modal = new ModalBuilder()
        .setCustomId("mil_code_modal")
        .setTitle("استلام الكود العسكري");

      const nameInput = new TextInputBuilder()
        .setCustomId("full_name")
        .setLabel("اكتب اسمك واسم قبيلتك (مثال: بكر الشراري)")
        .setStyle(TextInputStyle.Short)
        .setMinLength(3)
        .setMaxLength(60)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(nameInput));

      return interaction.showModal(modal);
    }

    // Modal submit
    if (interaction.type === InteractionType.ModalSubmit && interaction.customId === "mil_code_modal") {
      const fullName = interaction.fields.getTextInputValue("full_name").trim();
      const userId = interaction.user.id;

      // Allocate code and store in GitHub
      const { code } = await allocateNextCodeAtomic({ userId, fullName });

      // Reply to user (ephemeral)
      await interaction.reply({
        ephemeral: true,
        content: `✅ تم إصدار كودك:\n**${fullName}-${code}**`,
      });

      // Log to channel
      const ch = await client.channels.fetch(MIL_CHANNEL_ID).catch(() => null);
      if (ch && ch.isTextBased()) {
        await ch.send(`✅ **${code} تم أخذه** بواسطة: **${fullName}** <@${userId}>`);
      }

      return;
    }
  } catch (e) {
    console.error("INTERACTION_ERROR:", e?.message || e);
    try {
      if (interaction.isRepliable()) {
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({ ephemeral: true, content: `❌ صار خطأ: ${e?.message || "غير معروف"}` });
        } else {
          await interaction.reply({ ephemeral: true, content: `❌ صار خطأ: ${e?.message || "غير معروف"}` });
        }
      }
    } catch {}
  }
});
// =======================
// 🪖 Military Codes System
// =======================

const fs = require("fs");
const CODES_FILE = "./codes.json";

const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
const START_NUMBER = Number(process.env.START_NUMBER || 1);

// تحميل آخر رقم
let lastNumber = START_NUMBER - 1;
if (fs.existsSync(CODES_FILE)) {
  try {
    const data = JSON.parse(fs.readFileSync(CODES_FILE, "utf8"));
    lastNumber = data.lastNumber ?? lastNumber;
  } catch {}
}

function saveLastNumber() {
  fs.writeFileSync(CODES_FILE, JSON.stringify({ lastNumber }, null, 2));
}

// أمر /كود
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "كود") return;

  const fullName = interaction.options.getString("الاسم", true);
  const userId = interaction.user.id;

  lastNumber++;
  saveLastNumber();

  const code = `جيم-${lastNumber}`;

  // رد خاص للشخص
  await interaction.reply({
    ephemeral: true,
    content: `✅ تم إصدار كودك بنجاح\n\n**${fullName}-${code}**`,
  });

  // إرسال لوق
  try {
    const ch = await client.channels.fetch(LOG_CHANNEL_ID);
    if (ch) {
      await ch.send(`🪖 **${code}** تم أخذه بواسطة **${fullName}** <@${userId}>`);
    }
  } catch (e) {
    console.error("LOG_CHANNEL_ERROR:", e.message);
  }
});

client.login(BOT_TOKEN);

// ===================== Start web =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Web running on port ${PORT}`);
});
