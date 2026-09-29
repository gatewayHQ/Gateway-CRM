import { describe, it, expect } from 'vitest'
import { computeTargetDimensions, computeWidthCappedDimensions, IMAGE_PRESETS, IMMUTABLE_CACHE } from '../imageCompress.js'

describe('computeTargetDimensions', () => {
  it('never upscales an image already within the cap', () => {
    expect(computeTargetDimensions(800, 600, 1600)).toEqual({ width: 800, height: 600 })
  })
  it('scales the longest edge down to the cap, preserving aspect ratio', () => {
    expect(computeTargetDimensions(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200 })
    expect(computeTargetDimensions(3000, 4000, 1600)).toEqual({ width: 1200, height: 1600 })
  })
  it('handles square and landscape headshot caps', () => {
    expect(computeTargetDimensions(2000, 2000, 512)).toEqual({ width: 512, height: 512 })
  })
  it('degrades safely on missing dimensions', () => {
    expect(computeTargetDimensions(0, 0, 1600)).toEqual({ width: 0, height: 0 })
  })
})

describe('computeWidthCappedDimensions', () => {
  it('caps only the width, so a tall graphic keeps its full email width', () => {
    expect(computeWidthCappedDimensions(1080, 3000, 1200)).toEqual({ width: 1080, height: 3000 })
    expect(computeWidthCappedDimensions(2400, 6000, 1200)).toEqual({ width: 1200, height: 3000 })
  })
  it('handles missing dimensions', () => {
    expect(computeWidthCappedDimensions(0, 0, 1200)).toEqual({ width: 0, height: 0 })
  })
})

describe('presets + cache constant', () => {
  it('email images are JPEG, never WebP — classic Outlook cannot show WebP', () => {
    expect(IMAGE_PRESETS.email.type).toBe('image/jpeg')
    expect(IMAGE_PRESETS.email.maxWidth).toBeGreaterThanOrEqual(600)
  })
  it('headshots cap tighter than landing/property images', () => {
    expect(IMAGE_PRESETS.headshot.maxDim).toBeLessThan(IMAGE_PRESETS.landing.maxDim)
  })
  it('immutable cache is one year in seconds', () => {
    expect(IMMUTABLE_CACHE).toBe('31536000')
  })
})
