# คู่มือนำไปใส่ในโปรเจกต์ Next.js ที่มีอยู่ (Porting Guide)

เอกสารนี้เป็น checklist ทีละขั้นสำหรับเพิ่ม Sign in with Microsoft Entra ID (ผ่าน Better Auth) เข้าไปในโปรเจกต์ Next.js **App Router** ที่มีอยู่แล้ว โดยอิงจากโปรเจกต์ตัวอย่างนี้ ดูภาพรวมและ flow ที่ [README.md](../README.md)

**สัญลักษณ์ความมั่นใจ** ในเอกสารนี้:

- ไม่มีป้ายกำกับ = ตรงกับโค้ดในโปรเจกต์นี้ และอยู่ในชุดทดสอบ e2e (Next.js 16.4.6, Better Auth 1.7.23, SQLite)
- **[ไม่ได้ทดสอบ]** = เป็นแนวทางที่คาดว่าใช้ได้ แต่โปรเจกต์นี้ไม่ได้ทดสอบ ต้องลองและตรวจเองก่อนใช้จริง

---

## 0. ก่อนเริ่ม: เช็คเงื่อนไข

| เรื่อง | ที่โปรเจกต์นี้ทดสอบ |
| --- | --- |
| Next.js | 16.4.6 (App Router) ใช้ `proxy.ts` |
| Better Auth | 1.7.23 |
| ฐานข้อมูล | SQLite ผ่าน `better-sqlite3` 13.2.0 |
| Path alias | `@/*` ชี้ไป root (`tsconfig.json`: `"paths": { "@/*": ["./*"] }`) |

> **คำเตือน** Better Auth 1.7 ใช้ callback `/api/auth/callback/entra` และ `authClient.signIn.social({ provider: "entra", ... })` ถ้าคุณเจอบทความที่ใช้ `/api/auth/oauth2/callback/:id` หรือ `signIn.oauth2` นั่นคือของเวอร์ชันเก่า ใช้ไม่ได้กับเวอร์ชันนี้

---

## 1. ติดตั้ง package

ใช้เวอร์ชันเดียวกับโปรเจกต์นี้ (pin แบบ exact):

```bash
npm install better-auth@1.7.23 better-sqlite3@13.2.0 jose@6.2.17
npm install -D auth@1.7.23 @types/better-sqlite3@9.6.0
```

| Package | ใช้ทำอะไร |
| --- | --- |
| `better-auth` | ตัวหลัก (ใช้ plugin `genericOAuth`, `nextCookies`, `toNextJsHandler`) |
| `better-sqlite3` | ฐานข้อมูล SQLite (ถ้าจะใช้ DB อื่น ดูหัวข้อ 4.3) |
| `jose` | `decodeJwt` เพื่ออ่าน claims จาก id_token ใน `getUserInfo` |
| `auth` (dev) | Better Auth CLI สำหรับ `auth migrate` |
| `@types/better-sqlite3` (dev) | type definitions |

Next.js ในโปรเจกต์นี้คือ 16.4.6 ถ้าโปรเจกต์ของคุณเป็นเวอร์ชันอื่น ดูหัวข้อ 6

---

## 2. Environment variable ที่ต้องเพิ่ม

เพิ่มใน `.env` (ใช้ `.env` ไม่ใช่ `.env.local` เพราะ Better Auth CLI โหลดเฉพาะ `.env`) และใน environment ของ server ตอน deploy ค่าตัวอย่างและคำอธิบายอยู่ใน `.env.example`

| ตัวแปร | จำเป็น | หมายเหตุ |
| --- | --- | --- |
| `BETTER_AUTH_URL` | ใช่ | origin สาธารณะของแอป (ไม่มี path) เช่น `http://localhost:3000` |
| `BETTER_AUTH_SECRET` | ใช่ | อย่างน้อย 32 ตัวอักษร (`openssl rand -base64 32`) |
| `DATABASE_PATH` | ใช่ (เมื่อใช้ SQLite แบบเดียวกับตัวอย่าง) | เช่น `./dev.db` |
| `ENTRA_CLIENT_ID` | ใช่ | Application (client) ID |
| `ENTRA_CLIENT_SECRET` | ใช่ | secret **value** |
| `ENTRA_DISCOVERY_URL` | ใช่ | แบบ tenant-specific: `https://login.microsoftonline.com/<tenant-id>/v2.0/.well-known/openid-configuration` |
| `ENTRA_REDIRECT_URI` | ไม่ | ตั้งเมื่อใช้ Callback URL ที่ผู้ดูแลลงทะเบียนไว้ (ทาง B ใน README หัวข้อ 6) |
| `ENTRA_AUTHORIZATION_URL`, `ENTRA_TOKEN_URL` | ไม่ | ไม่ต้องตั้ง discovery ให้มาแล้ว |
| `ENTRA_SCOPES` | ไม่ | default `openid profile email offline_access` |
| `AUTH_RATE_LIMIT` | ไม่ | `off` ใช้ในการทดสอบเท่านั้น ห้ามใช้ production |

