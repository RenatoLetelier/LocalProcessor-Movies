import { describe, expect, it } from 'vitest'
import { aacChannelConfiguration, encodedChannels, hasStandardAacLayout, parseHexdump } from '../aac'

describe('AAC channel configuration', () => {
  it('reads channelConfiguration from the AudioSpecificConfig, with both escapes', () => {
    // aot 2, sfi 4 (44.1 kHz), cc 6: what the aac encoder writes for a 5.1
    expect(aacChannelConfiguration(Buffer.from([0x11, 0xb0]))).toBe(6)
    // aot 2, sfi 4, cc 0 and the PCE behind it: 5.1(side)
    expect(aacChannelConfiguration(Buffer.from([0x11, 0x80, 0x04, 0xc8]))).toBe(0)
    // aot 31 escapes to 6 more bits (00 0001) before sfi 4 and cc 6
    expect(aacChannelConfiguration(Buffer.from([0xf8, 0x28, 0xc0]))).toBe(6)
    // sfi 15 escapes to a 24-bit frequency (48000) before cc 6
    expect(aacChannelConfiguration(Buffer.from([0x17, 0x80, 0x5d, 0xc0, 0x30]))).toBe(6)
    expect(aacChannelConfiguration(Buffer.from([0x11]))).toBeNull()
    expect(aacChannelConfiguration(Buffer.from([0x17, 0x80]))).toBeNull()
  })

  it('reads the -show_data hexdump without the ASCII column', () => {
    const dump = '\n00000000: 1180 04c8 4400 2000 c40d 4c61 7663 3631  ....D. ...Lavc61\n00000010: 2e31 392e 3130 3156 e500                 .19.101V..\n'
    expect(parseHexdump(dump).toString('hex')).toBe('118004c844002000c40d4c61766336312e31392e31303156e500')
  })

  it('trusts the extradata over the layout name, and the name only when there is no extradata', () => {
    expect(hasStandardAacLayout({ channels: 6, channelLayout: '5.1', aacChannelConfig: null })).toBe(true)
    expect(hasStandardAacLayout({ channels: 6, channelLayout: '5.1(side)', aacChannelConfig: null })).toBe(false)
    expect(hasStandardAacLayout({ channels: 6, channelLayout: '5.1(side)', aacChannelConfig: 6 })).toBe(true)
    expect(hasStandardAacLayout({ channels: 6, channelLayout: '5.1', aacChannelConfig: 0 })).toBe(false)
    expect(hasStandardAacLayout({ channels: 2, channelLayout: null, aacChannelConfig: null })).toBe(true)
  })

  it('encodes up to stereo as is and anything wider as 5.1', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(encodedChannels)).toEqual([1, 2, 6, 6, 6, 6, 6, 6])
  })
})
