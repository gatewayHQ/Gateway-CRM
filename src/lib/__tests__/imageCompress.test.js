import { describe, it, expect } from 'vitest'
import { computeTargetDimensions, IMAGE_PRESETS, IMMUTABLE_CACHE } from '../imageCompress.js'

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

describe('presets + cache constant', () => {
  it('headshots cap tighter than landing/property images', () => {
    expect(IMAGE_PRESETS.headshot.maxDim).toBeLessThan(IMAGE_PRESETS.landing.maxDim)
  })
  it('immutable cache is one year in seconds', () => {
    expect(IMMUTABLE_CACHE).toBe('31536000')
  })
})
