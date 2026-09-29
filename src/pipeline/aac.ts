import type { SourceAudio } from './types'

// The ffmpeg layout names the aac encoder writes with a standard MPEG-4
// channelConfiguration (1 to 7), which the decoder reports back for those values.
// Anything else (5.1(side), 7.1(wide), quad, or no name at all) is written with
// channelConfiguration=0 plus a program config element (PCE) in the
// AudioSpecificConfig, and Chrome's MP4 demuxer does not parse PCEs: the append
// fails with CHUNK_DEMUXER_ERROR_APPEND_FAILED, hls.js retries recoverMediaError in
// a loop and the movie stays black with no message. Careful with 8 channels: in
// ffmpeg "7.1" is the native configuration 7 and "7.1(wide)" goes with a PCE.
const MPEG4_CHANNEL_LAYOUTS = new Set(['mono', 'stereo', '3.0', '4.0', '5.0', '5.1', '7.1'])

// Encoding ceiling: the aac encoder handles up to 7.1, but 5.1 is what every browser decodes
export const MAX_ENCODED_AAC_CHANNELS = 6

// Output channels when encoding to AAC. Mono and stereo stay; three channels and up
// become 5.1, because "-ac 3" is 2.1 with the centre (the dialogue) sent to the LFE,
// and 4/5/7 would need layouts that are either non-standard or written with a PCE.
export function encodedChannels(sourceChannels: number): number {
  return sourceChannels <= 2 ? Math.max(1, sourceChannels) : MAX_ENCODED_AAC_CHANNELS
}

// A source AAC is copied only if Chrome will open it. What decides is the
// channelConfiguration of the AudioSpecificConfig, read from the extradata: the
// layout name is what the decoder rebuilds, and a hand-written PCE for 5.1 or stereo
// is reported with a standard name yet Chrome still rejects it. Without extradata
// (AAC in ADTS, inside a .ts) the name is all there is, and one or two channels are
// unambiguous even when ffprobe does not name them.
export function hasStandardAacLayout(track: Pick<SourceAudio, 'channels' | 'channelLayout' | 'aacChannelConfig'>): boolean {
  if (track.aacChannelConfig !== null) return track.aacChannelConfig >= 1 && track.aacChannelConfig <= 7
  const layout = track.channelLayout ?? (track.channels === 1 ? 'mono' : track.channels === 2 ? 'stereo' : '')
  return MPEG4_CHANNEL_LAYOUTS.has(layout)
}

// The hexdump of ffprobe -show_data ("00000000: 1190 5680  ....") back to bytes
export function parseHexdump(dump: string): Buffer {
  const hex = dump
    .split('\n')
    .map((line) => line.replace(/^\s*[0-9a-f]{8}:\s*/i, '').split(/\s{2,}/)[0] ?? '')
    .join('')
    .replace(/\s+/g, '')
  return Buffer.from(hex, 'hex')
}

// channelConfiguration of an AudioSpecificConfig (ISO 14496-3 §1.6.2.1): 5 bits of
// audioObjectType (31 escapes to 6 more), 4 of samplingFrequencyIndex (15 escapes to
// a 24-bit frequency) and 4 of channelConfiguration. ffprobe does not show it.
export function aacChannelConfiguration(asc: Buffer): number | null {
  let bit = 0
  const read = (n: number): number => {
    let value = 0
    for (let i = 0; i < n; i++, bit++) value = (value << 1) | ((asc[bit >> 3]! >> (7 - (bit & 7))) & 1)
    return value
  }
  if (asc.length < 2) return null
  if (read(5) === 31) read(6)
  if (read(4) === 15) read(24)
  if (bit + 4 > asc.length * 8) return null
  return read(4)
}