---

## 3. ไฟล์ที่ต้อง copy

Copy ไฟล์เหล่านี้จากโปรเจกต์ตัวอย่างไปยังตำแหน่งเดียวกันในโปรเจกต์ของคุณ (ถ้าโปรเจกต์ของคุณไม่ได้ใช้ alias `@/` ต้องเพิ่ม `paths` ใน `tsconfig.json` หรือแก้ import ที่เป็น `@/lib/...` ในไฟล์ที่ copy)

| ไฟล์ | ทำอะไร | ต้อง copy ไหม |
| --- | --- | --- |
| `lib/env.ts` | อ่านและตรวจ env แบบ lazy (ไม่พังตอน `next build`) คำนวณ redirect URI และมี `PROVIDER_ID = "entra"`, `AUTH_BASE_PATH = "/api/auth"` | ต้อง |
| `lib/claims.ts` | อ่าน claims ของผู้ใช้ (`ppid`, `windowsaccountname`, `email`, Name ID) จาก id_token ทั้งแบบชื่อสั้นและ ClaimType URI | ต้อง |
| `lib/auth.ts` | ตั้งค่า `betterAuth` + `genericOAuth` (verify id_token, สร้าง profile จาก claims, `ppid` เป็น account id, `disableProviderLogout`) และ export `auth` แบบ lazy | ต้อง |
| `lib/auth-client.ts` | `createAuthClient()` สำหรับ client component | ต้อง |
| `app/api/auth/[...all]/route.ts` | `export const { GET, POST } = toNextJsHandler(auth);` | ต้อง |
| `lib/callback-forward.ts` | ส่งต่อ callback จาก path ที่กำหนดเองให้ Better Auth | ต้อง ถ้าใช้ `ENTRA_REDIRECT_URI` ที่ path ไม่ใช่ default |
| `proxy.ts` | เรียก forwarder เมื่อ request ตรงกับ path ใน `ENTRA_REDIRECT_URI` | ต้อง ถ้าใช้ `ENTRA_REDIRECT_URI` แบบกำหนดเอง (ถ้ามี proxy/middleware อยู่แล้ว ดูหัวข้อ 4.2) |
| `instrumentation.ts` | ตอน start: ตรวจ env และพิมพ์ `[auth] Redirect URI in effect (register this in Entra ID): ...` | แนะนำ (ถ้ามีอยู่แล้ว ให้เพิ่มโค้ดใน `register()`) |
| `app/sign-in-button.tsx`, `app/sign-in-errors.ts` | ตัวอย่างปุ่ม sign-in และข้อความ error | ปรับใช้ตาม UI ของคุณ |
| `app/dashboard/sign-out-button.tsx` | ตัวอย่างปุ่ม sign-out | ปรับใช้ตาม UI ของคุณ |
| `mock-idp/server.mjs` | Mock Entra ID สำหรับทดสอบ (ใช้ `jose`) | แนะนำสำหรับทดสอบ แต่อย่า deploy |
| `scripts/e2e.mjs`, `e2e/*`, `playwright.config.ts` | ชุดทดสอบ e2e | ไม่บังคับ (ต้องเพิ่ม `@playwright/test@1.63.0`) |

เพิ่ม script ใน `package.json`:

```json
{
  "scripts": {
    "db:migrate": "auth migrate --config lib/auth.ts --yes",
    "mock-idp": "node mock-idp/server.mjs"
  }
}
```

`mock-idp/server.mjs` เป็นไฟล์ ES module (`.mjs`) จึงรันได้โดยไม่ขึ้นกับ `"type"` ใน `package.json`

เพิ่มใน `next.config.ts` เพื่อไม่ให้ bundle native module (ถ้าใช้ `better-sqlite3`):

```ts
const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
};
```

(ในโปรเจกต์ตัวอย่างมี `agentRules: false` ด้วย แต่นั่นแค่กัน `next dev` เขียนไฟล์ `AGENTS.md` ไม่เกี่ยวกับ auth ไม่ต้อง copy)

---

## 4. สิ่งที่ต้องปรับให้เข้ากับโปรเจกต์ของคุณ

