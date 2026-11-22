import { describe, expect, it } from 'vitest'
import { clock, parseChapters, playerUrl } from './chapters'

describe('parseChapters', () => {
  it('reads the chapter text the Video Maker saves', () => {
    const text = '0:00 Introduction\n0:35 Trade 1 · Breakout · +1.20%\n12:05 Trade 2 · Reversal · -0.40% (open)'
    expect(parseChapters(text)).toEqual([
      { sec: 0, title: 'Introduction' },
      { sec: 35, title: 'Trade 1 · Breakout · +1.20%' },
      { sec: 725, title: 'Trade 2 · Reversal · -0.40% (open)' },
    ])
  })
  it('reads hours, separators and Windows line ends, and sorts by time', () => {
    expect(parseChapters('1:02:03 - Late\r\n0:10 – Early')).toEqual([{ sec: 10, title: 'Early' }, { sec: 3723, title: 'Late' }])
  })
  it('ignores lines that are not a timestamp and impossible times', () => {
    expect(parseChapters('Chapters:\n0:61 bad\n1:75:00 bad\nnot a line\n0:05 ok')).toEqual([{ sec: 5, title: 'ok' }])
  })
  it('names an untitled chapter and tolerates empty input', () => {
    expect(parseChapters('0:00')).toEqual([{ sec: 0, title: 'Chapter 1' }])
    expect(parseChapters('')).toEqual([])
    expect(parseChapters(null)).toEqual([])
    expect(parseChapters(undefined)).toEqual([])
  })
})

describe('clock', () => {
  it('formats minutes and hours', () => {
    expect(clock(0)).toBe('0:00')
    expect(clock(65)).toBe('1:05')
    expect(clock(3723)).toBe('1:02:03')
    expect(clock(-4)).toBe('0:00')
  })
})

describe('playerUrl', () => {
  const embed = 'https://www.youtube-nocookie.com/embed/abcdefghijk?rel=0'
  it('keeps the privacy host and starts playing at the chapter', () => {
    const url = new URL(playerUrl(embed, 725.9))
    expect(url.host).toBe('www.youtube-nocookie.com')
    expect(url.pathname).toBe('/embed/abcdefghijk')
    expect(url.searchParams.get('rel')).toBe('0')
    expect(url.searchParams.get('start')).toBe('725')
    expect(url.searchParams.get('autoplay')).toBe('1')
    expect(url.searchParams.get('playsinline')).toBe('1')
  })
  it('omits start at the beginning', () => {
    expect(new URL(playerUrl(embed)).searchParams.has('start')).toBe(false)
  })
})
