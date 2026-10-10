// Assemble the dsh-session-delete 0.1.2 package tree from the verified 0.1.1
// tarball plus the upstream-committed fix, then pnpm-pack it.
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'

const [, , srcPkg, fixedClient, outPkg] = process.argv

// package.json: bump only the version field, leaving formatting byte-stable.
const pkgPath = `${srcPkg}/package.json`
const original = readFileSync(pkgPath, 'utf8')
const before = JSON.parse(original)
const ANCHOR = `"version": "${before.version}",`
const n = original.split(ANCHOR).length - 1
if (n !== 1) { console.error(`FAIL: expected exactly 1 version anchor, found ${n}`); process.exit(1) }
const bumped = original.replace(ANCHOR, `"version": "0.1.2",`)
writeFileSync(pkgPath, bumped, 'utf8')

const after = JSON.parse(bumped)
console.log(`name        : ${after.name}  (unchanged: ${after.name === before.name})`)
console.log(`version     : ${before.version} -> ${after.version}`)
console.log(`deps/peer   : unchanged: ${JSON.stringify(after.peerDependencies) === JSON.stringify(before.peerDependencies)}`)
console.log(`files[]     : ${JSON.stringify(after.files)}`)

// The fixed client half replaces the published one.
copyFileSync(fixedClient, pkgPath.replace('package.json', 'client.js'))
const fixed = readFileSync(`${srcPkg}/client.js`)
console.log(`client.js   : ${fixed.length} bytes (fixed build)`)
