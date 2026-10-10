// Line-level diff (LCS) between two text files, for reviewing an edit before pushing.
import { readFileSync } from 'node:fs'

const [, , aPath, bPath] = process.argv
const A = readFileSync(aPath, 'utf8').split('\n')
const B = readFileSync(bPath, 'utf8').split('\n')

const n = A.length, m = B.length
const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
for (let i = n - 1; i >= 0; i--) {
  for (let j = m - 1; j >= 0; j--) {
    dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  }
}
const ops = []
let i = 0, j = 0
while (i < n && j < m) {
  if (A[i] === B[j]) { ops.push([' ', A[i]]); i++; j++ }
  else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(['-', A[i]]); i++ }
  else { ops.push(['+', B[j]]); j++ }
}
while (i < n) ops.push(['-', A[i++]])
while (j < m) ops.push(['+', B[j++]])

const changed = ops.filter(([o]) => o !== ' ').length
console.log(`lines: ${n} -> ${m}; changed lines: ${changed}`)
console.log(`hunks (contiguous change blocks):`)
let blocks = 0, inBlock = false
for (const [op] of ops) {
  if (op !== ' ') { if (!inBlock) { blocks++; inBlock = true } }
  else inBlock = false
}
console.log(`  ${blocks}\n`)
console.log('--- a/README.md')
console.log('+++ b/README.md')
for (const [op, line] of ops) {
  if (op === ' ') continue
  console.log(op + line)
}
