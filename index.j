// index.js - Discord.js v14
require("dotenv").config();
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
  EmbedBuilder,
} = require("discord.js");

const BOT_TOKEN = process.env.BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;

if (!BOT_TOKEN || !GUILD_ID || !LOG_CHANNEL_ID) {
  console.error("❌ نقص في متغيرات البيئة: BOT_TOKEN / GUILD_ID / LOG_CHANNEL_ID");
  process.exit(1);
}

const DATA_FILE = path.join(__dirname, "data.json");

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const prefix = process.env.CODE_PREFIX || "جيم-";
    const start = Number(process.env.START_NUMBER || 123);
    const init = { prefix, nextNumber: start, claimed: [] };
    fs.writeFileSync(DATA_FILE, JSON.stringify(init, null, 2), "utf8");
    return init;
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

// تخصيص الكود التالي بشكل "ذرّي" (نحاول نتجنب تعارض بنفس اللحظة)
let lock = Promise.resolve();
function withLock(fn) {
  lock = lock.then(fn).catch(() => {}).then(() => {});
  return lock;
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// ====== Register Slash Command ======
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("code")
      .setDescription("استلام كود عسكري بالترتيب (جيم-123 ثم 124...)")
      .toJSON(),
  ];

  const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);
  await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), {
    body: commands,
  });
  console.log("✅ تم تسجيل أوامر السلاش داخل السيرفر");
}

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands();
});

// ====== /code -> Modal ======
client.on("interactionCreate", async (interaction) => {
  try {
    // أمر سلاش
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName !== "code") return;

      const modal = new ModalBuilder()
        .setCustomId("mil_code_modal")
        .setTitle("استلام كود عسكري");

      const nameInput = new TextInputBuilder()
        .setCustomId("fullName")
        .setLabel("اكتب اسمك واسم قبيلتك")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("مثال: بكر الشراري")
        .setRequired(true)
        .setMaxLength(60);

      const row = new ActionRowBuilder().addComponents(nameInput);
      modal.addComponents(row);

      return interaction.showModal(modal);
    }

    // استلام المودال
    if (interaction.isModalSubmit()) {
      if (interaction.customId !== "mil_code_modal") return;

      const fullName = interaction.fields.getTextInputValue("fullName").trim();
      const userId = interaction.user.id;

      // تخصيص الكود داخل Lock
      await withLock(async () => {
        const data = loadData();

        // لو المستخدم أخذ كود قبل؟ (اختياري) — نخليه ياخذ مرة وحدة
        const already = data.claimed.find((x) => x.userId === userId);
        if (already) {
          const embed = new EmbedBuilder()
            .setTitle("✅ عندك كود مسبقًا")
            .setDescription(`**اسمك:** ${already.fullName}\n**كودك:** \`${already.code}\``)
            .setFooter({ text: "إذا تبي إعادة تعيين/تغيير، كلّم الإدارة." });

          await interaction.reply({ embeds: [embed], ephemeral: true });
          return;
        }

        const prefix = data.prefix || (process.env.CODE_PREFIX || "جيم-");
        const code = `${prefix}${data.nextNumber}`;

        // حدّث الرقم القادم
        data.nextNumber = Number(data.nextNumber) + 1;

        // سجّل
        data.claimed.push({
          userId,
          fullName,
          code,
          at: new Date().toISOString(),
        });

        saveData(data);

        // رد للمستخدم (خاص)
        const embedUser = new EmbedBuilder()
          .setTitle("✅ تم إصدار كودك العسكري")
          .setDescription(`**الاسم:** ${fullName}\n**الكود:** \`${code}\``)
          .setFooter({ text: "احتفظ بالكود ولا تشاركه." });

        await interaction.reply({ embeds: [embedUser], ephemeral: true });

        // لوق في روم
        const logCh = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
        if (logCh && logCh.isTextBased()) {
          const embedLog = new EmbedBuilder()
            .setTitle("📌 كود تم أخذه")
            .setDescription(`**${code}** تم أخذه بواسطة **${fullName}**\n<@${userId}> \`(${userId})\``)
            .setTimestamp(new Date());

          await logCh.send({ embeds: [embedLog] });
        }
      });
    }
  } catch (e) {
    console.error("INTERACTION_ERROR:", e);
    if (interaction.isRepliable()) {
      try {
        await interaction.reply({
          ephemeral: true,
          content: "❌ صار خطأ. جرّب مرة ثانية، وإذا تكرر كلم الإدارة.",
        });
      } catch {}
    }
  }
});

client.login(BOT_TOKEN);
