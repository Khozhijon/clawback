// Reads a Firebase web config snippet (as copied from the console) on stdin and writes its
// values into src/ai/config.ts.   pbpaste | node tools/set-config.cjs
const fs = require('node:fs')
const path = require('node:path')
let input = ''
process.stdin.on('data', d => (input += d))
process.stdin.on('end', () => {
  const file = path.join(__dirname, '..', 'src', 'ai', 'config.ts')
  let src = fs.readFileSync(file, 'utf8')
  const found = []
  for (const key of ['apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId']) {
    const m = new RegExp(`${key}:\\s*"([^"]+)"`).exec(input)
    if (!m) continue
    src = src.replace(new RegExp(`(  ${key}: )'[^']*'`), `$1'${m[1]}'`)
    found.push(key)
  }
  fs.writeFileSync(file, src)
  console.log(`set ${found.length} of 6 values: ${found.join(', ')}`)
})
