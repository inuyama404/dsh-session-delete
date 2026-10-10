// Extract chosen asar entries to real files so they can be read normally.
// Usage: node asar-extract.mjs <archive.asar> <outDir> <path> [path...]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'

const [, , archive, outDir, ...wanted] = process.argv
const buf = readFileSync(archive)

// This Electron's asar header: [u32 pickleSize=4][u32 headerSize][u32 jsonLen][json...]
// JSON therefore starts at 16; per-file offsets are relative to the end of the header block.
const headerSize = buf.readUInt32LE(4)
const jsonLen = buf.readUInt32LE(12)
const json = JSON.parse(buf.toString('utf8', 16, 16 + jsonLen))
const dataStart = 8 + headerSize

function walk(node, prefix, out) {
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const p = prefix === '' ? name : `${prefix}/${name}`
    if (value.files) walk(value, p, out)
    else out.push({ path: p, offset: Number(value.offset ?? 0), size: value.size })
  }
  return out
}
const files = walk(json, '', [])

mkdirSync(outDir, { recursive: true })

// list <regex> <outFile>  — write matching paths+sizes to a file (avoids huge stdout pipes)
if (wanted[0] === 'list') {
  const re = new RegExp(wanted[1], 'i')
  const lines = files.filter((f) => re.test(f.path)).map((f) => `${String(f.size).padStart(9)}  ${f.path}`)
  writeFileSync(join(outDir, wanted[2]), lines.join('\n') + `\n-- ${lines.length} of ${files.length}\n`, 'utf8')
  console.log(`LIST ${lines.length} match(es) -> ${wanted[2]}`)
  process.exit(0)
}

for (const want of wanted) {
  const f = files.find((x) => x.path === want)
  if (!f) { console.log(`MISS  ${want}`); continue }
  const dest = join(outDir, basename(want))
  writeFileSync(dest, buf.subarray(dataStart + f.offset, dataStart + f.offset + f.size))
  console.log(`OK    ${f.size} bytes -> ${basename(want)}`)
}
