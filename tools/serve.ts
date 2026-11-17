// A plain static server for public/, with the content types browsers insist on for
// WebAssembly and module scripts.
//
//   npm run dev        then open http://localhost:5178
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const root = path.join(import.meta.dirname, '..', 'public')
const port = Number(process.env.PORT ?? 5178)
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
  '.csv': 'text/csv; charset=utf-8', '.onnx': 'application/octet-stream', '.bin': 'application/octet-stream', '.png': 'image/png', '.map': 'application/json',
}

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    // Local development only: hands the App Check debug token kept in an untracked file to the
    // page, so the token never has to be written into the source or a URL.
    if (url.pathname === '/__appcheck') {
      const file = path.join(root, '..', '.appcheck-debug-token')
      const token = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : ''
      return void res.writeHead(token ? 200 : 404, {'content-type': 'text/plain', 'cache-control': 'no-store'}).end(token)
    }
    let file = path.normalize(path.join(root, decodeURIComponent(url.pathname)))
    if (!file.startsWith(root)) return void res.writeHead(403).end()
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html')
    if (!fs.existsSync(file)) return void res.writeHead(404, {'content-type': 'text/plain'}).end('Not found')
    res.writeHead(200, {'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache'})
    fs.createReadStream(file).pipe(res)
  })
  .listen(port, () => console.log(`Clawback on http://localhost:${port}`))
