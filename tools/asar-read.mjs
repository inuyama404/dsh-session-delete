// Read files out of an Electron asar archive without external deps.
// Header layout: [u32 pickleSize=4][u32 headerSize][u32 jsonLen][json...]
// JSON therefore starts at 16; per-file `offset` values are relative to 8 + headerSize.
// Usage: node asar-read.mjs <archive.asar> find <regex> | cat <exact path>
import { readFileSync } from 'node:fs'

const [, , archive, mode, arg] = process.argv
const buf = readFileSync(archive)

const headerSize = buf.readUInt32LE(4)
const jsonLen = buf.readUInt32LE(12)
const json = JSON.parse(buf.toString('utf8', 16, 16 + jsonLen))
const dataStart = 8 + headerSize

function walk(node, prefix, out) {
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const p = prefix === '' ? name : `${prefix}/${name}`
    if (value.files) walk(value, p, out)
    else out.push({ path: p, offset: Number(value.offset ?? 0), size: value.size, unpacked: value.unpacked })
  }
  return out
}

const files = walk(json, '', [])

if (mode === 'find') {
  const re = new RegExp(arg, 'i')
  const hits = files.filter((f) => re.test(f.path))
  for (const h of hits) console.log(`${String(h.size).padStart(9)}  ${h.path}`)
  console.log(`-- ${hits.length} match(es) of ${files.length} files  (dataStart=${dataStart})`)
} else if (mode === 'cat') {
  const f = files.find((x) => x.path === arg)
  if (!f) { console.error(`not found: ${arg}`); process.exit(1) }
  if (f.unpacked) console.error('[note] entry is marked unpacked; reading from archive anyway')
  console.log(buf.toString('utf8', dataStart + f.offset, dataStart + f.offset + f.size))
}
