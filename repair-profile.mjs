#!/usr/bin/env node
/**
 * Reset the profile patch that `dsh-subagent-mcp` launches.
 *
 * dsh composes a profile from bundle layers, then the profile's own
 * `cordis.patch.yml`, then any `--patch` overlays. That profile file starts
 * with a `[]` placeholder, so appending a block after it makes the whole file
 * invalid YAML and every run dies with:
 *
 *   failed to parse overlay …: end of the stream or a document separator is expected
 *
 * This script backs the file up and writes the pristine template back.
 *
 * Usage:
 *   node repair-profile.mjs                # default profile: dsh-subagent
 *   node repair-profile.mjs my-profile     # or DSH_SUBAGENT_PROFILE
 */
import { existsSync, copyFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PROFILE = process.argv[2] || process.env.DSH_SUBAGENT_PROFILE || 'dsh-subagent'
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const dir = join(DSH_HOME, 'profiles', PROFILE)
const file = join(dir, 'cordis.patch.yml')

const TEMPLATE = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# a top-level YAML array of loader patch entries (id-targeted config',
  '# overrides, disables, and insert lists; `!!js` expressions allowed).',
  '[]',
  '',
].join('\n')

if (!existsSync(dir)) {
  console.error(`profile not found: ${dir}`)
  console.error('Nothing to repair — the server creates this profile on first use.')
  process.exit(1)
}

if (existsSync(file)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${file}.bak-${stamp}`
  copyFileSync(file, backup)
  console.log(`backup: ${backup}`)
}

writeFileSync(file, TEMPLATE, 'utf8')
console.log(`reset:  ${file}`)
console.log('next:   restart the MCP host so the server spawns a clean profile')
