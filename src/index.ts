// SDK «Секунданта» для JS/TS: ноль рантайм-зависимостей (fetch + WebCrypto).
// Работает в Node 20+, Bun, Deno и браузере.
//
//   const sk = new Sekundant({ baseUrl: "https://alerts.example.ru", token: "sk_..." })
//   const { media_id } = await sk.uploadImage("warehouse", photoBlob)
//   await sk.send("warehouse", { title: "Фото с объекта", image: media_id })

/** Алерт — всё, что умеет показать APNs. Неизвестные поля сервер отбрасывает. */
export interface Alert {
  type?: string
  title?: string
  message?: string
  subtitle?: string
  /** media_id из uploadImage либо готовый https-URL */
  image?: string
  sound?: string
  category?: string
  thread?: string
  collapse_id?: string
  priority?: "high" | "normal"
  interruption?: "passive" | "active" | "time-sensitive"
  badge?: number
  expires_in?: number
  numbers?: number[]
  data?: Record<string, unknown>
}

export interface SendResult {
  ok: boolean
  id: string
  encrypted: boolean
  subscribers: number
  apns: { sent: number; failed: number; reason: string | null } | null
  /** остаток квоты из заголовков X-Quota-*; null, если сервер их не прислал */
  quota: Quota | null
}

export interface Quota {
  limit: number
  remaining: number
  resetAt: number
}

export interface UploadResult {
  media_id: string
  url: string
  bytes: number
  type: string
}

/** Квота токена исчерпана (HTTP 429). Повторять запрос бессмысленно до resetAt. */
export class QuotaExceededError extends Error {
  constructor(
    public readonly limit: number,
    public readonly resetAt: number,
  ) {
    super(`push quota exceeded (limit ${limit}, resets ${new Date(resetAt).toISOString()})`)
    this.name = "QuotaExceededError"
  }
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "ApiError"
  }
}

export interface SekundantOptions {
  baseUrl: string
  /** API-токен (sk_...) из дашборда */
  token?: string
  /** Ed25519-ключ тенанта для X-Signature: PKCS8 в base64 или PEM */
  signingKey?: string
  /** попыток на сетевые ошибки и 5xx (по умолчанию 3) */
  retries?: number
  fetch?: typeof fetch
}

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/heic"]

export class Sekundant {
  private readonly baseUrl: string
  private readonly token?: string
  private readonly retries: number
  private readonly fetchImpl: typeof fetch
  private signingKeyPromise: Promise<CryptoKey> | null = null

  constructor(opts: SekundantOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "")
    this.token = opts.token
    this.retries = opts.retries ?? 3
    this.fetchImpl = opts.fetch ?? fetch
    if (opts.signingKey) this.signingKeyPromise = importEd25519(opts.signingKey)
  }

  /** Публикует алерт в топик. Бросает QuotaExceededError при исчерпанной квоте. */
  async send(topic: string, alert: Alert): Promise<SendResult> {
    const body = JSON.stringify(alert)
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (this.token) headers.Authorization = `Bearer ${this.token}`
    if (this.signingKeyPromise) {
      const key = await this.signingKeyPromise
      const sig = await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(body))
      headers["X-Signature"] = toBase64(new Uint8Array(sig))
    }
    const res = await this.request(`/api/${encodeURIComponent(topic)}`, { method: "POST", headers, body })
    const quota = quotaFromHeaders(res.headers)
    if (res.status === 429) throw new QuotaExceededError(quota?.limit ?? 0, quota?.resetAt ?? 0)
    const json = await parseJson(res)
    return { ...(json as Omit<SendResult, "quota">), quota }
  }

  /** Загружает картинку; в алерт передаётся вернувшийся media_id. */
  async uploadImage(
    topic: string,
    data: Blob | ArrayBuffer | Uint8Array,
    contentType?: string,
  ): Promise<UploadResult> {
    const type = contentType ?? (data instanceof Blob ? data.type : "")
    if (!IMAGE_TYPES.includes(type)) {
      throw new Error(`contentType must be one of: ${IMAGE_TYPES.join(", ")}`)
    }
    const headers: Record<string, string> = { "Content-Type": type }
    if (this.token) headers.Authorization = `Bearer ${this.token}`
    const body = data instanceof Uint8Array ? new Blob([data.slice().buffer as ArrayBuffer]) : data
    const res = await this.request(`/api/${encodeURIComponent(topic)}/media`, { method: "POST", headers, body })
    return (await parseJson(res)) as UploadResult
  }

  /** Проверяет собственный токен и возвращает остаток квоты. */
  async quota(): Promise<Quota & { name: string }> {
    if (!this.token) throw new Error("token is required for quota()")
    const res = await this.request("/admin/tokens/verify", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}` },
    })
    const json = (await parseJson(res)) as {
      valid: boolean
      name: string
      quota: { limit: number; remaining: number; resetAt: number }
    }
    if (!json.valid) throw new ApiError(401, "token is not valid")
    return { name: json.name, ...json.quota }
  }

  /** Ретраи только на сеть и 5xx: 4xx означает ошибку запроса, повтор не поможет. */
  private async request(path: string, init: RequestInit): Promise<Response> {
    let lastError: unknown
    for (let attempt = 0; attempt < this.retries; attempt++) {
      if (attempt > 0) await sleep(300 * 2 ** (attempt - 1))
      try {
        const res = await this.fetchImpl(`${this.baseUrl}${path}`, init)
        if (res.status >= 500) {
          lastError = new ApiError(res.status, `server error ${res.status}`)
          continue
        }
        return res
      } catch (err) {
        lastError = err
      }
    }
    throw lastError
  }
}

async function parseJson(res: Response): Promise<unknown> {
  const json = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new ApiError(res.status, json.error ?? `${res.status}`)
  return json
}

function quotaFromHeaders(headers: Headers): Quota | null {
  const limit = headers.get("X-Quota-Limit")
  if (limit === null) return null
  return {
    limit: Number(limit),
    remaining: Number(headers.get("X-Quota-Remaining") ?? 0),
    resetAt: Number(headers.get("X-Quota-Reset") ?? 0),
  }
}

function importEd25519(key: string): Promise<CryptoKey> {
  const b64 = key.includes("-----")
    ? key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")
    : key.trim()
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  return crypto.subtle.importKey("pkcs8", der.buffer as ArrayBuffer, "Ed25519", false, ["sign"])
}

function toBase64(bytes: Uint8Array): string {
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
