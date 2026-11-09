// Minimal PNG codec (8-bit greyscale / grey+alpha / RGB / RGBA / palette, non-interlaced)
// on node:zlib, so the hi-res pipeline needs nothing beyond bun.
// Images are float RGBA in 0..1 (Float32Array, 4 per pixel, row-major, row 0 = top).

import { deflateSync, inflateSync } from 'node:zlib'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type Img = { w: number; h: number; d: Float32Array }

export const img = (w: number, h: number): Img => ({ w, h, d: new Float32Array(w * h * 4) })

const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(b: Uint8Array) {
  let c = 0xffffffff
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export function decodePng(buf: Uint8Array): Img {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let p = 8
  let w = 0, h = 0, depth = 0, ctype = 0, interlace = 0
  const idat: Uint8Array[] = []
  let plte: Uint8Array | null = null
  let trns: Uint8Array | null = null
  while (p < buf.length) {
    const len = dv.getUint32(p)
    const type = String.fromCharCode(...buf.subarray(p + 4, p + 8))
    const data = buf.subarray(p + 8, p + 8 + len)
    if (type === 'IHDR') {
      w = dv.getUint32(p + 8)
      h = dv.getUint32(p + 12)
      depth = buf[p + 16]
      ctype = buf[p + 17]
      interlace = buf[p + 20]
    } else if (type === 'PLTE') plte = data
    else if (type === 'tRNS') trns = data
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    p += 12 + len
  }
  if (depth !== 8 || interlace) throw new Error(`png: unsupported depth ${depth} / interlace ${interlace}`)
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype as 0 | 2 | 3 | 4 | 6]
  if (!ch) throw new Error('png: colour type ' + ctype)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = w * ch
  const out = new Uint8Array(w * h * ch)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const o = y * stride
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? out[o + x - ch] : 0
      const b = y ? out[o - stride + x] : 0
      const c = x >= ch && y ? out[o - stride + x - ch] : 0
      let v = src[x]
      if (f === 1) v += a
      else if (f === 2) v += b
      else if (f === 3) v += (a + b) >> 1
      else if (f === 4) {
        const pp = a + b - c
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      out[o + x] = v & 0xff
    }
  }
  const im = img(w, h)
  for (let i = 0; i < w * h; i++) {
    let r: number, g: number, b: number, a = 255
    if (ctype === 0) r = g = b = out[i]
    else if (ctype === 4) (r = g = b = out[i * 2]), (a = out[i * 2 + 1])
    else if (ctype === 2) (r = out[i * 3]), (g = out[i * 3 + 1]), (b = out[i * 3 + 2])
    else if (ctype === 6) (r = out[i * 4]), (g = out[i * 4 + 1]), (b = out[i * 4 + 2]), (a = out[i * 4 + 3])
    else {
      const k = out[i]
      r = plte![k * 3]
      g = plte![k * 3 + 1]
      b = plte![k * 3 + 2]
      a = trns && k < trns.length ? trns[k] : 255
    }
    im.d[i * 4] = r / 255
    im.d[i * 4 + 1] = g / 255
    im.d[i * 4 + 2] = b / 255
    im.d[i * 4 + 3] = a / 255
  }
  return im
}

function chunk(type: string, data: Uint8Array) {
  const b = new Uint8Array(12 + data.length)
  const dv = new DataView(b.buffer)
  dv.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i)
  b.set(data, 8)
  dv.setUint32(8 + data.length, crc32(b.subarray(4, 8 + data.length)))
  return b
}

/** RGBA8 PNG (RGB when every pixel is opaque) */
export function encodePng(im: Img): Uint8Array {
  const { w, h, d } = im
  let opaque = true
  for (let i = 3; i < d.length; i += 4) if (d[i] < 0.998) { opaque = false; break }
  const ch = opaque ? 3 : 4
  const stride = w * ch
  const raw = new Uint8Array(h * (stride + 1))
  const q = (v: number) => (v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255))
  for (let y = 0; y < h; y++) {
    const o = y * (stride + 1)
    raw[o] = 1 // sub filter
    let pr = 0, pg = 0, pb = 0, pa = 0
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const r = q(d[i]), g = q(d[i + 1]), b = q(d[i + 2]), a = q(d[i + 3])
      const k = o + 1 + x * ch
      raw[k] = (r - pr) & 0xff
      raw[k + 1] = (g - pg) & 0xff
      raw[k + 2] = (b - pb) & 0xff
      if (ch === 4) raw[k + 3] = (a - pa) & 0xff
      pr = r, pg = g, pb = b, pa = a
    }
  }
  const hdr = new Uint8Array(13)
  const dv = new DataView(hdr.buffer)
  dv.setUint32(0, w)
  dv.setUint32(4, h)
  hdr[8] = 8
  hdr[9] = ch === 4 ? 6 : 2
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  return Buffer.concat([sig, chunk('IHDR', hdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', new Uint8Array(0))])
}

export const readPng = (path: string) => decodePng(readFileSync(path))
export function writePng(path: string, im: Img) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, encodePng(im))
}