### 4.1 providerId

ในโปรเจกต์นี้ `PROVIDER_ID = "entra"` (ใน `lib/env.ts`) ค่านี้กำหนด 3 อย่าง: callback เริ่มต้น `/api/auth/callback/entra`, ค่า `provider` ตอนเรียก `signIn.social` และ `providerId` ในตาราง `account` ถ้าจะเปลี่ยน ให้แก้ที่ `PROVIDER_ID` แล้วแก้ `provider: "entra"` ใน `app/sign-in-button.tsx` ให้ตรง และถ้าลงทะเบียน redirect URI default ไว้กับ Entra แล้ว ต้องลงทะเบียน URI ใหม่ที่เปลี่ยนตาม

### 4.2 มี `proxy.ts` / `middleware` อยู่แล้ว (merge)

Next.js มีไฟล์ proxy ได้ไฟล์เดียวต่อโปรเจกต์ ถ้าคุณมีอยู่แล้ว **อย่าเขียนทับ** ให้เพิ่มเงื่อนไขของ callback ไว้ต้นฟังก์ชัน:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { customCallbackPath, forwardToAuthCallback } from "@/lib/callback-forward";

export async function proxy(req: NextRequest) {
  // 1) ส่งต่อ OAuth callback แบบ custom path ให้ Better Auth
  if (req.nextUrl.pathname === customCallbackPath()) {
    return forwardToAuthCallback(req);
  }

  // 2) ... logic เดิมของคุณ ...
  return NextResponse.next();
}
```

ข้อควรระวังเรื่อง `config.matcher`: ในตัวอย่างใช้ `matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"]` เพราะ path ของ callback รู้เฉพาะตอน runtime ถ้า matcher เดิมของคุณแคบกว่านั้น ต้องทำให้ครอบคลุม path ของ `ENTRA_REDIRECT_URI` ด้วย และอย่าให้ logic เดิมของคุณ (เช่น redirect ผู้ที่ยังไม่ล็อกอิน) ไปดัก path ของ callback ก่อน

ถ้าไม่ตั้ง `ENTRA_REDIRECT_URI` (ใช้ default path) `customCallbackPath()` จะคืน `null` และไม่มีอะไรถูกส่งต่อ ในกรณีนี้ไม่จำเป็นต้องมี `proxy.ts` และ `lib/callback-forward.ts` เลย

### 4.3 มีฐานข้อมูลอยู่แล้ว

ใน `lib/auth.ts` ตัวอย่างสร้าง instance ของฐานข้อมูลตรง ๆ:

```ts
database: new Database(env.databasePath),
```

ถ้าโปรเจกต์ของคุณมีฐานข้อมูลอยู่แล้ว ให้เปลี่ยนบรรทัดนี้เป็น instance ของฐานข้อมูลของคุณ แล้วรัน `npm run db:migrate` ใหม่เพื่อสร้างตารางของ Better Auth (`user`, `account`, `session` และตารางอื่นที่ Better Auth ต้องใช้) **[ไม่ได้ทดสอบ]** โปรเจกต์นี้ทดสอบกับ SQLite (`better-sqlite3`) เท่านั้น การใช้ฐานข้อมูลอื่นหรือ ORM (เช่น Prisma/Drizzle) ต้องอ่านเอกสารของ Better Auth สำหรับ adapter นั้น และทดสอบ flow ทั้งหมดด้วย Mock IdP อีกรอบ ถ้าเลิกใช้ SQLite ให้ลบ `better-sqlite3`, `DATABASE_PATH` และ `serverExternalPackages` ที่ไม่จำเป็นออกด้วย

ก่อนรัน migrate กับฐานข้อมูลที่มีข้อมูลจริง ควรสำรองข้อมูลและลองบนสำเนาก่อน

### 4.4 ป้องกัน route ด้วย `auth.api.getSession`

โปรเจกต์นี้ป้องกันหน้าใน Server Component (`app/dashboard/page.tsx`) ไม่ได้ป้องกันที่ `proxy.ts`:

```tsx
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";

export default async function DashboardPage() {
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) redirect("/");
  // ... ใช้ session.user.name, session.user.email, session.session.expiresAt
}
```

ใช้รูปแบบเดียวกันกับทุกหน้า/Route Handler/Server Action ที่ต้องล็อกอิน ตรวจสิทธิ์ที่จุดที่ใช้ข้อมูลเสมอ

### 4.5 เรียก sign-in / sign-out จาก client

