import { describe, expect, it } from 'vitest'
import {
  availableTabItems,
  moveTabInfoItem,
  sanitizeTabItems
} from './tab-info'

describe('sanitizeTabItems', () => {
  it('drops unknown and duplicate ids while preserving order', () => {
    expect(
      sanitizeTabItems(['project', 'wat', 'branch', 'project', 'shortId'])
    ).toEqual(['project', 'branch', 'shortId'])
    expect(sanitizeTabItems('project')).toEqual([])
    expect(sanitizeTabItems(null)).toEqual([])
  })
})

describe('moveTabInfoItem', () => {
  it('moves a capsule from the pool into a zone', () => {
    expect(moveTabInfoItem(['project'], [], 'branch', 'prefix')).toEqual({
      prefix: ['project', 'branch'],
      suffix: []
    })
    expect(moveTabInfoItem([], [], 'shortId', 'suffix')).toEqual({
      prefix: [],
      suffix: ['shortId']
    })
  })

  it('reorders within the same zone', () => {
    expect(
      moveTabInfoItem(['project', 'branch', 'shortId'], [], 'shortId', 'prefix', 0)
    ).toEqual({ prefix: ['shortId', 'project', 'branch'], suffix: [] })

    expect(
      moveTabInfoItem(['project', 'branch', 'shortId'], [], 'project', 'prefix', 2)
    ).toEqual({ prefix: ['branch', 'project', 'shortId'], suffix: [] })
  })

  it('moves between prefix and suffix at the requested index', () => {
    expect(
      moveTabInfoItem(['project', 'branch'], ['shortId'], 'project', 'suffix', 0)
    ).toEqual({ prefix: ['branch'], suffix: ['project', 'shortId'] })
  })

  it('moves back to the pool', () => {
    expect(
      moveTabInfoItem(['project'], ['shortId'], 'project', 'pool')
    ).toEqual({ prefix: [], suffix: ['shortId'] })
  })

  it('clamps out-of-range insertion indexes', () => {
    expect(
      moveTabInfoItem(['project'], [], 'branch', 'prefix', 999)
    ).toEqual({ prefix: ['project', 'branch'], suffix: [] })
    expect(
      moveTabInfoItem(['project'], [], 'branch', 'prefix', -4)
    ).toEqual({ prefix: ['branch', 'project'], suffix: [] })
  })
})

describe('availableTabItems', () => {
  it('returns capsules not placed in either zone', () => {
    expect(availableTabItems(['project'], ['shortId'])).not.toContain('project')
    expect(availableTabItems(['project'], ['shortId'])).not.toContain('shortId')
    expect(availableTabItems(['project'], ['shortId'])).toContain('branch')
  })
})
