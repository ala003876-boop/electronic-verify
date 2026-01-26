// index.js (discord.js v14)
// Military codes: جيم-123, جيم-124...
// Modal: name+tribe
// Log channel: LOG_CHANNEL_ID
// Storage: codes.json (على Render Free ممكن يضيع مع إعادة التشغيل)

const fs = require("fs");
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
  EmbedBuilder,
} = require("discord.js");

// ===== ENV =====
const BOT_TOKEN = process.env.BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
const START_NUMBER = Number(process.env.START_NUMBER || 123);
const CODE_PREFIX = process.env.CODE_PREFIX || "جيم-";

// لو عندك CLIENT_ID في ENV استخدمه، إذا لا: حاولنا نجيبها من ready
const CLIENT_ID = process.env.CLIENT_ID || null;

if (!BOT_TOKEN || !GUILD_ID || !LOG_CHANNEL_ID) {
  console.error("❌ نقص ENV: BOT_TOKEN / GUILD_ID / LOG_CHANNEL_ID");
  process.exit(1);
}
if (!Number.isFinite(START_NUMBER)) {
  console.error("❌ START_NUMBER لازم يكون رقم");
  process.exit(1);
}

// ===== Storage =====
const DB_FILE = path.join(__dirname, "codes.json");

function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      const init = { prefix: CODE_PREFIX, next: START_NUMBER, claimed: [] };
      fs.writeFileSync(DB_FILE, JSON.stringify(init, null, 2), "utf8");
      return init;
    }
    const data = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    if (!data || typeof data.next !== "number") throw new Error("bad db");
    if (!Array.isArray(data.claimed)) data.claimed = [];
    if (!data.prefix) data.prefix = CODE_PREFIX;
    return data;
  } catch {
    const init = { prefix: CODE_PREFIX, next: START_NUMBER, claimed: [] };
    fs.writeFileSync(DB_FILE, JSON.stringify(init, null, 2), "utf8");
    return init;
  }
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf8");
}

// قفل بسيط لمنع تضارب لو جا شخصين بنفس اللحظة
let lock = Promise.resolve();
function withLock(fn) {
  lock = lock.then(fn).catch(() => {}).then(() => {});
  return lock;
}

// ===== Discord client =====
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ===== Register /كود =====
async function registerCommands(appId) {
  const commands = [
    new SlashCommandBuilder()
      .setName("كود")
      .setDescription("استلام كود عسكري بالترتيب (جيم-123 ثم 124...)")
      .toJSON(),
  ];

  const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);

  await rest.put(Routes.applicationGuildCommands(appId, GUILD_ID), {
    body: commands,
  });

  console.log("✅ تم تسجيل الأمر /كود");
}

// ===== Ready =====
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  try {
    const appId = CLIENT_ID || client.application?.id;
    if (!appId) {
      console.error("❌ ما قدرت أحدد CLIENT_ID. أضفه في ENV باسم CLIENT_ID.");
      return;
    }
    await registerCommands(appId);
  } catch (e) {
    console.error("REGISTER_ERROR:", e?.message || e);
  }
});

// ===== Interaction =====
client.on("interactionCreate", async (interaction) => {
  try {
    // /كود -> Modal
    if (interaction.isChatInputCommand() && interaction.commandName === "كود") {
      const modal = new ModalBuilder()
        .setCustomId("mil_code_modal")
        .setTitle("استلام كود عسكري");

      const nameInput = new TextInputBuilder()
        .setCustomId("full_name")
        .setLabel("اسمك + اسم القبيلة (مثال: بكر الشراري)")
        .setStyle(TextInputStyle.Short)
        .setMinLength(3)
        .setMaxLength(60)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(nameInput));
      return interaction.showModal(modal);
    }

    // Modal Submit
    if (interaction.type === InteractionType.ModalSubmit && interaction.customId === "mil_code_modal") {
      const fullName = interaction.fields.getTextInputValue("full_name").trim();
      const userId = interaction.user.id;

      await withLock(async () => {
        const db = loadDB();

        // (اختياري) منع الشخص ياخذ كود ثاني — حالياً مفعل ✅
        const already = db.claimed.find((x) => x.userId === userId);
        if (already) {
          const embed = new EmbedBuilder()
            .setTitle("✅ عندك كود مسبقًا")
            .setDescription(`**اسمك:** ${already.name}\n**كودك:** \`${already.code}\``)
            .setFooter({ text: "إذا تبي تغيير/إعادة تعيين كلم الإدارة." });

          return interaction.reply({ ephemeral: true, embeds: [embed] });
        }

        const code = `${db.prefix || CODE_PREFIX}${db.next}`;
        db.next += 1;

        db.claimed.push({
          userId,
          name: fullName,
          code,
          at: new Date().toISOString(),
        });

        saveDB(db);

        // رد خاص للشخص
        const embedUser = new EmbedBuilder()
          .setTitle("🪖 تم إصدار كودك العسكري")
          .setDescription(`**${fullName}-${code}**`)
          .setFooter({ text: "احتفظ بالكود." });

        await interaction.reply({ ephemeral: true, embeds: [embedUser] });

        // لوق في الروم
        const logCh = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
        if (logCh && logCh.isTextBased()) {
          const embedLog = new EmbedBuilder()
            .setTitle("✅ كود تم أخذه")
            .setDescription(`**${code}** تم أخذه بواسطة **${fullName}**\n<@${userId}> \`(${userId})\``)
            .setTimestamp(new Date());

          await logCh.send({ embeds: [embedLog] });
        }
      });

      return;
    }
  } catch (e) {
    console.error("INTERACTION_ERROR:", e?.message || e);
    try {
      if (interaction.isRepliable()) {
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({ ephemeral: true, content: "❌ صار خطأ. جرّب مرة ثانية." });
        } else {
          await interaction.reply({ ephemeral: true, content: "❌ صار خطأ. جرّب مرة ثانية." });
        }
      }
    } catch {}
  }
});

client.login(BOT_TOKEN);
