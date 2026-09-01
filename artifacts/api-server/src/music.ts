import {
  ChatInputCommandInteraction,
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import {
  AudioPlayerStatus,
  createAudioResource,
  StreamType,
} from "@discordjs/voice";
import play, { type YouTubeVideo } from "play-dl";
import ffmpegPath from "ffmpeg-static";
import { spawn } from "node:child_process";
import findLyrics from "lyrics-finder";
import {
  activePlayback,
  createPlayback,
  destroyPlayback,
  type GuildPlayback,
} from "./voice-manager";
import { logger } from "./lib/logger";

type LoopMode = "off" | "song" | "queue";

type Track = {
  title: string;
  url: string;
  durationInSec: number;
  requestedBy: string;
};

type MusicState = {
  playback: GuildPlayback;
  queue: Track[];
  history: Track[];
  current: Track | null;
  loop: LoopMode;
  volume: number;
  autoplay: boolean;
  stayConnected: boolean;
  startedAt: number | null;
  advancing: boolean;
};

const musicStates = new Map<string, MusicState>();

const MUSIC_COMMAND_NAMES = new Set([
  "play",
  "playskip",
  "playtop",
  "pause",
  "resume",
  "skip",
  "back",
  "replay",
  "stop",
  "clear",
  "queue",
  "nowplaying",
  "search",
  "volume",
  "autoplay",
  "lyrics",
  "loop",
  "leave",
  "247",
]);

const musicCommands = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Play a YouTube song or search query.")
    .addStringOption((option) =>
      option
        .setName("song")
        .setDescription("Song title or YouTube URL")
        .setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName("playskip")
    .setDescription("Add a song and skip to it immediately.")
    .addStringOption((option) =>
      option
        .setName("song")
        .setDescription("Song title or YouTube URL")
        .setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName("playtop")
    .setDescription("Add a song to the top of the queue.")
    .addStringOption((option) =>
      option
        .setName("song")
        .setDescription("Song title or YouTube URL")
        .setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName("pause")
    .setDescription("Pause the current song."),

  new SlashCommandBuilder()
    .setName("resume")
    .setDescription("Resume the current song."),

  new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Skip the current song."),

  new SlashCommandBuilder()
    .setName("back")
    .setDescription("Play the previous song."),

  new SlashCommandBuilder()
    .setName("replay")
    .setDescription("Replay the current song."),

  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop playback and clear the queue."),

  new SlashCommandBuilder()
    .setName("clear")
    .setDescription("Clear the queue without stopping."),

  new SlashCommandBuilder()
    .setName("queue")
    .setDescription("Show the current song queue."),

  new SlashCommandBuilder()
    .setName("nowplaying")
    .setDescription("Show the active song."),

  new SlashCommandBuilder()
    .setName("search")
    .setDescription("Search YouTube for a song.")
    .addStringOption((option) =>
      option
        .setName("query")
        .setDescription("What to search for")
        .setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName("volume")
    .setDescription("Set playback volume from 1 to 200.")
    .addIntegerOption((option) =>
      option
        .setName("amount")
        .setDescription("Volume percentage")
        .setMinValue(1)
        .setMaxValue(200)
        .setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName("loop")
    .setDescription("Set the loop mode.")
    .addStringOption((option) =>
      option
        .setName("mode")
        .setDescription("Loop mode")
        .addChoices(
          { name: "Off", value: "off" },
          { name: "Current song", value: "song" },
          { name: "Queue", value: "queue" },
        )
        .setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName("autoplay")
    .setDescription(
      "Toggle automatically adding a related song when the queue ends.",
    ),

  new SlashCommandBuilder()
    .setName("lyrics")
    .setDescription("Show lyrics for the current song."),

  new SlashCommandBuilder()
    .setName("leave")
    .setDescription("Disconnect from voice."),

  new SlashCommandBuilder()
    .setName("247")
    .setDescription("Toggle staying in the voice channel after playback ends."),
].map((command) => command.toJSON());

function formatDuration(seconds: number) {
  if (!seconds || seconds < 0) return "live";

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");

  return `${minutes}:${remainingSeconds}`;
}

function getUserVoiceChannel(interaction: ChatInputCommandInteraction) {
  const member = interaction.guild?.members.cache.get(interaction.user.id);

  return member?.voice.channel?.type === ChannelType.GuildVoice
    ? member.voice.channel
    : undefined;
}

function getState(
  interaction: ChatInputCommandInteraction,
  channelId: string,
) {
  const guildId = interaction.guild!.id;
  const existing = musicStates.get(guildId);
  const existingPlayback = activePlayback.get(guildId);

  if (
    existing &&
    existing.playback === existingPlayback &&
    existing.playback.voiceChannelId === channelId
  ) {
    return existing;
  }

  if (existing) {
    musicStates.delete(guildId);
  }

  const playback = createPlayback(
    guildId,
    channelId,
    interaction.guild!.voiceAdapterCreator,
    true,
  );

  const state: MusicState = {
    playback,
    queue: [],
    history: [],
    current: null,
    loop: "off",
    volume: 100,
    autoplay: false,
    stayConnected: false,
    startedAt: null,
    advancing: false,
  };

  musicStates.set(guildId, state);

  return state;
}

async function resolveTrack(
  query: string,
  requestedBy: string,
): Promise<Track | null> {
  const results = await play.search(query, {
    limit: 1,
    source: {
      youtube: "video",
    },
  });

  const video: YouTubeVideo | undefined = results[0];

  if (!video?.url || !video.title) {
    return null;
  }

  return {
    title: video.title,
    url: video.url,
    durationInSec: video.durationInSec,
    requestedBy,
  };
}

async function playNext(
  state: MusicState,
  skipCurrent = false,
) {
  if (state.advancing) return;

  state.advancing = true;

  try {
    let next: Track | null = null;

    if (
      !skipCurrent &&
      state.current &&
      state.loop === "song"
    ) {
      next = state.current;
    } else if (
      state.loop === "queue" &&
      state.current
    ) {
      state.queue.push(state.current);
      next = state.queue.shift() ?? null;
    } else {
      next = state.queue.shift() ?? null;
    }

    if (!next) {
      state.current = null;
      state.startedAt = null;
      state.playback.stayConnected = state.stayConnected;

      if (!state.stayConnected) {
        destroyPlayback(
          state.playback.voiceChannelId
            ? state.playback.connection.joinConfig.guildId!
            : "",
        );
      }

      return;
    }

    if (
      state.current &&
      state.current.url !== next.url &&
      !skipCurrent
    ) {
      state.history.push(state.current);
    }

    state.current = next;

    if (!ffmpegPath) {
      throw new Error("FFmpeg binary not found");
    }

    /*
     * YouTube extraction:
     *
     * yt-dlp is used instead of play-dl/ytdl-core because
     * YouTube's current SABR/signature system can cause those
     * libraries to return no playable formats.
     *
     * `python -m yt_dlp` ensures we use the same Python
     * environment where the updated yt-dlp package exists.
     */
    const yt = spawn(
      process.platform === "win32"
        ? "python"
        : "python3",
      [
        "-m",
        "yt_dlp",
        "--remote-components",
        "ejs:github",
        "-f",
        "bestaudio",
        "-o",
        "-",
        "--no-playlist",
        next.url,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    /*
     * Convert whatever audio yt-dlp gives us into
     * raw 48kHz stereo signed 16-bit PCM for Discord.
     */
    const ffmpeg = spawn(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "warning",
        "-i",
        "pipe:0",
        "-f",
        "s16le",
        "-ar",
        "48000",
        "-ac",
        "2",
        "pipe:1",
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    yt.stdout.pipe(ffmpeg.stdin);

    yt.stderr.on("data", (data) => {
      const message = data.toString().trim();

      if (message) {
        logger.warn(
          { message },
          "yt-dlp warning",
        );
      }
    });

    ffmpeg.stderr.on("data", (data) => {
      const message = data.toString().trim();

      if (message) {
        logger.debug(
          { message },
          "FFmpeg",
        );
      }
    });

    yt.on("error", (err) => {
      logger.error(
        { err },
        "yt-dlp process failed",
      );
    });

    ffmpeg.on("error", (err) => {
      logger.error(
        { err },
        "FFmpeg process failed",
      );
    });

    yt.on("close", (code) => {
      if (code !== 0) {
        logger.error(
          { code, url: next.url },
          "yt-dlp exited with an error",
        );
      }
    });

    ffmpeg.on("close", (code) => {
      if (code !== 0) {
        logger.error(
          { code },
          "FFmpeg exited with an error",
        );
      }
    });

    const resource = createAudioResource(
      ffmpeg.stdout,
      {
        inputType: StreamType.Raw,
        inlineVolume: true,
      },
    );

    resource.volume?.setVolume(
      state.volume / 100,
    );

    state.playback.stayConnected = true;
    state.startedAt = Date.now();

    state.playback.player.play(resource);
  } finally {
    state.advancing = false;
  }
}

function attachMusicListeners(state: MusicState) {
  state.playback.player.on(
    AudioPlayerStatus.Idle,
    () => {
      const guildId =
        state.playback.connection.joinConfig.guildId!;

      if (
        musicStates.get(guildId) === state
      ) {
        void playNext(state);
      }
    },
  );
}

async function requireMusicState(
  interaction: ChatInputCommandInteraction,
) {
  const guildId = interaction.guild!.id;
  const existing = musicStates.get(guildId);

  if (existing) {
    return existing;
  }

  const channel = getUserVoiceChannel(interaction);

  if (!channel) {
    await interaction.reply({
      content:
        "Join a voice channel first, or use /join to choose one.",
      ephemeral: true,
    });

    return null;
  }

  const state = getState(
    interaction,
    channel.id,
  );

  attachMusicListeners(state);

  return state;
}

export async function handleMusicInteraction(
  interaction: ChatInputCommandInteraction,
) {
  if (
    !MUSIC_COMMAND_NAMES.has(
      interaction.commandName,
    )
  ) {
    return false;
  }

  if (!interaction.guild) {
    await interaction.reply({
      content:
        "This command can only be used in a server.",
      ephemeral: true,
    });

    return true;
  }

  try {
    if (
      interaction.commandName === "search"
    ) {
      const query =
        interaction.options.getString(
          "query",
          true,
        );

      const results = await play.search(
        query,
        {
          limit: 5,
          source: {
            youtube: "video",
          },
        },
      );

      if (!results.length) {
        await interaction.reply({
          content:
            "No YouTube results found.",
          ephemeral: true,
        });

        return true;
      }

      await interaction.reply(
        results
          .map(
            (result, index) =>
              `${index + 1}. **${
                result.title ?? "Untitled"
              }** — ${result.url}`,
          )
          .join("\n"),
      );

      return true;
    }

    if (
      interaction.commandName === "pause" ||
      interaction.commandName === "resume"
    ) {
      const state =
        await requireMusicState(
          interaction,
        );

      if (!state) return true;

      if (
        interaction.commandName === "pause"
      ) {
        state.playback.player.pause();
      } else {
        state.playback.player.unpause();
      }

      await interaction.reply(
        interaction.commandName === "pause"
          ? "Playback paused."
          : "Playback resumed.",
      );

      return true;
    }

    if (
      interaction.commandName === "stop"
    ) {
      const state =
        musicStates.get(
          interaction.guild.id,
        );

      if (state) {
        state.queue = [];
        state.current = null;

        musicStates.delete(
          interaction.guild.id,
        );
      }

      destroyPlayback(
        interaction.guild.id,
      );

      await interaction.reply(
        "Playback stopped and the queue was cleared.",
      );

      return true;
    }

    if (
      interaction.commandName === "leave"
    ) {
      musicStates.delete(
        interaction.guild.id,
      );

      destroyPlayback(
        interaction.guild.id,
      );

      await interaction.reply(
        "Disconnected from voice.",
      );

      return true;
    }

    if (
      interaction.commandName === "clear"
    ) {
      const state =
        await requireMusicState(
          interaction,
        );

      if (!state) return true;

      state.queue = [];

      await interaction.reply(
        "Queue cleared.",
      );

      return true;
    }

    if (
      interaction.commandName === "queue"
    ) {
      const state =
        musicStates.get(
          interaction.guild.id,
        );

      if (
        !state ||
        (!state.current &&
          state.queue.length === 0)
      ) {
        await interaction.reply(
          "The queue is empty.",
        );

        return true;
      }

      const current = state.current
        ? `Now: **${state.current.title}**\n`
        : "";

      const upcoming =
        state.queue.length
          ? state.queue
              .map(
                (track, index) =>
                  `${index + 1}. ${track.title}`,
              )
              .join("\n")
          : "No upcoming tracks.";

      await interaction.reply(
        `${current}\n${upcoming}`,
      );

      return true;
    }

    if (
      interaction.commandName ===
      "nowplaying"
    ) {
      const state =
        musicStates.get(
          interaction.guild.id,
        );

      if (!state?.current) {
        await interaction.reply(
          "Nothing is playing.",
        );

        return true;
      }

      const elapsed = state.startedAt
        ? (Date.now() -
            state.startedAt) /
          1000
        : 0;

      await interaction.reply(
        `Now playing **${state.current.title}**\n${formatDuration(
          elapsed,
        )} / ${formatDuration(
          state.current.durationInSec,
        )}`,
      );

      return true;
    }

    if (
      interaction.commandName ===
      "volume"
    ) {
      const state =
        await requireMusicState(
          interaction,
        );

      if (!state) return true;

      state.volume =
        interaction.options.getInteger(
          "amount",
          true,
        );

      await interaction.reply(
        `Volume set to **${state.volume}%**.`,
      );

      return true;
    }

    if (
      interaction.commandName === "loop"
    ) {
      const state =
        await requireMusicState(
          interaction,
        );

      if (!state) return true;

      state.loop =
        interaction.options.getString(
          "mode",
          true,
        ) as LoopMode;

      await interaction.reply(
        `Loop mode set to **${state.loop}**.`,
      );

      return true;
    }

    if (
      interaction.commandName ===
      "autoplay"
    ) {
      const state =
        await requireMusicState(
          interaction,
        );

      if (!state) return true;

      state.autoplay =
        !state.autoplay;

      await interaction.reply(
        `Autoplay is now **${
          state.autoplay
            ? "on"
            : "off"
        }**.`,
      );

      return true;
    }

    if (
      interaction.commandName === "247"
    ) {
      const state =
        await requireMusicState(
          interaction,
        );

      if (!state) return true;

      state.stayConnected =
        !state.stayConnected;

      state.playback.stayConnected =
        state.stayConnected;

      await interaction.reply(
        `24/7 mode is now **${
          state.stayConnected
            ? "on"
            : "off"
        }**.`,
      );

      return true;
    }

    if (
      interaction.commandName ===
      "lyrics"
    ) {
      const state =
        musicStates.get(
          interaction.guild.id,
        );

      if (!state?.current) {
        await interaction.reply(
          "Nothing is playing.",
        );

        return true;
      }

      const lyrics =
        await findLyrics(
          "",
          state.current.title,
        );

      await interaction.reply(
        lyrics
          ? lyrics.slice(0, 1900)
          : "I couldn't find lyrics for this song.",
      );

      return true;
    }

    if (
      interaction.commandName === "skip" ||
      interaction.commandName === "back" ||
      interaction.commandName === "replay"
    ) {
      const state =
        await requireMusicState(
          interaction,
        );

      if (!state?.current) {
        await interaction.reply(
          "Nothing is playing.",
        );

        return true;
      }

      if (
        interaction.commandName === "back"
      ) {
        const previous =
          state.history.pop();

        if (!previous) {
          await interaction.reply(
            "There is no previous song.",
          );

          return true;
        }

        state.queue.unshift(
          previous,
        );
      }

      if (
        interaction.commandName ===
        "replay"
      ) {
        state.playback.player.stop();

        await playNext(
          state,
          true,
        );

        await interaction.reply(
          `Replaying **${state.current.title}**.`,
        );

        return true;
      }

      state.playback.player.stop();

      await playNext(
        state,
        true,
      );

      await interaction.reply(
        interaction.commandName === "skip"
          ? "Skipped."
          : "Playing the previous song.",
      );

      return true;
    }

    const query =
      interaction.options.getString(
        "song",
        true,
      );

    const requestedBy =
      interaction.user.username;

    const track =
      await resolveTrack(
        query,
        requestedBy,
      );

    if (!track) {
      await interaction.reply({
        content:
          "I couldn't find that song on YouTube.",
        ephemeral: true,
      });

      return true;
    }

    const state =
      await requireMusicState(
        interaction,
      );

    if (!state) return true;

    if (
      interaction.commandName ===
      "playtop"
    ) {
      state.queue.unshift(track);
    } else if (
      interaction.commandName ===
      "playskip"
    ) {
      state.queue.unshift(track);

      state.playback.player.stop();

      await playNext(
        state,
        true,
      );
    } else {
      state.queue.push(track);
    }

    if (!state.current) {
      await playNext(state);
    }

    await interaction.reply(
      interaction.commandName ===
      "playskip"
        ? `Playing **${track.title}** now.`
        : `Queued **${track.title}**.`,
    );

    return true;
  } catch (error) {
    logger.error(
      {
        err: error,
        guildId: interaction.guildId,
      },
      "Music command failed",
    );

    if (
      interaction.replied ||
      interaction.deferred
    ) {
      await interaction.editReply(
        "I couldn't complete that music command.",
      );
    } else {
      await interaction.reply({
        content:
          "I couldn't complete that music command.",
        ephemeral: true,
      });
    }

    return true;
  }
}

export {
  musicCommands,
};