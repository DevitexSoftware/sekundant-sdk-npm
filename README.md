# @sekundant/sdk

SDK платформы алертов «Секундант» для JS/TS. Ноль рантайм-зависимостей — только
`fetch` и WebCrypto; работает в Node 20+, Bun, Deno и браузере.

```ts
import { Sekundant, QuotaExceededError } from "@sekundant/sdk"

const sk = new Sekundant({
  baseUrl: "https://alerts.example.ru",
  token: "sk_...",              // API-токен из дашборда (несёт месячную квоту)
  // signingKey: "...",         // PKCS8 Ed25519 (base64 или PEM) — X-Signature тенанта
})

// текстовый алерт
await sk.send("ops", { title: "Диск заполнен", message: "pve-07: 3 %", interruption: "time-sensitive" })

// алерт с фотографией: картинка загружается заранее, в пуш едет ссылка
const { media_id } = await sk.uploadImage("ops", photoBlob)
await sk.send("ops", { title: "Фото с объекта", image: media_id })

// квоты
const q = await sk.quota()             // { name, limit, remaining, resetAt }
try {
  await sk.send("ops", { title: "..." })
} catch (err) {
  if (err instanceof QuotaExceededError) {
    // квота кончилась — повторять до err.resetAt бессмысленно
  }
}
```

Ретраи: сеть и 5xx — экспоненциальный бэкофф, 3 попытки; 4xx не ретраится.
Контракт API — в [`../openapi.yaml`](../openapi.yaml).

Смоук-тест против живого сервера: `npm run build && npm test` (поднимет `server.js` сам).