```tsx
"use client";
import { authClient } from "@/lib/auth-client";

await authClient.signIn.social({
  provider: "entra",
  callbackURL: "/dashboard",      // หน้าที่ไปหลังสำเร็จ
  errorCallbackURL: "/",          // หน้าที่ไปเมื่อ error (รับ ?error=...&error_description=...)
});

await authClient.signOut();       // ล้างเฉพาะ session ของแอป
```

หน้าที่รับ `errorCallbackURL` ควรอ่าน query `error` และ `error_description` (ดู `app/page.tsx` และ `app/sign-in-errors.ts`) ใน `lib/auth.ts` ยังมี `onAPIError: { errorURL: "/" }` สำหรับ error ที่เกิดก่อนอ่าน state ได้ (เช่น state ถูกแก้ไข) ให้ปรับ `"/"` เป็นหน้าที่ต้องการ

### 4.6 สิ่งที่ในโค้ดตัวอย่างตั้งไว้โดยตั้งใจ (อย่าเอาออกถ้าไม่เข้าใจ)

| ตั้งค่า | เหตุผล |
| --- | --- |
| `requireIdTokenVerification: true` | ห้ามถอยไป decode id_token แบบไม่ verify |
| `pkce: true` | ใช้ PKCE (S256) |
| `getUserInfo` จาก id_token | IdP ใส่ `ppid`, `windowsaccountname`, `email` ไว้ใน id_token (อ่านด้วย `lib/claims.ts`) |
| `emailVerified: false` | IdP ไม่ส่ง `email_verified` |
| `accountSubject` = `ppid` | `ppid` (HRI_ID / Student_ID) คงที่ของบุคคล ส่วน `sub` เป็น pairwise ต่อแอป |
| `user.additionalFields` (`ppid`, `username`) + `mapProfileToUser` | เก็บ claims ลง `user` ต้องรัน `npm run db:migrate` เพื่อเพิ่มคอลัมน์ และห้ามตั้ง `input: false` (Better Auth จะไม่คัดลอกค่าให้) |
| `disabledPaths: ["/update-user"]` | ไม่ให้ผู้ใช้ที่ล็อกอินแก้ `ppid`/`username` ของตัวเองผ่าน API |
| `disableProviderLogout: true` | Sign out ล้างเฉพาะ session ของแอป ไม่พาไป logout ทั้งระบบของ Microsoft |
| `nextCookies()` เป็น plugin สุดท้าย | ให้ cookie ถูกตั้งได้จาก Server Action/Route Handler |

---

## 5. ตรวจกับ Mock IdP ก่อนแตะ tenant จริง

ตรวจด้วย Mock IdP ก่อนทุกครั้ง เพื่อแยกปัญหาโค้ดออกจากปัญหาการตั้งค่า Entra:

1. ใส่ค่า mock ใน `.env` (ค่าจาก `.env.example` ใช้ได้เลย):

   ```bash
   BETTER_AUTH_URL=http://localhost:3000
   BETTER_AUTH_SECRET=change-me-to-a-long-random-string-of-32-plus-chars
   DATABASE_PATH=./dev.db
   ENTRA_CLIENT_ID=00000000-0000-0000-0000-000000000001
   ENTRA_CLIENT_SECRET=mock-client-secret
   ENTRA_DISCOVERY_URL=http://127.0.0.1:4011/11111111-2222-3333-4444-555555555555/v2.0/.well-known/openid-configuration
   ```
2. Terminal 1: `npm run mock-idp`
3. Terminal 2: `npm run db:migrate` แล้ว `npm run dev`
4. ดู log ตอน start: `[auth] Redirect URI in effect (register this in Entra ID): http://localhost:3000/api/auth/callback/entra`
5. เปิด <http://localhost:3000> (ใช้ `localhost` ไม่ใช่ `127.0.0.1`) กด sign-in ต้องไปถึงหน้าหลังล็อกอินด้วยข้อมูลของ Ada Lovelace
6. ตรวจตาราง: `sqlite3 dev.db 'SELECT id, userId, providerId, accountId FROM "account";'` ต้องมีแถว `providerId = entra` (ถ้าไม่มี `sqlite3` ดูคำสั่ง node ใน README หัวข้อ 4)
7. ลองทาง B: ตั้ง `ENTRA_REDIRECT_URI=http://localhost:3000/signin-oidc` แล้ว restart ดู log และ sign in ซ้ำ ต้องผ่านเหมือนเดิม (เปิด `curl http://127.0.0.1:4011/__log` ดูว่า `redirect_uri` ใน authorize และ token request เป็นค่าเดียวกัน)
8. ลองผิดพลาดโดยตั้งใจ เช่น `curl -X POST http://127.0.0.1:4011/__config -d '{"authorizeError":"access_denied"}'` ต้องเห็นข้อความ error ที่อ่านรู้เรื่อง แล้ว `curl -X POST http://127.0.0.1:4011/__reset`

