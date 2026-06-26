import OpenAI from 'openai'
import type { DetectResult } from '../shared/types'

const MODEL = 'gpt-4o'

const MISSING_KEY_MESSAGE =
  'No OpenAI API key found. Create a .env file in the project root with ' +
  'OPENAI_API_KEY=sk-... (you can copy .env.example), then restart the app.'

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
  'device, or part being presented, and produce an extremely short verification ' +
  'label. ' +
  'RULES: ' +
  '1) Completely ignore any people, faces, hands, bodies, clothing, and background. ' +
  'A person is NEVER the object — if a person is holding something, label only the ' +
  'thing they are holding. ' +
  '2) If there is no clear object being presented (only a person, an empty scene, a ' +
  'wall, or the image is too blurry/dark to tell), set found=false. ' +
  '3) If the object is a recognizable everyday item, output ONLY its common name in ' +
  'natural casing, 1-4 words: e.g. "TV remote", "water bottle", "keyboard", ' +
  '"black LG remote". Use lowercase except for proper brand names or acronyms. ' +
  '4) If the object is NOT a standard recognizable item (a prototype, custom part, ' +
  'handmade mechanism, fixture, or unusual object), output a short visual ' +
  'description of up to ~8 words: e.g. "wooden prototype with wires", ' +
  '"small metal hinge assembly", "black plastic device with buttons and a screen". ' +
  '5) NEVER use prefixes or sentences. Do NOT write "object detected", "this is", ' +
  '"I see", "a", or trailing punctuation. Output only the label/description itself. ' +
  'Respond ONLY with a JSON object of the form {"found": boolean, "label": string}.'

interface RawDetect {
  found?: unknown
  label?: unknown
}

/**
 * Send a single captured frame to GPT-4o and ask it to identify the primary
 * object (ignoring people). Returns a short verification label or found=false.
 */
export async function detectObject(dataUrl: string): Promise<DetectResult> {
  const openai = getClient()
  if (!openai) {
    return { found: false, label: '', error: MISSING_KEY_MESSAGE }
  }

  if (!dataUrl || !dataUrl.startsWith('data:image/')) {
    return { found: false, label: '', error: 'No valid image was captured.' }
  }

  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      max_tokens: 60,
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
                'Return only JSON.'
            },
            { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } }
          ]
        }
      ]
    })

    const content = response.choices[0]?.message?.content?.trim()
    if (!content) {
      return { found: false, label: '', error: 'OpenAI returned an empty response.' }
    }

    let parsed: RawDetect
    try {
      parsed = JSON.parse(content) as RawDetect
    } catch {
      return { found: false, label: '' }
    }

    const found = parsed.found === true
    const label = typeof parsed.label === 'string' ? parsed.label.trim() : ''
    if (!found || label.length === 0) {
      return { found: false, label: '' }
    }
    return { found: true, label }
  } catch (err) {
    return { found: false, label: '', error: toFriendlyError(err) }
  }
}
