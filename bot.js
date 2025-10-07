// bot.js
import fs from "fs";
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder
} from "discord.js";

const TOKEN = process.env.TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const CLIENT_ID = process.env.CLIENT_ID;
const ADMIN_LOG_CHANNEL = process.env.ADMIN_LOG_CHANNEL || null; // optional: channel ID for admin logs

if (!TOKEN || !GUILD_ID || !CLIENT_ID) {
  console.error("ERROR: Missing required env vars. Set TOKEN, GUILD_ID and CLIENT_ID.");
  process.exit(1);
}

/**
 * === EDIT THESE: Add your VIP groups and role IDs ===
 * Replace "ROLE_ID_1" etc with actual Role IDs from your server.
 * The key names (object property) are the group names shown to users.
 */
const VIP_GROUPS = {
  "Tempo Trades Livestream": {
    roleId: "ROLE_ID_1",
    color: "#FFD700",
    contact: "Telegram — [CRT Course](https://t.me/CRTCourse)\nDiscord — [Join Here](https://discord.gg/2zwHMXjY7E)"
  },
  "SmartFX Premium": {
    roleId: "ROLE_ID_2",
    color: "#00BFFF",
    contact: "Telegram — [SmartFX Support](https://t.me/SmartFXSupport)"
  },
  "OrderFlow VIP": {
    roleId: "ROLE_ID_3",
    color: "#32CD32",
    contact: "Discord — [OrderFlow Hub](https://discord.gg/example)"
  }
};

const DATA_FILE = "members.json";

// ensure data file exists
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, "{}");

let members = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.DirectMessages],
  partials: ["CHANNEL"]
});

// Register slash command (guild-only)
const addMemberCommand = new SlashCommandBuilder()
  .setName("addmember")
  .setDescription("Add a user to a VIP membership")
  .addUserOption(opt => opt.setName("user").setDescription("User to add").setRequired(true))
  .addStringOption(opt => opt
    .setName("group")
    .setDescription("VIP Group Name")
    .setRequired(true)
    .addChoices(...Object.keys(VIP_GROUPS).map(name => ({ name, value: name }))))
  .addIntegerOption(opt => opt.setName("days").setDescription("Days of membership").setRequired(true));

const rest = new REST({ version: "10" }).setToken(TOKEN);
(async () => {
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: [addMemberCommand.toJSON()] });
    console.log("✅ Slash command registered.");
  } catch (err) {
    console.error("Failed to register commands:", err);
  }
})();

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  // check expiries every hour
  setInterval(checkExpiries, 60 * 60 * 1000);
  // run a first check shortly after start
  setTimeout(checkExpiries, 10 * 1000);
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isCommand()) return;
  if (interaction.commandName !== "addmember") return;

  const user = interaction.options.getUser("user", true);
  const groupName = interaction.options.getString("group", true);
  const days = interaction.options.getInteger("days", true);

  const group = VIP_GROUPS[groupName];
  if (!group) {
    return interaction.reply({ content: "❌ Group not found. Check that your VIP_GROUPS in bot.js is correct.", ephemeral: true });
  }

  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(user.id);

    // add role
    await member.roles.add(group.roleId);

    // store expiry
    const expiry = Date.now() + days * 24 * 60 * 60 * 1000;
    members[user.id] = { expiry, group: groupName, reminded: false };
    fs.writeFileSync(DATA_FILE, JSON.stringify(members, null, 2));

    await interaction.reply({ content: `✅ Added ${user.tag} to **${groupName}** for ${days} day(s).`, ephemeral: true });
    await logAdmin(`✅ Added ${user.tag} to **${groupName}** for ${days} day(s).`);
  } catch (err) {
    console.error("Error in /addmember:", err);
    await interaction.reply({ content: "❌ Failed to add member. Make sure the bot has Manage Roles and the role ID is correct.", ephemeral: true });
  }
});

function createEmbed(groupName, expiry) {
  const g = VIP_GROUPS[groupName] || { color: "#FFFF00", contact: "Contact support" };
  return new EmbedBuilder()
    .setColor(g.color)
    .setTitle("⚠️ Membership Expiring Soon!")
    .setDescription(`Your membership in **${groupName}** is expiring soon!`)
    .addFields(
      { name: "⏰ Expires", value: `<t:${Math.floor(expiry / 1000)}:f>`, inline: true },
      { name: "⌛ Time Left", value: "24 hours", inline: true },
      { name: "📞 Contact for Payment", value: g.contact }
    )
    .setFooter({ text: "Please renew your membership to maintain access." });
}

async function logAdmin(msg) {
  if (!ADMIN_LOG_CHANNEL) return;
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const ch = await guild.channels.fetch(ADMIN_LOG_CHANNEL).catch(() => null);
    if (ch && ch.send) await ch.send({ content: msg }).catch(() => {});
  } catch (e) {
    console.error("Admin log failed:", e);
  }
}

async function checkExpiries() {
  const now = Date.now();
  const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
  if (!guild) {
    console.error("Guild not reachable in checkExpiries.");
    return;
  }

  for (const [id, data] of Object.entries(members)) {
    const { expiry, group, reminded } = data;
    const timeLeft = expiry - now;
    const groupInfo = VIP_GROUPS[group];

    const member = await guild.members.fetch(id).catch(() => null);
    if (!member) {
      // user left server or not found
      continue;
    }

    // Reminder: 24 hours left (send once)
    if (timeLeft > 0 && timeLeft <= 24 * 60 * 60 * 1000 && !reminded) {
      const embed = createEmbed(group, expiry);
      try {
        await member.send({ embeds: [embed] });
        members[id].reminded = true;
        fs.writeFileSync(DATA_FILE, JSON.stringify(members, null, 2));
        const logMsg = `📨 Reminder sent to ${member.user.tag} for **${group}** (expires <t:${Math.floor(expiry/1000)}:F>).`;
        console.log(logMsg);
        await logAdmin(logMsg);
      } catch (e) {
        console.log(`Could not DM ${member.user.tag}. They may have DMs closed.`, e.message);
        await logAdmin(`⚠️ Could not DM ${member.user.tag} for ${group}.`);
        // still mark reminded to avoid spamming attempts
        members[id].reminded = true;
        fs.writeFileSync(DATA_FILE, JSON.stringify(members, null, 2));
      }
    }

    // Expired -> remove role and delete
    if (timeLeft <= 0) {
      try {
        if (groupInfo) {
          await member.roles.remove(groupInfo.roleId).catch(() => {});
          const logMsg = `⛔ Removed ${group} role from ${member.user.tag} (expired).`;
          console.log(logMsg);
          await logAdmin(logMsg);
        }
      } catch (e) {
        console.error("Failed to remove role:", e);
        await logAdmin(`❌ Failed to remove role for ${member.user.tag}.`);
      } finally {
        delete members[id];
        fs.writeFileSync(DATA_FILE, JSON.stringify(members, null, 2));
      }
    }
  }
}

client.login(TOKEN);
