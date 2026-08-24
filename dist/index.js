// SDK «Секунданта» для JS/TS: ноль рантайм-зависимостей (fetch + WebCrypto).
// Работает в Node 20+, Bun, Deno и браузере.
//
//   const sk = new Sekundant({ baseUrl: "https://alerts.example.ru", token: "sk_..." })
//   const { media_id } = await sk.uploadImage("warehouse", photoBlob)
//   await sk.send("warehouse", { title: "Фото с объекта", image: media_id })
/** Квота токена исчерпана (HTTP 429). Повторять запрос бессмысленно до resetAt. */
export class QuotaExceededError extends Error {
    limit;
    resetAt;
    constructor(limit, resetAt) {
        super(`push quota exceeded (limit ${limit}, resets ${new Date(resetAt).toISOString()})`);
        this.limit = limit;
        this.resetAt = resetAt;
        this.name = "QuotaExceededError";
    }
}
export class ApiError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
        this.name = "ApiError";
    }
}
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/heic"];
export class Sekundant {
    baseUrl;
    token;
    retries;
    fetchImpl;
    signingKeyPromise = null;
    constructor(opts) {
        this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
        this.token = opts.token;
        this.retries = opts.retries ?? 3;
        this.fetchImpl = opts.fetch ?? fetch;
        if (opts.signingKey)
            this.signingKeyPromise = importEd25519(opts.signingKey);
    }
    /** Публикует алерт в топик. Бросает QuotaExceededError при исчерпанной квоте. */
    async send(topic, alert) {
        const body = JSON.stringify(alert);
        const headers = { "Content-Type": "application/json" };
        if (this.token)
            headers.Authorization = `Bearer ${this.token}`;
        if (this.signingKeyPromise) {
            const key = await this.signingKeyPromise;
            const sig = await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(body));
            headers["X-Signature"] = toBase64(new Uint8Array(sig));
        }
        const res = await this.request(`/api/${encodeURIComponent(topic)}`, { method: "POST", headers, body });
        const quota = quotaFromHeaders(res.headers);
        if (res.status === 429)
            throw new QuotaExceededError(quota?.limit ?? 0, quota?.resetAt ?? 0);
        const json = await parseJson(res);
        return { ...json, quota };
    }
    /** Загружает картинку; в алерт передаётся вернувшийся media_id. */
    async uploadImage(topic, data, contentType) {
        const type = contentType ?? (data instanceof Blob ? data.type : "");
        if (!IMAGE_TYPES.includes(type)) {
            throw new Error(`contentType must be one of: ${IMAGE_TYPES.join(", ")}`);
        }
        const headers = { "Content-Type": type };
        if (this.token)
            headers.Authorization = `Bearer ${this.token}`;
        const body = data instanceof Uint8Array ? new Blob([data.slice().buffer]) : data;
        const res = await this.request(`/api/${encodeURIComponent(topic)}/media`, { method: "POST", headers, body });
        return (await parseJson(res));
    }
    /** Проверяет собственный токен и возвращает остаток квоты. */
    async quota() {
        if (!this.token)
            throw new Error("token is required for quota()");
        const res = await this.request("/admin/tokens/verify", {
            method: "POST",
            headers: { Authorization: `Bearer ${this.token}` },
        });
        const json = (await parseJson(res));
        if (!json.valid)
            throw new ApiError(401, "token is not valid");
        return { name: json.name, ...json.quota };
    }
    /** Ретраи только на сеть и 5xx: 4xx означает ошибку запроса, повтор не поможет. */
    async request(path, init) {
        let lastError;
        for (let attempt = 0; attempt < this.retries; attempt++) {
            if (attempt > 0)
                await sleep(300 * 2 ** (attempt - 1));
            try {
                const res = await this.fetchImpl(`${this.baseUrl}${path}`, init);
                if (res.status >= 500) {
                    lastError = new ApiError(res.status, `server error ${res.status}`);
                    continue;
                }
                return res;
            }
            catch (err) {
                lastError = err;
            }
        }
        throw lastError;
    }
}
async function parseJson(res) {
    const json = (await res.json().catch(() => ({})));
    if (!res.ok)
        throw new ApiError(res.status, json.error ?? `${res.status}`);
    return json;
}
function quotaFromHeaders(headers) {
    const limit = headers.get("X-Quota-Limit");
    if (limit === null)
        return null;
    return {
        limit: Number(limit),
        remaining: Number(headers.get("X-Quota-Remaining") ?? 0),
        resetAt: Number(headers.get("X-Quota-Reset") ?? 0),
    };
}
function importEd25519(key) {
    const b64 = key.includes("-----")
        ? key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")
        : key.trim();
    const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return crypto.subtle.importKey("pkcs8", der.buffer, "Ed25519", false, ["sign"]);
}
function toBase64(bytes) {
    let bin = "";
    for (const b of bytes)
        bin += String.fromCharCode(b);
    return btoa(bin);
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
