// Смоук против живого сервера: SEKUNDANT_URL=http://localhost:8099 node --test
// Поднимает сервер сам, если переменная не задана и мы в корне репо.
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"

const PORT = 8123
let child = null
let baseUrl = process.env.SEKUNDANT_URL

before(async () => {
  if (baseUrl) return
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
  child = spawn("node", [path.join(root, "server.js")], { env: { ...process.env, PORT: String(PORT) } })
  baseUrl = `http://localhost:${PORT}`
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(`${baseUrl}/admin/metrics`)
      return
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  throw new Error("server did not start")
})

after(() => child?.kill())

const { Sekundant, QuotaExceededError } = await import("../dist/index.js")

test("send + uploadImage + quota + 429", async () => {
  const issued = await fetch(`${baseUrl}/admin/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "sdk-smoke", limit: 2 }),
  }).then((r) => r.json())

  const sk = new Sekundant({ baseUrl, token: issued.secret })

  // валидная однопиксельная PNG
  const png = Uint8Array.from(atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  ), (c) => c.charCodeAt(0))
  const up = await sk.uploadImage("sdk-e2e", png, "image/png")
  assert.match(up.media_id, /^[0-9a-f]{24}\.png$/)

  const r1 = await sk.send("sdk-e2e", { title: "Смоук", message: "раз", image: up.media_id })
  assert.equal(r1.ok, true)
  assert.equal(r1.quota.remaining, 1)

  const q = await sk.quota()
  assert.equal(q.limit, 2)
  assert.equal(q.remaining, 1)

  await sk.send("sdk-e2e", { title: "Смоук", message: "два" })
  await assert.rejects(sk.send("sdk-e2e", { title: "Смоук", message: "три" }), QuotaExceededError)
})

test("Ed25519-подпись тенанта (X-Signature)", async () => {
  // отдельный сервер с включённой проверкой подписи
  const { generateKeyPairSync } = await import("node:crypto")
  const kp = generateKeyPairSync("ed25519")
  const pubRaw = Buffer.from(kp.publicKey.export({ format: "jwk" }).x, "base64url")
  const pkcs8b64 = kp.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64")

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
  const port = 8124
  const srv = spawn("node", [path.join(root, "server.js")], {
    env: { ...process.env, PORT: String(port), TENANT_PUBKEY: pubRaw.toString("base64") },
  })
  try {
    const base = `http://localhost:${port}`
    for (let i = 0; i < 40; i++) {
      try { await fetch(`${base}/admin/metrics`); break } catch { await new Promise((r) => setTimeout(r, 100)) }
    }
    // без подписи сервер отклоняет
    const bare = new Sekundant({ baseUrl: base })
    await assert.rejects(bare.send("sig", { title: "без подписи" }), (err) => err.status === 401)
    // с подписью проходит
    const signed = new Sekundant({ baseUrl: base, signingKey: pkcs8b64 })
    const r = await signed.send("sig", { title: "подписано" })
    assert.equal(r.ok, true)
  } finally {
    srv.kill()
  }
})
