#!/usr/bin/env node
/**
 * asar-scan — read the packaged DSH runtime without unpacking it.
 *
 * Why this exists: the authoritative answers to "what services does this host
 * publish", "what is the desktop shell's window policy" and "what shape does this
 * extension point have" live inside `resources/app.asar`, which Node cannot treat
 * as a directory. The Host Service / Event / Slot Inspect providers answer most of
 * it live; this tool covers the rest — the Electron main process, the cordis
 * internals, and any package whose shipped `.d.ts` is the contract.
 *
 * Zero dependencies, read-only, and it never writes. Not shipped:
 * `package.json#files` lists only `tools/viz-watch.mjs`, so this stays a dev tool.
 *
 *   node tools/asar-scan.mjs <asar> <name-regex> [limit]        list matching entries
 *   node tools/asar-scan.mjs <asar> --cat <exact-entry-path>    dump one entry
 *   node tools/asar-scan.mjs <asar> --grep <name-regex> <text-regex> [limit]
 *
 * Default archive: the installed DeepSeek Harness Desktop runtime.
 * @module dsh-anagenesis/tools/asar-scan
 */

import { open } from 'node:fs/promises'

const asar = process.argv[2]
const mode = process.argv[3]
const fh = await open(asar, 'r')
const head = Buffer.alloc(16)
await fh.read(head, 0, 16, 0)
const headerSize = head.readUInt32LE(12)
const jsonBuf = Buffer.alloc(headerSize)
await fh.read(jsonBuf, 0, headerSize, 16)
const header = JSON.parse(jsonBuf.toString('utf8'))
const baseOffset = 16 + headerSize

const collect = (node, path, out) => {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const p = path ? `${path}/${name}` : name
    if (child.files) collect(child, p, out)
    else out.push({ path: p, offset: Number(child.offset), size: child.size })
  }
}
const all = []
collect(header, '', all)

const readEntry = async (entry) => {
  const buf = Buffer.alloc(entry.size)
  await fh.read(buf, 0, entry.size, baseOffset + entry.offset)
  return buf
}

if (mode === '--cat') {
  const target = process.argv[4]
  const entry = all.find((e) => e.path === target)
  if (!entry) {
    console.log(`not found: ${target}`)
  } else {
    process.stdout.write((await readEntry(entry)).toString('utf8'))
  }
} else if (mode === '--grep') {
  const nameRe = new RegExp(process.argv[4], 'i')
  const textRe = new RegExp(process.argv[5], 'i')
  const limit = Number(process.argv[6] ?? 40)
  let hits = 0
  for (const entry of all) {
    if (!nameRe.test(entry.path)) continue
    if (!/\.(js|cjs|mjs|json|ts|md)$/.test(entry.path)) continue
    if (entry.size > 4_000_000) continue
    const text = (await readEntry(entry)).toString('utf8')
    if (!textRe.test(text)) continue
    for (const line of text.split('\n')) {
      if (textRe.test(line)) {
        console.log(`${entry.path}: ${line.trim().slice(0, 300)}`)
        if (++hits >= limit) break
      }
    }
    if (hits >= limit) break
  }
  console.log(`hits=${hits}`)
} else {
  const re = new RegExp(mode, 'i')
  const limit = Number(process.argv[4] ?? 200)
  const out = all.filter((e) => re.test(e.path))
  console.log(`files=${all.length} matched=${out.length}`)
  for (const e of out.slice(0, limit)) console.log(`${e.path}  (${e.size}B)`)
}
await fh.close()