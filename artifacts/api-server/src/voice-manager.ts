import {
  AudioPlayerStatus,
  createAudioPlayer,
  joinVoiceChannel,
  type AudioPlayer,
  type VoiceConnection,
} from "@discordjs/voice";
import { logger } from "./lib/logger";

export type GuildPlayback = {
  connection: VoiceConnection;
  player: AudioPlayer;
  cleanupTimer?: NodeJS.Timeout;
  voiceChannelId: string;
  stayConnected: boolean;
};

export const activePlayback = new Map<string, GuildPlayback>();

export function destroyPlayback(guildId: string) {
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
  if (!playback || playback.stayConnected) return;

  playback.cleanupTimer = setTimeout(() => {
    const current = activePlayback.get(guildId);
    if (current === playback && current.player.state.status === AudioPlayerStatus.Idle) {
      destroyPlayback(guildId);
    }
  }, 1_000);
}

export function createPlayback(
  guildId: string,
  voiceChannelId: string,
  adapterCreator: Parameters<typeof joinVoiceChannel>[0]["adapterCreator"],
  stayConnected: boolean,
) {
  const existing = activePlayback.get(guildId);

  if (existing?.voiceChannelId === voiceChannelId) {
    existing.stayConnected = existing.stayConnected || stayConnected;
    return existing;
  }

  if (existing) {
    destroyPlayback(guildId);
  }

  const connection = joinVoiceChannel({
    channelId: voiceChannelId,
    guildId,
    adapterCreator,
    selfDeaf: true,
  });
  const player = createAudioPlayer();
  const playback: GuildPlayback = {
    connection,
    player,
    voiceChannelId,
    stayConnected,
  };

  activePlayback.set(guildId, playback);

  player.on(AudioPlayerStatus.Idle, () => {
    schedulePlaybackCleanup(guildId);
  });
  player.on("error", (error) => {
    logger.error({ err: error, guildId }, "Audio playback error");
    destroyPlayback(guildId);
  });

  connection.subscribe(player);
  return playback;
}