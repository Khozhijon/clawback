// Builds the static site into public/: bundles the app and writes the sample statement as a
// file people can download.
//
//   npm run build
import fs from 'node:fs'
import path from 'node:path'
import {build} from 'esbuild'
import {sampleStatement} from '../src/core/sample.ts'

const root = path.join(import.meta.dirname, '..')
const out = path.join(root, 'public')
const dev = process.argv.includes('--dev')

await build({
  entryPoints: {app: path.join(root, 'src/web/main.ts')},
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outdir: out,
  minify: !dev,
  sourcemap: dev ? 'linked' : false,
  logLevel: 'warning',
  legalComments: 'none',
})

fs.writeFileSync(path.join(out, 'sample-statement.csv'), sampleStatement())
const size = (f: string) => `${(fs.statSync(path.join(out, f)).size / 1024).toFixed(0)} KB`
console.log(`built: app.js ${size('app.js')}, sample-statement.csv ${size('sample-statement.csv')}`)
