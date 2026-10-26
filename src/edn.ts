// A small EDN reader: enough for the snapshots crapper, dryer and mutator write (.metrics/*.edn).
// Maps become plain objects (keyword keys lose their colon), vectors, lists and sets become arrays,
// keywords and symbols become strings, nil becomes null. Tagged literals (#inst "…") keep their value.

export type Edn = null | boolean | number | string | Edn[] | { [k: string]: Edn }

const WS = /[\s,]/
const DELIM = /[\s,()[\]{}"';]/

export function parseEdn(text: string): Edn {
  let i = 0
  const err = (msg: string): never => { throw new Error(`edn: ${msg} at offset ${i}`) }

  const skip = (): void => {
    while (i < text.length) {
      const c = text[i]!
      if (WS.test(c)) i++
      else if (c === ';') { while (i < text.length && text[i] !== '\n') i++ }
      else if (c === '#' && text[i + 1] === '_') { i += 2; value() }
      else break
    }
  }

  const seq = (close: string): Edn[] => {
    const out: Edn[] = []
    for (;;) {
      skip()
      if (i >= text.length) err(`missing ${close}`)
      if (text[i] === close) { i++; return out }
      out.push(value())
    }
  }

  const str = (): string => {
    i++ // opening quote
    let s = ''
    while (i < text.length && text[i] !== '"') {
      const c = text[i++]!
      if (c !== '\\') { s += c; continue }
      const e = text[i++]
      if (e === 'n') s += '\n'
      else if (e === 't') s += '\t'
      else if (e === 'r') s += '\r'
      else if (e === 'u') { s += String.fromCharCode(parseInt(text.slice(i, i + 4), 16)); i += 4 }
      else s += e ?? ''
    }
    if (text[i] !== '"') err('unterminated string')
    i++
    return s
  }

  const atom = (): Edn => {
    const start = i
    while (i < text.length && !DELIM.test(text[i]!)) i++
    const tok = text.slice(start, i)
    if (!tok) err(`unexpected ${JSON.stringify(text[i])}`)
    if (tok === 'nil') return null
    if (tok === 'true') return true
    if (tok === 'false') return false
    if (/^[+-]?(\d+\.?\d*([eE][+-]?\d+)?|\.\d+)[MN]?$/.test(tok)) return Number(tok.replace(/[MN]$/, ''))
    if (tok === '##NaN') return NaN
    if (tok.startsWith(':')) return tok.slice(1)
    return tok
  }

  function value(): Edn {
    skip()
    if (i >= text.length) err('unexpected end')
    const c = text[i]!
    if (c === '{') {
      i++
      const items = seq('}')
      if (items.length % 2) err('map with an odd number of forms')
      const obj: { [k: string]: Edn } = {}
      for (let k = 0; k < items.length; k += 2) obj[typeof items[k] === 'string' ? (items[k] as string) : JSON.stringify(items[k])] = items[k + 1]!
      return obj
    }
    if (c === '[') { i++; return seq(']') }
    if (c === '(') { i++; return seq(')') }
    if (c === '#' && text[i + 1] === '{') { i += 2; return seq('}') }
    if (c === '#' && /[a-zA-Z]/.test(text[i + 1] ?? '')) { atom(); return value() } // tagged literal: drop the tag
    if (c === '"') return str()
    if (c === '\\') { i++; const s = text[i] ?? ''; i++; return s } // character literal
    return atom()
  }

  const v = value()
  skip()
  if (i < text.length) err('trailing content')
  return v
}
