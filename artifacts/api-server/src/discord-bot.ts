import {
  Client,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  joinVoiceChannel,
  StreamType,
  type AudioPlayer,
  type VoiceConnection,
} from "@discordjs/voice";
import googleTTS from "google-tts-api";
import ffmpegPath from "ffmpeg-static";
import { logger } from "./lib/logger";

const TOKEN = process.env["DISCORD_TOKEN"];
const CLIENT_ID = process.env["CLIENT_ID"];

if (!TOKEN) {
  throw new Error(
    "DISCORD_TOKEN is required. Add it in Replit Secrets before starting the bot.",
  );
}

if (!CLIENT_ID) {
  throw new Error(
    "CLIENT_ID is required. Add it in Replit Secrets before starting the bot.",
  );
}

const token = TOKEN;
const clientId = CLIENT_ID;

if (ffmpegPath && !process.env["FFMPEG_PATH"]) {
  process.env["FFMPEG_PATH"] = ffmpegPath;
}

const commands = [
  new SlashCommandBuilder()
    .setName("speak")
    .setDescription("Converts text to speech and plays it in your voice channel.")
    .addStringOption((option) =>
      option
        .setName("message")
        .setDescription("The text you want the bot to say")
        .setRequired(true)
        .setMaxLength(200),
    ),
].map((command) => command.toJSON());

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

type GuildPlayback = {
  connection: VoiceConnection;
  player: AudioPlayer;
  cleanupTimer?: NodeJS.Timeout;
};

const activePlayback = new Map<string, GuildPlayback>();

function destroyPlayback(guildId: string) {
  const playback = activePlayback.get(guildId);
  if (!playback) return;

  if (playback.cleanupTimer) {
    clearTimeout(playback.cleanupTimer);
  }

  playback.player.stop();
  playback.connection.destroy();
  activePlayback.delete(guildId);
}

function schedulePlaybackCleanup(guildId: string) {
  const playback = activePlayback.get(guildId);
  if (!playback) return;

  playback.cleanupTimer = setTimeout(() => {
    const current = activePlayback.get(guildId);
    if (current === playback && current.player.state.status === AudioPlayerStatus.Idle) {
      destroyPlayback(guildId);
    }
  }, 1_000);
}

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(token);
  logger.info("Registering Discord slash commands");
  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  logger.info("Discord slash commands registered");
}

client.once("clientReady", () => {
  logger.info({ tag: client.user?.tag }, "Discord bot online");
});

client.on("error", (error) => {
  logger.error({ err: error }, "Discord client error");
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "speak") {
    return;
  }

  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({
      content: "This command can only be used in a server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id);
  const voiceChannel = member.voice.channel;

  if (!voiceChannel) {
    await interaction.reply({
      content: "Join a voice channel first, then try again.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const text = interaction.options.getString("message", true).trim();

  if (!text) {
    await interaction.reply({
      content: "Please provide a message for me to say.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();

  try {
    destroyPlayback(interaction.guild.id);

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: interaction.guild.id,
      adapterCreator: interaction.guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    const player = createAudioPlayer();
    const ttsUrl = googleTTS.getAudioUrl(text, {
      lang: "en",
      slow: false,
      host: "https://translate.google.com",
    });
    const resource = createAudioResource(ttsUrl, {
      inputType: StreamType.Arbitrary,
    });

    const playback: GuildPlayback = { connection, player };
    activePlayback.set(interaction.guild.id, playback);

    player.on(AudioPlayerStatus.Idle, () => {
      schedulePlaybackCleanup(interaction.guild!.id);
    });
    player.on("error", (error) => {
      logger.error({ err: error, guildId: interaction.guildId }, "Audio playback error");
      destroyPlayback(interaction.guildId!);
    });

    connection.subscribe(player);
    player.play(resource);

    await interaction.editReply(`Speaking: "${text}"`);
  } catch (error) {
    logger.error({ err: error, guildId: interaction.guildId }, "Failed to play audio");
    destroyPlayback(interaction.guild.id);
    await interaction.editReply("I couldn't play that message. Check that I can connect and speak in this voice channel.");
  }
});

export async function startDiscordBot() {
  await registerCommands();
  await client.login(token);
}