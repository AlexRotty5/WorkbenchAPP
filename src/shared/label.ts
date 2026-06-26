const FILLER_WORDS = new Set(['in', 'with', 'on', 'inside', 'a', 'an', 'the', 'of', 'and', 'being', 'held'])
const LEADING_ADJECTIVES = new Set([
  'clear',
  'plastic',
  'transparent',
  'small',
  'large',
  'white',
  'black',
  'wooden',
  'metal',
  'red',
  'blue',
  'green',
  'yellow',
  'gray',
  'grey',
  'silver',
  'golden',
  'glass'
])

/**
 * Derive a short, clean label for auto-insert into text fields.
 * The scanned object card may keep the richer `fullLabel`.
 */
export function shortInsertLabel(fullLabel: string, aiInsertLabel?: string): string {
  const fromAi = aiInsertLabel?.trim()
  if (fromAi && fromAi.length > 0) {
    return fromAi.replace(/\s+/g, ' ').toLowerCase()
  }

  const words = fullLabel
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .filter((w) => !FILLER_WORDS.has(w.toLowerCase()))

  if (words.length === 0) return fullLabel.trim().toLowerCase()
  if (words.length <= 3) return words.join(' ').toLowerCase()

  const trimmed = [...words]
  while (trimmed.length > 2 && LEADING_ADJECTIVES.has(trimmed[0].toLowerCase())) {
    trimmed.shift()
  }

  if (trimmed.length > 4) {
    return trimmed.slice(-3).join(' ').toLowerCase()
  }

  return trimmed.slice(0, 4).join(' ').toLowerCase()
}
