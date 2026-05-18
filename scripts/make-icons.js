/* eslint-disable no-console */
// Generate placeholder app icons (icon.ico for Windows + icon.png for fallback).
// We don't ship dedicated brand assets — this builds a 256×256 gradient square
// programmatically so electron-builder has something to embed in the installer
// and the .exe header. Re-run after editing if you want to refresh.

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

function buildPng(size) {
  const W = size, H = size
  const raw = Buffer.alloc(H * (1 + W * 4))
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 4)] = 0 // PNG filter byte (None)
    for (let x = 0; x < W; x++) {
      const i = y * (1 + W * 4) + 1 + x * 4
      // Brand-ish purple→indigo gradient with a slight rounded-corner mask
      const cornerR = Math.floor(W * 0.18)
      const dx = x < cornerR ? cornerR - x : (x >= W - cornerR ? x - (W - cornerR - 1) : 0)
      const dy = y < cornerR ? cornerR - y : (y >= H - cornerR ? y - (H - cornerR - 1) : 0)
      const corner = dx > 0 && dy > 0 && (dx * dx + dy * dy > cornerR * cornerR)
      if (corner) {
        raw[i] = 0; raw[i + 1] = 0; raw[i + 2] = 0; raw[i + 3] = 0
      } else {
        const t = y / (H - 1)
        raw[i + 0] = Math.round(99 + (139 - 99) * t)
        raw[i + 1] = Math.round(102 + (92 - 102) * t)
        raw[i + 2] = Math.round(241 + (246 - 241) * t)
        raw[i + 3] = 255
      }
    }
  }
  const idat = zlib.deflateSync(raw)

  const crcTable = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  const crc32 = (buf) => {
    let c = 0xffffffff
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
    const t = Buffer.from(type, 'ascii')
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
    return Buffer.concat([len, t, data, crc])
  }
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

/**
 * Build a Windows .ico containing one or more PNG images. ICO format (modern):
 *   ICONDIR (6 bytes) + ICONDIRENTRY × N (16 bytes each) + image payloads.
 * Embedded PNG is supported when bit depth & dimensions are encoded as zero
 * for 256-px entries (the spec stores 0 to mean 256).
 */
function buildIco(pngs) {
  const N = pngs.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)    // reserved
  header.writeUInt16LE(1, 2)    // type: 1 = icon
  header.writeUInt16LE(N, 4)    // count

  const entries = []
  let offset = 6 + 16 * N
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16)
    e[0] = size === 256 ? 0 : size              // width
    e[1] = size === 256 ? 0 : size              // height
    e[2] = 0                                     // color count
    e[3] = 0                                     // reserved
    e.writeUInt16LE(1, 4)                        // planes
    e.writeUInt16LE(32, 6)                       // bit count
    e.writeUInt32LE(data.length, 8)              // image size
    e.writeUInt32LE(offset, 12)                  // offset
    entries.push(e)
    offset += data.length
  }
  return Buffer.concat([header, ...entries, ...pngs.map(p => p.data)])
}

const buildDir = path.resolve(__dirname, '..', 'build')
fs.mkdirSync(buildDir, { recursive: true })

const sizes = [16, 32, 48, 64, 128, 256]
const pngs = sizes.map(size => ({ size, data: buildPng(size) }))
fs.writeFileSync(path.join(buildDir, 'icon.png'), buildPng(512))
fs.writeFileSync(path.join(buildDir, 'icon.ico'), buildIco(pngs))
console.log('Wrote build/icon.png (512x512) and build/icon.ico (', sizes.join(', '), ')')
