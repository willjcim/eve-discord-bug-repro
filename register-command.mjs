// Registers the /repro slash command. Run with:
//   npm run register-command
// Set DISCORD_GUILD_ID for instant registration in one server; leave it empty
// to register globally, which Discord can take up to an hour to propagate.

const applicationId = process.env.DISCORD_APPLICATION_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;

if (!applicationId || !botToken) {
  console.error("Set DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN in .env");
  process.exit(1);
}

const scope = guildId ? `guilds/${guildId}/commands` : "commands";
const response = await fetch(
  `https://discord.com/api/v10/applications/${applicationId}/${scope}`,
  {
    method: "PUT",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([
      { name: "repro", description: "Trigger two sequential HITL prompts", type: 1 },
    ]),
  },
);

if (!response.ok) {
  console.error(`Discord returned ${response.status}: ${await response.text()}`);
  process.exit(1);
}

console.log(`Registered /repro ${guildId ? `in guild ${guildId}` : "globally"}.`);
