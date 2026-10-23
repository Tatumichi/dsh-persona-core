// Wrap a model chunk stream so natural-language text blocks pass through ToneStream.
// Deltas and the authoritative `block-end` text are rewritten consistently, so the
// live view, the assembled message and the durable log all agree.

import { ToneStream } from './tone.js'

/**
 * @param source - AsyncIterable<StreamChunk>
 * @param rules - replacement rules; an empty list passes everything through untouched
 */
export async function* rewriteStream(source, rules) {
  if (!rules?.length) { yield* source; return }
  /** index -> { tone, emitted, isText } */
  const blocks = new Map()
  const textBlock = (index) => {
    let b = blocks.get(index)
    if (!b) { b = { tone: new ToneStream(rules), emitted: '', sawDelta: false, failed: false }; blocks.set(index, b) }
    return b
  }

  for await (const chunk of source) {
    if (chunk.type === 'block-start' && chunk.blockType === 'text') {
      textBlock(chunk.index)
      yield chunk
      continue
    }
    if (chunk.type === 'text-delta') {
      const b = textBlock(chunk.index)
      b.sawDelta = true
      let out
      if (b.failed) out = chunk.text
      else {
        try { out = b.tone.push(chunk.text) } catch { b.failed = true; out = b.tone.buf + chunk.text; b.tone.buf = '' }
      }
      if (out) { b.emitted += out; yield { ...chunk, text: out } }
      continue
    }
    if (chunk.type === 'block-end' && chunk.block?.type === 'text') {
      const b = textBlock(chunk.index)
      let finalText
      if (!b.sawDelta) {
        // Adapter sent the whole block at once: rewrite it in one go.
        const t = new ToneStream(rules)
        try { finalText = t.push(chunk.block.text ?? '') + t.end() } catch { finalText = chunk.block.text ?? '' }
      } else {
        let rest = ''
        if (b.failed) { rest = b.tone.buf; b.tone.buf = '' } else {
          try { rest = b.tone.end() } catch { rest = b.tone.buf; b.tone.buf = '' }
        }
        if (rest) { b.emitted += rest; yield { type: 'text-delta', index: chunk.index, text: rest } }
        finalText = b.emitted
      }
      blocks.delete(chunk.index)
      yield { ...chunk, block: { ...chunk.block, text: finalText } }
      continue
    }
    if (chunk.type === 'finish' || chunk.type === 'usage') {
      // Flush any text block that never received block-end (delta-only protocols).
      for (const [index, b] of blocks) {
        const rest = b.failed ? b.tone.buf : safeEnd(b.tone)
        b.tone.buf = ''
        if (rest) { b.emitted += rest; yield { type: 'text-delta', index, text: rest } }
      }
      if (chunk.type === 'finish') blocks.clear()
      yield chunk
      continue
    }
    yield chunk
  }
  // Stream ended without finish: release held text so nothing the model said is lost.
  for (const [index, b] of blocks) {
    const rest = b.failed ? b.tone.buf : safeEnd(b.tone)
    if (rest) yield { type: 'text-delta', index, text: rest }
  }
}

function safeEnd(tone) {
  try { return tone.end() } catch { const r = tone.buf; tone.buf = ''; return r }
}
