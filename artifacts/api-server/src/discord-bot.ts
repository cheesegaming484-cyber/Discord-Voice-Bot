import {
  ChannelType,
  Client,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import {
  createAudioResource,
  StreamType,
} from "@discordjs/voice";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import googleTTS from "google-tts-api";
import ffmpegPath from "ffmpeg-static";
import { logger } from "./lib/logger";
import {
  activePlayback,
  createPlayback,
  destroyPlayback,
} from "./voice-manager";
import { handleMusicInteraction, musicCommands } from "./music";

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

const VOICE_OPTIONS = {
  english: { name: "English", lang: "en" },
  spanish: { name: "Spanish", lang: "es" },
  french: { name: "French", lang: "fr" },
  german: { name: "German", lang: "de" },
  italian: { name: "Italian", lang: "it" },
  portuguese: { name: "Portuguese", lang: "pt" },
  japanese: { name: "Japanese", lang: "ja" },
  korean: { name: "Korean", lang: "ko" },
  chinese: { name: "Chinese", lang: "zh-CN" },
  russian: { name: "Russian", lang: "ru" },
  arabic: { name: "Arabic", lang: "ar" },
  tagalog: { name: "Tagalog", lang: "tl" },
} as const;

type VoiceKey = keyof typeof VOICE_OPTIONS;
const DEFAULT_VOICE: VoiceKey = "english";
const voiceChoices = Object.entries(VOICE_OPTIONS).map(([value, option]) => ({
  name: option.name,
  value,
}));

const commands = [
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("Join a voice channel.")
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("The voice channel to join")
        .addChannelTypes(ChannelType.GuildVoice)
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("speak")
    .setDescription("Convert text to speech in the bot's joined voice channel.")
    .addStringOption((option) =>
      option
        .setName("message")
        .setDescription("The text you want the bot to say")
        .setRequired(true)
        .setMaxLength(200),
    ),
  new SlashCommandBuilder()
    .setName("voice")
    .setDescription("Choose the language voice used for speech.")
    .addStringOption((option) =>
      option
        .setName("voice")
        .setDescription("The language voice to use")
        .addChoices(...voiceChoices)
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("preview")
    .setDescription("Preview a voice in the bot's current voice channel.")
    .addStringOption((option) =>
      option
        .setName("voice")
        .setDescription("Voice to preview, or leave empty for the server selection")
        .addChoices(...voiceChoices)
        .setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName("blacklist")
    .setDescription("Prevent a server member from using speech.")
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("The member to block from using /speak")
        .setRequired(true),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName("unblacklist")
    .setDescription("Allow a server member to use speech again.")
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("The member to allow to use /speak")
        .setRequired(true),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
].map((command) => command.toJSON());

commands.push(...musicCommands);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const speechBlacklist = new Map<string, Set<string>>();
const voicePreferences = new Map<string, VoiceKey>();
const blacklistFile = path.resolve("data/speech-blacklist.json");
const voicePreferencesFile = path.resolve("data/voice-preferences.json");

async function loadSpeechBlacklist() {
  try {
    const raw = await readFile(blacklistFile, "utf8");
    const saved = JSON.parse(raw) as Record<string, unknown>;

    for (const [guildId, users] of Object.entries(saved)) {
      if (Array.isArray(users) && users.every((userId) => typeof userId === "string")) {
        speechBlacklist.set(guildId, new Set(users));
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.error({ err: error }, "Could not load speech blacklist");
    }
  }
}

async function saveSpeechBlacklist() {
  const data = Object.fromEntries(
    [...speechBlacklist.entries()].map(([guildId, users]) => [
      guildId,
      [...users],
    ]),
  );
  const tempFile = `${blacklistFile}.tmp`;

  await mkdir(path.dirname(blacklistFile), { recursive: true });
  await writeFile(tempFile, JSON.stringify(data, null, 2), "utf8");
  await rename(tempFile, blacklistFile);
}

async function loadVoicePreferences() {
  try {
    const raw = await readFile(voicePreferencesFile, "utf8");
    const saved = JSON.parse(raw) as Record<string, unknown>;

    for (const [guildId, voice] of Object.entries(saved)) {
      if (typeof voice === "string" && voice in VOICE_OPTIONS) {
        voicePreferences.set(guildId, voice as VoiceKey);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.error({ err: error }, "Could not load voice preferences");
    }
  }
}

async function saveVoicePreferences() {
  const data = Object.fromEntries(voicePreferences.entries());
  const tempFile = `${voicePreferencesFile}.tmp`;

  await mkdir(path.dirname(voicePreferencesFile), { recursive: true });
  await writeFile(tempFile, JSON.stringify(data, null, 2), "utf8");
  await rename(tempFile, voicePreferencesFile);
}

function isSpeechBlacklisted(guildId: string, userId: string) {
  return speechBlacklist.get(guildId)?.has(userId) ?? false;
}

function getVoiceKey(guildId: string, requestedVoice?: string | null): VoiceKey {
  if (requestedVoice && requestedVoice in VOICE_OPTIONS) {
    return requestedVoice as VoiceKey;
  }

  return voicePreferences.get(guildId) ?? DEFAULT_VOICE;
}

function hasSpeechModerationPermission(
  permissions: Readonly<import("discord.js").PermissionsBitField> | null,
) {
  return Boolean(
    permissions?.has(PermissionFlagsBits.Administrator) ||
      permissions?.has(PermissionFlagsBits.ManageGuild),
  );
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
  if (!interaction.isChatInputCommand()) {
    return;
  }

  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({
      content: "This command can only be used in a server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (await handleMusicInteraction(interaction)) {
    return;
  }

  try {
    if (interaction.commandName === "join") {
      const selectedChannel = interaction.options.getChannel("channel", true);
      const voiceChannel = interaction.guild.channels.cache.get(selectedChannel.id);

      if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
        await interaction.reply({
          content: "Choose a standard voice channel.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (!voiceChannel.joinable) {
        await interaction.reply({
          content: "I can't join that voice channel. Check my Connect permission.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      createPlayback(
        interaction.guild.id,
        voiceChannel.id,
        interaction.guild.voiceAdapterCreator,
        true,
      );
      await interaction.reply(`Joined **${voiceChannel.name}**.`);
      return;
    }

    if (
      interaction.commandName === "blacklist" ||
      interaction.commandName === "unblacklist"
    ) {
      if (!hasSpeechModerationPermission(interaction.memberPermissions)) {
        await interaction.reply({
          content: "You need the Manage Server permission to change speech access.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const user = interaction.options.getUser("user", true);
      const users = speechBlacklist.get(interaction.guild.id) ?? new Set<string>();
      const currentlyBlacklisted = users.has(user.id);

      if (interaction.commandName === "blacklist") {
        users.add(user.id);
        speechBlacklist.set(interaction.guild.id, users);
        await saveSpeechBlacklist();
        await interaction.reply(
          currentlyBlacklisted
            ? `<@${user.id}> is already blocked from using speech.`
            : `<@${user.id}> can no longer use /speak.`,
        );
      } else {
        users.delete(user.id);
        if (users.size === 0) {
          speechBlacklist.delete(interaction.guild.id);
        } else {
          speechBlacklist.set(interaction.guild.id, users);
        }
        await saveSpeechBlacklist();
        await interaction.reply(
          currentlyBlacklisted
            ? `<@${user.id}> can use /speak again.`
            : `<@${user.id}> was not on the speech blacklist.`,
        );
      }
      return;
    }

    if (interaction.commandName === "voice") {
      const selectedVoice = getVoiceKey(
        interaction.guild.id,
        interaction.options.getString("voice", true),
      );
      voicePreferences.set(interaction.guild.id, selectedVoice);
      await saveVoicePreferences();
      await interaction.reply(
        `Voice set to **${VOICE_OPTIONS[selectedVoice].name}** for this server.`,
      );
      return;
    }

    if (
      interaction.commandName === "preview" &&
      isSpeechBlacklisted(interaction.guild.id, interaction.user.id)
    ) {
      await interaction.reply({
        content: "You are not allowed to use speech commands in this server.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.commandName === "preview") {
      const playback = activePlayback.get(interaction.guild.id);
      const joinedChannel = playback
        ? interaction.guild.channels.cache.get(playback.voiceChannelId)
        : undefined;

      if (!playback || !joinedChannel || joinedChannel.type !== ChannelType.GuildVoice) {
        await interaction.reply({
          content: "I am not in a voice channel. Use /join and choose a voice channel first.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const selectedVoice = getVoiceKey(
        interaction.guild.id,
        interaction.options.getString("voice"),
      );
      const sampleText = `Hello. This is a preview of the ${VOICE_OPTIONS[selectedVoice].name} voice.`;
      const ttsUrl = googleTTS.getAudioUrl(sampleText, {
        lang: VOICE_OPTIONS[selectedVoice].lang,
        slow: false,
        host: "https://translate.google.com",
      });
      const resource = createAudioResource(ttsUrl, {
        inputType: StreamType.Arbitrary,
      });

      playback.player.play(resource);
      await interaction.reply(
        `Previewing the **${VOICE_OPTIONS[selectedVoice].name}** voice in **${joinedChannel.name}**.`,
      );
      return;
    }

    if (interaction.commandName !== "speak") {
      return;
    }

    if (isSpeechBlacklisted(interaction.guild.id, interaction.user.id)) {
      await interaction.reply({
        content: "You are not allowed to use speech commands in this server.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const existingPlayback = activePlayback.get(interaction.guild.id);
    const joinedChannel = existingPlayback?.stayConnected
      ? interaction.guild.channels.cache.get(existingPlayback.voiceChannelId)
      : undefined;
    let voiceChannel =
      joinedChannel?.type === ChannelType.GuildVoice ? joinedChannel : undefined;

    if (!voiceChannel) {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const memberVoiceChannel = member.voice.channel;

      if (!memberVoiceChannel) {
        await interaction.reply({
          content: "Use /join to choose a voice channel, or join one first.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (memberVoiceChannel.type !== ChannelType.GuildVoice) {
        await interaction.reply({
          content: "Choose a standard voice channel, then try again.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      voiceChannel = memberVoiceChannel;
    }

    if (!voiceChannel.joinable || !voiceChannel.speakable) {
      await interaction.reply({
        content: "I can't speak in that voice channel. Check my Connect and Speak permissions.",
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

    const playback = createPlayback(
      interaction.guild.id,
      voiceChannel.id,
      interaction.guild.voiceAdapterCreator,
      false,
    );
    const selectedVoice = getVoiceKey(interaction.guild.id);
    const ttsUrl = googleTTS.getAudioUrl(text, {
      lang: VOICE_OPTIONS[selectedVoice].lang,
      slow: false,
      host: "https://translate.google.com",
    });
    const resource = createAudioResource(ttsUrl, {
      inputType: StreamType.Arbitrary,
    });

    playback.player.play(resource);
    await interaction.editReply(`Speaking: "${text}"`);
  } catch (error) {
    logger.error({ err: error, guildId: interaction.guildId }, "Failed to play audio");
    const playback = interaction.guildId
      ? activePlayback.get(interaction.guildId)
      : undefined;
    if (playback && !playback.stayConnected) {
      destroyPlayback(interaction.guildId!);
    }
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(
        "I couldn't complete that request. Check my channel permissions and try again.",
      );
    } else {
      await interaction.reply({
        content: "I couldn't complete that request. Check my channel permissions and try again.",
        flags: MessageFlags.Ephemeral,
      });
    }
  }
});

export async function startDiscordBot() {
  await loadSpeechBlacklist();
  await loadVoicePreferences();
  await registerCommands();
  await client.login(token);
}