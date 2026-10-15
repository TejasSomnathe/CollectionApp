import { describe, expect, it } from 'vitest'
import {
  escapeCsvCell,
  formatINR,
  formatIndiaDate,
  indiaTimestamp,
  parseRupeesToPaise,
} from './finance'

describe('rupee and paise handling', () => {
  it.each([
    ['1', 100n],
    ['0.5', 50n],
    ['12.3', 1230n],
    ['1.09', 109n],
    ['90000000000000', 9000000000000000n],
  ])('parses %s as integer paise', (input, expected) => {
    expect(parseRupeesToPaise(input)).toBe(expected)
  })

  it.each(['', '0', '-1', '1.001', '1,000', '1e3', '.50', '90000000000001'])(
    'rejects invalid amount %s',
    (input) => {
      expect(parseRupeesToPaise(input)).toBeNull()
    },
  )

  it('formats without floating-point paise arithmetic', () => {
    expect(formatINR(123456789n)).toBe('₹12,34,567.89')
  })

  it('preserves large aggregate totals beyond JavaScript safe integers', () => {
    expect(formatINR(123456789012345678n)).toBe('₹1,23,45,67,89,01,23,456.78')
  })
})

describe('India business time and report exports', () => {
  it('converts an IST wall-clock value into the correct UTC instant', () => {
    expect(indiaTimestamp('2026-10-15T12:30')).toBe('2026-10-15T07:00:00.000Z')
  })

  it('renders timestamps using Asia/Kolkata', () => {
    expect(formatIndiaDate('2026-10-15T07:00:00.000Z')).toContain('15 Oct 2026')
  })

  it.each([
    ['=HYPERLINK("https://bad.example")', "'=HYPERLINK("],
    ['+SUM(A1:A2)', "'+SUM"],
    ['-12', "'-12"],
    ['@cmd', "'@cmd"],
  ])('neutralizes spreadsheet formulas beginning with %s', (input, expectedPrefix) => {
    expect(escapeCsvCell(input)).toContain(expectedPrefix)
  })

  it('quotes CSV commas and embedded quotes', () => {
    expect(escapeCsvCell('A "quoted", name')).toBe('"A ""quoted"", name"')
  })
})