เมื่อผ่านหมดแล้วค่อยเปลี่ยนเป็นค่าของ tenant จริงตาม README หัวข้อ 7

---

## 6. หมายเหตุสำหรับ Next.js 15 (หรือเวอร์ชันอื่นที่ไม่ใช่ 16)

**[ไม่ได้ทดสอบ]** โปรเจกต์นี้ทดสอบเฉพาะ Next.js 16.4.6 เท่านั้น ข้อต่อไปนี้เป็นเพียงข้อสังเกตจากความแตกต่างที่ทราบ ไม่ใช่ผลที่ยืนยันแล้ว

- ใน Next.js 16 ไฟล์ middleware ถูกเปลี่ยนชื่อเป็น `proxy.ts` (export ชื่อ `proxy`) และโค้ดในโปรเจกต์นี้อาศัยว่า proxy รันบน **Node.js runtime** เพื่อเรียก Better Auth และ SQLite ได้ตรง ๆ (ตามคอมเมนต์ใน `proxy.ts`)
- ใน Next.js 15 ไฟล์ที่เทียบเท่าคือ `middleware.ts` ที่ export ฟังก์ชันชื่อ `middleware` (แทนที่จะเป็น `proxy`) ต้องตรวจเองว่า middleware ใน Next.js 15 ที่คุณใช้รันบน runtime ที่เรียก `better-sqlite3` ได้หรือไม่ ถ้าไม่ได้ ทาง B (custom callback path) อาจใช้ไม่ได้ตามที่เขียนไว้
- ทางเลือกที่ **ไม่ได้ทดสอบ**: ไม่ใช้ proxy/middleware เลย แต่ลงทะเบียน callback ที่ default path `/api/auth/callback/entra` (ทาง A) ซึ่งไม่ต้องมีตัวส่งต่อ

ส่วนที่ไม่เกี่ยวกับ proxy (route handler `app/api/auth/[...all]/route.ts`, `lib/auth.ts`, `getSession` ใน Server Component) ก็ **ไม่ได้ทดสอบ** บน Next.js 15 เช่นกัน ถ้าจะใช้ ให้รัน Mock IdP flow ในหัวข้อ 5 ให้ผ่านก่อน

---

## 7. Checklist สรุป (Done)

- [ ] ติดตั้ง package เวอร์ชัน exact ตามหัวข้อ 1
- [ ] เพิ่ม env ครบ (หัวข้อ 2) ใน `.env` และ environment ของ server
- [ ] ใช้ `.env` (ไม่ใช่ `.env.local`) เพราะ Better Auth CLI โหลดเฉพาะ `.env`
- [ ] copy `lib/env.ts`, `lib/auth.ts`, `lib/auth-client.ts`, `app/api/auth/[...all]/route.ts`
- [ ] (ทาง B) copy `lib/callback-forward.ts` และ merge `proxy.ts` เข้ากับของเดิม
- [ ] เพิ่ม `instrumentation.ts` เพื่อพิมพ์ Redirect URI ตอน start
- [ ] เพิ่ม `serverExternalPackages: ["better-sqlite3"]` ใน `next.config.ts` (ถ้าใช้ SQLite)
- [ ] เพิ่ม script `db:migrate` และรัน `npm run db:migrate` สำเร็จ
- [ ] หน้าและ API ที่ต้องล็อกอินตรวจด้วย `auth.api.getSession`
- [ ] ปุ่ม sign-in ใช้ `authClient.signIn.social({ provider: "entra", ... })` และมีหน้าที่แสดง `error` / `error_description`
- [ ] ผ่านการทดสอบกับ Mock IdP (sign-in, ตารางมีข้อมูล, sign-out, error case)
- [ ] ใช้ `ENTRA_DISCOVERY_URL` แบบ tenant-specific
- [ ] ค่า `[auth] Redirect URI in effect` ตรงกับ Entra ทุกตัวอักษร และ platform เป็น **Web**
- [ ] sign-in กับ tenant จริงสำเร็จ
- [ ] ก่อน production: HTTPS, secret store, วันหมดอายุของ client secret, ฐานข้อมูลจริง, `BETTER_AUTH_URL` เป็น origin สาธารณะ, ไม่ deploy Mock IdP, ไม่ตั้ง `AUTH_RATE_LIMIT=off` (ดู README หัวข้อ 11)
