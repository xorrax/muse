import {VoiceChannel, Snowflake} from 'discord.js';
import {Readable} from 'stream';
import hasha from 'hasha';
import ytdl, {videoFormat} from '@distube/ytdl-core';
import {WriteStream} from 'fs-capacitor';
import ffmpeg from 'fluent-ffmpeg';
import shuffle from 'array-shuffle';
import {
  AudioPlayer,
  AudioPlayerState,
  AudioPlayerStatus, AudioResource,
  createAudioPlayer,
  createAudioResource, DiscordGatewayAdapterCreator,
  joinVoiceChannel,
  StreamType,
  VoiceConnection,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import FileCacheProvider from './file-cache.js';
import debug from '../utils/debug.js';
import {getGuildSettings} from '../utils/get-guild-settings.js';
import {buildPlayingMessageEmbed} from '../utils/build-embed.js';

export enum MediaSource {
  Youtube,
  HLS,
}

export interface QueuedPlaylist {
  title: string;
  source: string;
}

export interface SongMetadata {
  title: string;
  artist: string;
  url: string; // For YT, it's the video ID (not the full URI)
  length: number;
  offset: number;
  playlist: QueuedPlaylist | null;
  isLive: boolean;
  thumbnailUrl: string | null;
  source: MediaSource;
}
export interface QueuedSong extends SongMetadata {
  addedInChannelId: Snowflake;
  requestedBy: string;
}

export enum STATUS {
  PLAYING,
  PAUSED,
  IDLE,
}

export interface PlayerEvents {
  statusChange: (oldStatus: STATUS, newStatus: STATUS) => void;
}

type YTDLVideoFormat = videoFormat & {loudnessDb?: number};

export const DEFAULT_VOLUME = 100;

export default class {
  public voiceConnection: VoiceConnection | null = null;
  public status = STATUS.PAUSED;
  public guildId: string;
  public loopCurrentSong = false;
  public loopCurrentQueue = false;
  private currentChannel: VoiceChannel | undefined;
  private queue: QueuedSong[] = [];
  private queuePosition = 0;
  private audioPlayer: AudioPlayer | null = null;
  private audioResource: AudioResource | null = null;
  private volume?: number;
  private defaultVolume: number = DEFAULT_VOLUME;
  private nowPlaying: QueuedSong | null = null;
  private playPositionInterval: NodeJS.Timeout | undefined;
  private lastSongURL = '';

  private positionInSeconds = 0;
  private readonly fileCache: FileCacheProvider;
  private disconnectTimer: NodeJS.Timeout | null = null;

  private agent = null;

  constructor(fileCache: FileCacheProvider, guildId: string) {
    this.fileCache = fileCache;
    this.guildId = guildId;
  }

  async connect(channel: VoiceChannel): Promise<void> {
    // Always get freshest default volume setting value
    const settings = await getGuildSettings(this.guildId);

    const {defaultVolume = DEFAULT_VOLUME} = settings;
    this.defaultVolume = defaultVolume;

    this.voiceConnection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator as DiscordGatewayAdapterCreator,
    });

    // Workaround to disable keepAlive
    this.voiceConnection.on('stateChange', (oldState, newState) => {
      /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
      const oldNetworking = Reflect.get(oldState, 'networking');
      const newNetworking = Reflect.get(newState, 'networking');

      const networkStateChangeHandler = (_: any, newNetworkState: any) => {
        const newUdp = Reflect.get(newNetworkState, 'udp');
        clearInterval(newUdp?.keepAliveInterval);
      };

      oldNetworking?.off('stateChange', networkStateChangeHandler);
      newNetworking?.on('stateChange', networkStateChangeHandler);
      /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */

      this.currentChannel = channel;
    });
  }

  disconnect(): void {
    if (this.voiceConnection) {
      if (this.status === STATUS.PLAYING) {
        this.pause();
      }

      this.loopCurrentSong = false;
      this.voiceConnection.destroy();
      this.audioPlayer?.stop(true);

      this.voiceConnection = null;
      this.audioPlayer = null;
      this.audioResource = null;
    }
  }

  async seek(positionSeconds: number): Promise<void> {
    this.status = STATUS.PAUSED;

    if (this.voiceConnection === null) {
      throw new Error('Not connected to a voice channel.');
    }

    const currentSong = this.getCurrent();

    if (!currentSong) {
      throw new Error('No song currently playing');
    }

    if (positionSeconds > currentSong.length) {
      throw new Error('Seek position is outside the range of the song.');
    }

    let realPositionSeconds = positionSeconds;
    let to: number | undefined;
    if (currentSong.offset !== undefined) {
      realPositionSeconds += currentSong.offset;
      to = currentSong.length + currentSong.offset;
    }

    const stream = await this.getStream(currentSong, {seek: realPositionSeconds, to});
    this.audioPlayer = createAudioPlayer({
      behaviors: {
        // Needs to be somewhat high for livestreams
        maxMissedFrames: 50,
      },
    });
    this.voiceConnection.subscribe(this.audioPlayer);
    this.playAudioPlayerResource(this.createAudioStream(stream));
    this.attachListeners();
    this.startTrackingPosition(positionSeconds);

    this.status = STATUS.PLAYING;
  }

  async forwardSeek(positionSeconds: number): Promise<void> {
    return this.seek(this.positionInSeconds + positionSeconds);
  }

  getPosition(): number {
    return this.positionInSeconds;
  }

  async play(): Promise<void> {
    if (this.voiceConnection === null) {
      throw new Error('Not connected to a voice channel.');
    }

    const currentSong = this.getCurrent();

    if (!currentSong) {
      throw new Error('Queue empty.');
    }

    // Cancel any pending idle disconnection
    if (this.disconnectTimer) {
      clearInterval(this.disconnectTimer);
      this.disconnectTimer = null;
    }

    // Resume from paused state
    if (this.status === STATUS.PAUSED && currentSong.url === this.nowPlaying?.url) {
      if (this.audioPlayer) {
        this.audioPlayer.unpause();
        this.status = STATUS.PLAYING;
        this.startTrackingPosition();
        return;
      }

      // Was disconnected, need to recreate stream
      if (!currentSong.isLive) {
        return this.seek(this.getPosition());
      }
    }

    try {
      let positionSeconds: number | undefined;
      let to: number | undefined;
      if (currentSong.offset !== undefined) {
        positionSeconds = currentSong.offset;
        to = currentSong.length + currentSong.offset;
      }

      const stream = await this.getStream(currentSong, {seek: positionSeconds, to});
      this.audioPlayer = createAudioPlayer({
        behaviors: {
          // Needs to be somewhat high for livestreams
          maxMissedFrames: 50,
        },
      });
      this.voiceConnection.subscribe(this.audioPlayer);
      this.playAudioPlayerResource(this.createAudioStream(stream));

      this.attachListeners();

      this.status = STATUS.PLAYING;
      this.nowPlaying = currentSong;

      if (currentSong.url === this.lastSongURL) {
        this.startTrackingPosition();
      } else {
        // Reset position counter
        this.startTrackingPosition(0);
        this.lastSongURL = currentSong.url;
      }
    } catch (error: unknown) {
      await this.forward(1);

      if ((error as {statusCode: number}).statusCode === 410 && currentSong) {
        const channelId = currentSong.addedInChannelId;

        if (channelId) {
          debug(`${currentSong.title} is unavailable`);
          return;
        }
      }

      throw error;
    }
  }

  pause(): void {
    if (this.status !== STATUS.PLAYING) {
      throw new Error('Not currently playing.');
    }

    this.status = STATUS.PAUSED;

    if (this.audioPlayer) {
      this.audioPlayer.pause();
    }

    this.stopTrackingPosition();
  }

  async forward(skip: number): Promise<void> {
    this.manualForward(skip);

    try {
      if (this.getCurrent() && this.status !== STATUS.PAUSED) {
        await this.play();
      } else {
        this.status = STATUS.IDLE;
        this.audioPlayer?.stop(true);

        const settings = await getGuildSettings(this.guildId);

        const {secondsToWaitAfterQueueEmpties} = settings;
        if (secondsToWaitAfterQueueEmpties !== 0) {
          this.disconnectTimer = setTimeout(() => {
            // Make sure we are not accidentally playing
            // when disconnecting
            if (this.status === STATUS.IDLE) {
              this.disconnect();
            }
          }, secondsToWaitAfterQueueEmpties * 1000);
        }
      }
    } catch (error: unknown) {
      this.queuePosition--;
      throw error;
    }
  }

  canGoForward(skip: number) {
    return (this.queuePosition + skip - 1) < this.queue.length;
  }

  manualForward(skip: number): void {
    if (this.canGoForward(skip)) {
      this.queuePosition += skip;
      this.positionInSeconds = 0;
      this.stopTrackingPosition();
    } else {
      throw new Error('No songs in queue to forward to.');
    }
  }

  canGoBack() {
    return this.queuePosition - 1 >= 0;
  }

  async back(): Promise<void> {
    if (this.canGoBack()) {
      this.queuePosition--;
      this.positionInSeconds = 0;
      this.stopTrackingPosition();

      if (this.status !== STATUS.PAUSED) {
        await this.play();
      }
    } else {
      throw new Error('No songs in queue to go back to.');
    }
  }

  getCurrent(): QueuedSong | null {
    if (this.queue[this.queuePosition]) {
      return this.queue[this.queuePosition];
    }

    return null;
  }

  /**
   * Returns queue, not including the current song.
   * @returns {QueuedSong[]}
   */
  getQueue(): QueuedSong[] {
    return this.queue.slice(this.queuePosition + 1);
  }

  add(song: QueuedSong, {immediate = false} = {}): void {
    if (song.playlist || !immediate) {
      // Add to end of queue
      this.queue.push(song);
    } else {
      // Add as the next song to be played
      const insertAt = this.queuePosition + 1;
      this.queue = [...this.queue.slice(0, insertAt), song, ...this.queue.slice(insertAt)];
    }
  }

  shuffle(): void {
    const shuffledSongs = shuffle(this.queue.slice(this.queuePosition + 1));

    this.queue = [...this.queue.slice(0, this.queuePosition + 1), ...shuffledSongs];
  }

  clear(): void {
    const newQueue = [];

    // Don't clear curently playing song
    const current = this.getCurrent();

    if (current) {
      newQueue.push(current);
    }

    this.queuePosition = 0;
    this.queue = newQueue;
  }

  removeFromQueue(index: number, amount = 1): void {
    this.queue.splice(this.queuePosition + index, amount);
  }

  removeCurrent(): void {
    this.queue = [...this.queue.slice(0, this.queuePosition), ...this.queue.slice(this.queuePosition + 1)];
  }

  queueSize(): number {
    return this.getQueue().length;
  }

  isQueueEmpty(): boolean {
    return this.queueSize() === 0;
  }

  stop(): void {
    this.disconnect();
    this.queuePosition = 0;
    this.queue = [];
  }

  move(from: number, to: number): QueuedSong {
    if (from > this.queueSize() || to > this.queueSize()) {
      throw new Error('Move index is outside the range of the queue.');
    }

    this.queue.splice(this.queuePosition + to, 0, this.queue.splice(this.queuePosition + from, 1)[0]);

    return this.queue[this.queuePosition + to];
  }

  setVolume(level: number): void {
    // Level should be a number between 0 and 100 = 0% => 100%
    this.volume = level;
    this.setAudioPlayerVolume(level);
  }

  getVolume(): number {
    // Only use default volume if player volume is not already set (in the event of a reconnect we shouldn't reset)
    return this.volume ?? this.defaultVolume;
  }

  private getHashForCache(url: string): string {
    return hasha(url);
  }

  private async getStream(song: QueuedSong, options: {seek?: number; to?: number} = {}): Promise<Readable> {
    if (this.status === STATUS.PLAYING) {
      this.audioPlayer?.stop();
    } else if (this.status === STATUS.PAUSED) {
      this.audioPlayer?.stop(true);
    }

    if (song.source === MediaSource.HLS) {
      return this.createReadStream({url: song.url, cacheKey: song.url});
    }

    let ffmpegInput: string | null;
    const ffmpegInputOptions: string[] = [];
    let shouldCacheVideo = false;

    let format: YTDLVideoFormat | undefined;

    ffmpegInput = await this.fileCache.getPathFor(this.getHashForCache(song.url));
    const agentOptions = {
      pipelining: 5,
      maxRedirections: 0,
      localAddress: "16.16.97.85"
    };
    const cookies = [
      {
          "domain": ".youtube.com",
          "expirationDate": 1738951927.841419,
          "hostOnly": false,
          "httpOnly": false,
          "name": "__Secure-1PAPISID",
          "path": "/",
          "sameSite": "unspecified",
          "secure": true,
          "storeId": "1",
          "value": "P6TOLbxQU6WlPd-l/ApDbWx2mdVn4VfxX5",
          "id": 1
      },
      {
          "domain": ".youtube.com",
          "expirationDate": 1738951927.841473,
          "hostOnly": false,
          "httpOnly": true,
          "name": "__Secure-1PSID",
          "path": "/",
          "sameSite": "unspecified",
          "secure": true,
          "storeId": "1",
          "value": "g.a000mwhslec-57tTABpzNCDjbKLO_vI4nyDfxf85hbAYgcRtFNOsH0V73feeBD3eYP6E6UDwngACgYKAY0SARISFQHGX2MiUVCzOZPtCibRBf5nu21roRoVAUF8yKrFAMHurZodKp20P9C7Cz6y0076",
          "id": 2
      },
      {
          "domain": ".youtube.com",
          "expirationDate": 1738952542.446835,
          "hostOnly": false,
          "httpOnly": true,
          "name": "__Secure-1PSIDCC",
          "path": "/",
          "sameSite": "unspecified",
          "secure": true,
          "storeId": "1",
          "value": "AKEyXzXNNcau7h97C27SrGrRYx4TJnR_qRh1WYJFNtOWLG7LBTiN7O0rfznIFy6mg2Rmwculmw",
          "id": 3
      },
      {
          "domain": ".youtube.com",
          "expirationDate": 1738952534.524858,
          "hostOnly": false,
          "httpOnly": true,
          "name": "__Secure-1PSIDTS",
          "path": "/",
          "sameSite": "unspecified",
          "secure": true,
          "storeId": "1",
          "value": "sidts-CjEBUFGoh0MSUX8C7-Iib_IEBK0pD4RbYSnkadkUbOEiey4yDBJy-gudYP3-Cl_wRZC4EAA",
          "id": 4
      },
      {
          "domain": ".youtube.com",
          "expirationDate": 1738951927.841435,
          "hostOnly": false,
          "httpOnly": false,
          "name": "__Secure-3PAPISID",
          "path": "/",
          "sameSite": "no_restriction",
          "secure": true,
          "storeId": "1",
          "value": "P6TOLbxQU6WlPd-l/ApDbWx2mdVn4VfxX5",
          "id": 5
      },
      {
          "domain": ".youtube.com",
          "expirationDate": 1738951927.84149,
          "hostOnly": false,
          "httpOnly": true,
          "name": "__Secure-3PSID",
          "path": "/",
          "sameSite": "no_restriction",
          "secure": true,
          "storeId": "1",
          "value": "g.a000mwhslec-57tTABpzNCDjbKLO_vI4nyDfxf85hbAYgcRtFNOsai1kPOn8FLTyPnUihGQIEQACgYKAcISARISFQHGX2Mi98aUb_v5XwIADJyXeA7JHRoVAUF8yKoUyJIpawfmCDIPLjyuZIj60076",
          "id": 6
      },
      {
          "domain": ".youtube.com",
          "expirationDate": 1738952542.446894,
          "hostOnly": false,
          "httpOnly": true,
          "name": "__Secure-3PSIDCC",
          "path": "/",
          "sameSite": "no_restriction",
          "secure": true,
          "storeId": "1",
          "value": "AKEyXzVOdZRApY94qJ0qYulHTEJwLFuocasLdPoUJRbknZti0n5EZXmQH5T1I3hnpxNSP5zliQ",
          "id": 7
      },
      {
          "domain": ".youtube.com",
          "expirationDate": 1738952534.525026,
          "hostOnly": false,
          "httpOnly": true,
          "name": "__Secure-3PSIDTS",
          "path": "/",
          "sameSite": "no_restriction",
          "secure": true,
          "storeId": "1",
          "value": "sidts-CjEBUFGoh0MSUX8C7-Iib_IEBK0pD4RbYSnkadkUbOEiey4yDBJy-gudYP3-Cl_wRZC4EAA",
          "id": 8
      },
      {
          "domain": ".youtube.com",
          "expirationDate": 1738951927.841385,
          "hostOnly": false,
          "httpOnly": false,
          "name": "APISID",
          "path": "/",
          "sameSite": "unspecified",
          "secure": false,
          "storeId": "1",
          "value": "exFwkVYnpQP2UwWj/AA82ZTLz_M7OgHUN_",
          "id": 9
      },
      {
          "domain": ".youtube.com",
          "expirationDate": 1723401631.787476,
          "hostOnly": false,
          "httpOnly": true,
          "name": "GPS",
          "path": "/",
          "sameSite": "unspecified",
          "secure": true,
          "storeId": "1",
          "value": "1",
          "id": 10
      },
      {
          "domain": ".youtube.com",
          "expirationDate": 1738951927.84135,
          "hostOnly": false,
          "httpOnly": true,
          "name": "HSID",
          "path": "/",
          "sameSite": "unspecified",
          "secure": false,
          "storeId": "1",
          "value": "A1G8ReRkHpTQdB73N",
          "id": 11
      },
      {
          "domain": ".youtube.com",
          "expirationDate": 1738951928.185387,
          "hostOnly": false,
          "httpOnly": true,
          "name": "LOGIN_INFO",
          "path": "/",
          "sameSite": "no_restriction",
          "secure": true,
          "storeId": "1",
          "value": "AFmmF2swRQIgIbHFlWI8s5lDQyjPECNlGObhBpVfRaiZyoBKJau6CxcCIQDOWF7c5ROkcJK6OkK08CAe1TfNSNlidgt2_ylNcpq45w:QUQ3MjNmd1Fuc3pSVGwwQjZ0SWthNjdKOVFMUXI3STJkN3ctTkdLMjExbUkwUXN6Z3ZZd2Y1aDlDbVpNWThkSTVzQ0RfNUw5RmNrazhxdUhsQVFZZXdqd1VpQ0g2Wl9tZWZLem5CSXpHMm5YRmYySXExcFh2SXdfSWJXbTJ2RXdXMENWNlJ4a1F3NWcyUU5RVUkxYnRkalExbnFPMHIxaWNB",
          "id": 12
      },
      {
          "domain": ".youtube.com",
          "expirationDate": 1738951931.33011,
          "hostOnly": false,
          "httpOnly": true,
          "name": "NID",
          "path": "/",
          "sameSite": "unspecified",
          "secure": true,
          "storeId": "1",
          "value": "516=KI_kjXGJS6pM5PB3EoIxRmeHlCOTMtRA9J1QKa4UVGtoskwbFG0WSiqe-VbZuT9XfRQGWw-WMkcH8YnGCYGHpQih1dLzSs_W6SLhAv3-iFCEZ8kDEPjiwlc52_L3CNMfCtnga6NUrqkpziYUiUJIGEJ6FuPdlhkLIQHROSgDcJCfr-He3l4VLsyolw",
          "id": 13
      },
      {
          "domain": ".youtube.com",
          "expirationDate": 1724004834.426217,
          "hostOnly": false,
          "httpOnly": false,
          "name": "PREF",
          "path": "/",
          "sameSite": "unspecified",
          "secure": true,
          "storeId": "1",
          "value": "f6=40000000&tz=Europe.Stockholm",
          "id": 14
      },
      {
          "domain": ".youtube.com",
          "expirationDate": 1738951927.841402,
          "hostOnly": false,
          "httpOnly": false,
          "name": "SAPISID",
          "path": "/",
          "sameSite": "unspecified",
          "secure": true,
          "storeId": "1",
          "value": "P6TOLbxQU6WlPd-l/ApDbWx2mdVn4VfxX5",
          "id": 15
      },
      {
          "domain": ".youtube.com",
          "expirationDate": 1738951927.841455,
          "hostOnly": false,
          "httpOnly": false,
          "name": "SID",
          "path": "/",
          "sameSite": "unspecified",
          "secure": false,
          "storeId": "1",
          "value": "g.a000mwhslec-57tTABpzNCDjbKLO_vI4nyDfxf85hbAYgcRtFNOs_ynRNCBFMwLpdvtQB6nfCAACgYKASsSARISFQHGX2MiqNuvrzdIc0t4xhg3VVaVARoVAUF8yKpgEAuqS-SK-u68NqeQshD30076",
          "id": 16
      },
      {
          "domain": ".youtube.com",
          "expirationDate": 1738952542.44663,
          "hostOnly": false,
          "httpOnly": false,
          "name": "SIDCC",
          "path": "/",
          "sameSite": "unspecified",
          "secure": false,
          "storeId": "1",
          "value": "AKEyXzWbCxBL5xLmy0MMfkazDimKhRB58CqE45RxBuOibCnhOimOdX6JhANOzfJyz1tTJ-o5",
          "id": 17
      },
      {
          "domain": ".youtube.com",
          "hostOnly": false,
          "httpOnly": false,
          "name": "SOCS",
          "path": "/",
          "sameSite": "unspecified",
          "secure": true,
          "storeId": "1",
          "value": "CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjMwODI5LjA3X3AxGgJlbiADGgYIgJnPpwY",
          "id": 18
      },
      {
          "domain": ".youtube.com",
          "expirationDate": 1738951927.841368,
          "hostOnly": false,
          "httpOnly": true,
          "name": "SSID",
          "path": "/",
          "sameSite": "unspecified",
          "secure": true,
          "storeId": "1",
          "value": "A2Vv-AkMMx40k6AYR",
          "id": 19
      }
    ];
    const agent = ytdl.createAgent(cookies,
      agentOptions);

    if (!ffmpegInput) {
      // Not yet cached, must download
      const info = await ytdl.getInfo(song.url, {agent});

      const formats = info.formats as YTDLVideoFormat[];

      const filter = (format: ytdl.videoFormat): boolean => format.codecs === 'opus' && format.container === 'webm' && format.audioSampleRate !== undefined && parseInt(format.audioSampleRate, 10) === 48000;

      format = formats.find(filter);

      const nextBestFormat = (formats: ytdl.videoFormat[]): ytdl.videoFormat | undefined => {
        if (formats[0].isLive) {
          formats = formats.sort((a, b) => (b as unknown as {audioBitrate: number}).audioBitrate - (a as unknown as {audioBitrate: number}).audioBitrate); // Bad typings

          return formats.find(format => [128, 127, 120, 96, 95, 94, 93].includes(parseInt(format.itag as unknown as string, 10))); // Bad typings
        }

        formats = formats
          .filter(format => format.averageBitrate)
          .sort((a, b) => {
            if (a && b) {
              return b.averageBitrate! - a.averageBitrate!;
            }

            return 0;
          });
        return formats.find(format => !format.bitrate) ?? formats[0];
      };

      if (!format) {
        format = nextBestFormat(info.formats);

        if (!format) {
          // If still no format is found, throw
          throw new Error('Can\'t find suitable format.');
        }
      }

      debug('Using format', format);

      ffmpegInput = format.url;

      // Don't cache livestreams or long videos
      const MAX_CACHE_LENGTH_SECONDS = 30 * 60; // 30 minutes
      shouldCacheVideo = !info.player_response.videoDetails.isLiveContent && parseInt(info.videoDetails.lengthSeconds, 10) < MAX_CACHE_LENGTH_SECONDS && !options.seek;

      debug(shouldCacheVideo ? 'Caching video' : 'Not caching video');

      ffmpegInputOptions.push(...[
        '-reconnect',
        '1',
        '-reconnect_streamed',
        '1',
        '-reconnect_delay_max',
        '5',
      ]);
    }

    if (options.seek) {
      ffmpegInputOptions.push('-ss', options.seek.toString());
    }

    if (options.to) {
      ffmpegInputOptions.push('-to', options.to.toString());
    }

    return this.createReadStream({
      url: ffmpegInput,
      cacheKey: song.url,
      ffmpegInputOptions,
      cache: shouldCacheVideo,
      volumeAdjustment: format?.loudnessDb ? `${-format.loudnessDb}dB` : undefined,
    });
  }

  private startTrackingPosition(initalPosition?: number): void {
    if (initalPosition !== undefined) {
      this.positionInSeconds = initalPosition;
    }

    if (this.playPositionInterval) {
      clearInterval(this.playPositionInterval);
    }

    this.playPositionInterval = setInterval(() => {
      this.positionInSeconds++;
    }, 1000);
  }

  private stopTrackingPosition(): void {
    if (this.playPositionInterval) {
      clearInterval(this.playPositionInterval);
    }
  }

  private attachListeners(): void {
    if (!this.voiceConnection) {
      return;
    }

    if (this.voiceConnection.listeners(VoiceConnectionStatus.Disconnected).length === 0) {
      this.voiceConnection.on(VoiceConnectionStatus.Disconnected, this.onVoiceConnectionDisconnect.bind(this));
    }

    if (!this.audioPlayer) {
      return;
    }

    if (this.audioPlayer.listeners('stateChange').length === 0) {
      this.audioPlayer.on(AudioPlayerStatus.Idle, this.onAudioPlayerIdle.bind(this));
    }
  }

  private onVoiceConnectionDisconnect(): void {
    this.disconnect();
  }

  private async onAudioPlayerIdle(_oldState: AudioPlayerState, newState: AudioPlayerState): Promise<void> {
    // Automatically advance queued song at end
    if (this.loopCurrentSong && newState.status === AudioPlayerStatus.Idle && this.status === STATUS.PLAYING) {
      await this.seek(0);
      return;
    }

    // Automatically re-add current song to queue
    if (this.loopCurrentQueue && newState.status === AudioPlayerStatus.Idle && this.status === STATUS.PLAYING) {
      const currentSong = this.getCurrent();

      if (currentSong) {
        this.add(currentSong);
      } else {
        throw new Error('No song currently playing.');
      }
    }

    if (newState.status === AudioPlayerStatus.Idle && this.status === STATUS.PLAYING) {
      await this.forward(1);
      // Auto announce the next song if configured to
      const settings = await getGuildSettings(this.guildId);
      const {autoAnnounceNextSong} = settings;
      if (autoAnnounceNextSong && this.currentChannel) {
        await this.currentChannel.send({
          embeds: this.getCurrent() ? [buildPlayingMessageEmbed(this)] : [],
        });
      }
    }
  }

  private async createReadStream(options: {url: string; cacheKey: string; ffmpegInputOptions?: string[]; cache?: boolean; volumeAdjustment?: string}): Promise<Readable> {
    return new Promise((resolve, reject) => {
      const capacitor = new WriteStream();

      if (options?.cache) {
        const cacheStream = this.fileCache.createWriteStream(this.getHashForCache(options.cacheKey));
        capacitor.createReadStream().pipe(cacheStream);
      }

      const returnedStream = capacitor.createReadStream();
      let hasReturnedStreamClosed = false;

      const stream = ffmpeg(options.url)
        .inputOptions(options?.ffmpegInputOptions ?? ['-re'])
        .noVideo()
        .audioCodec('libopus')
        .outputFormat('webm')
        .addOutputOption(['-filter:a', `volume=${options?.volumeAdjustment ?? '1'}`])
        .on('error', error => {
          if (!hasReturnedStreamClosed) {
            reject(error);
          }
        })
        .on('start', command => {
          debug(`Spawned ffmpeg with ${command as string}`);
        });

      stream.pipe(capacitor);

      returnedStream.on('close', () => {
        if (!options.cache) {
          stream.kill('SIGKILL');
        }

        hasReturnedStreamClosed = true;
      });

      resolve(returnedStream);
    });
  }

  private createAudioStream(stream: Readable) {
    return createAudioResource(stream, {
      inputType: StreamType.WebmOpus,
      inlineVolume: true,
    });
  }

  private playAudioPlayerResource(resource: AudioResource) {
    if (this.audioPlayer !== null) {
      this.audioResource = resource;
      this.setAudioPlayerVolume();
      this.audioPlayer.play(this.audioResource);
    }
  }

  private setAudioPlayerVolume(level?: number) {
    // Audio resource expects a float between 0 and 1 to represent level percentage
    this.audioResource?.volume?.setVolume((level ?? this.getVolume()) / 100);
  }
}
