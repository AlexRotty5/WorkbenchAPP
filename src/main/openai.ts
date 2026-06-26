import OpenAI from 'openai'
import type { DetectResult } from '../shared/types'
import { shortInsertLabel } from '../shared/label'

const MODEL = 'gpt-4o'

const MISSING_KEY_MESSAGE =
  'No OpenAI API key found. Add OPENAI_API_KEY=sk-... to a .env file ' +
  '(the project root in dev, or "~/Library/Application Support/Workbench Vision/.env" ' +
  'for the installed app), then restart Workbench Vision.'

let client: OpenAI | null = null

/**
 * Lazily create the OpenAI client. Returns null when the key is missing so the
 * caller can surface a friendly message instead of crashing.
 */
function getClient(): OpenAI | null {
  const key = process.env.OPENAI_API_KEY
  if (!key || key.trim().length === 0 || key === 'your_key_here') {
    return null
  }
  if (!client) {
    client = new OpenAI({ apiKey: key })
  }
  return client
}

function toFriendlyError(err: unknown): string {
  if (err instanceof OpenAI.APIError) {
    const status = err.status ? `(${err.status}) ` : ''
    return `OpenAI request failed ${status}${err.message}`.trim()
  }
  if (err instanceof Error) {
    return `Something went wrong talking to OpenAI: ${err.message}`
  }
  return 'An unknown error occurred while contacting OpenAI.'
}

const DETECT_SYSTEM_PROMPT =
  'You are an object scanner for a desktop tool. The user holds a single physical ' +
  'object up to a webcam. Identify the PRIMARY physical object, product, tool, ' +
  'device, or part being presented. ' +
  'RULES: ' +
  '1) Completely ignore any people, faces, hands, bodies, clothing, and background. ' +
  'A person is NEVER the object — if a person is holding something, label only the ' +
  'thing they are holding. ' +
  '2) If there is no clear object being presented (only a person, an empty scene, a ' +
  'wall, or the image is too blurry/dark to tell), set found=false. ' +
  '3) label: a slightly richer description for a UI card (up to ~8 words), e.g. ' +
  '"clear plastic photo frame", "black LG TV remote". ' +
  '4) insertLabel: the minimal everyday name for typing into a text field (1-3 words, ' +
  'lowercase), e.g. "photo frame", "tv remote", "water bottle". ' +
  '5) NEVER use prefixes or sentences. Do NOT write "object detected", "this is", ' +
  '"I see", or trailing punctuation. ' +
  'Respond ONLY with JSON: {"found": boolean, "label": string, "insertLabel": string}.'

interface RawDetect {
  found?: unknown
  label?: unknown
  insertLabel?: unknown
}

const EMPTY: DetectResult = { found: false, label: '', insertLabel: '' }

/**
 * Send a single captured frame to GPT-4o and ask it to identify the primary
 * object (ignoring people). Returns card label + short insert label or found=false.
 */
export async function detectObject(dataUrl: string): Promise<DetectResult> {
  const openai = getClient()
  if (!openai) {
    return { ...EMPTY, error: MISSING_KEY_MESSAGE }
  }

  if (!dataUrl || !dataUrl.startsWith('data:image/')) {
    return { ...EMPTY, error: 'No valid image was captured.' }
  }

  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      max_tokens: 80,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: DETECT_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                'Identify the primary object being held up. Ignore the person. ' +
                'Return only JSON with found, label, and insertLabel.'
            },
            { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } }
          ]
        }
      ]
    })

    const content = response.choices[0]?.message?.content?.trim()
    if (!content) {
      return { ...EMPTY, error: 'OpenAI returned an empty response.' }
    }

    let parsed: RawDetect
    try {
      parsed = JSON.parse(content) as RawDetect
    } catch {
      return EMPTY
    }

    const found = parsed.found === true
    const label = typeof parsed.label === 'string' ? parsed.label.trim() : ''
    const rawInsert = typeof parsed.insertLabel === 'string' ? parsed.insertLabel.trim() : ''
    if (!found || label.length === 0) {
      return EMPTY
    }

    const insertLabel = shortInsertLabel(label, rawInsert || undefined)
    return { found: true, label, insertLabel }
  } catch (err) {
    return { ...EMPTY, error: toFriendlyError(err) }
  }
}
