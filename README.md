# QCare

**Smart Patient Queue & Service Management** for Philippine hospitals and clinics.
Created by JPD.

QCare follows one patient through a whole hospital visit. Registration, doctor, laboratory, X-ray, cashier and pharmacy all stay connected to the same **Visit ID**, so the patient never starts over at each window.

```
Patient (one record, forever)
   └── Visit (one per hospital trip)
         └── Services (doctor, lab, X-ray, cashier, pharmacy)
               └── Queue numbers (D-025, LAB-014, C-031, PH-019)
```

## What it uses

| Part | What | Notes |
|---|---|---|
| Server | Node.js + Express | one small server, no build step |
| Database | **Supabase Postgres** | all hospital data |
| Staff sign-in | **Supabase Auth** | passwords are kept by Supabase, never by QCare |
| Live updates | WebSockets | the socket only says "something changed". Patient data is never sent over it |
| Screens | plain HTML, CSS, JavaScript | staff app, TV board, patient phone page |

QCare keeps **who can do what** (roles and permissions) in its own `users` table. Supabase only checks the password.

## Try it in 2 minutes (no Supabase yet)

```bash
npm install
npm start
```

Open http://localhost:3000. With nothing configured, QCare runs on a small built-in Postgres and local passwords so you can look around. Demo accounts all use the password `Qcare#2026`:

`admin`, `reception`, `drsantos`, `lab`, `cashier`, `pharmacy`, `display`

The TV board is at http://localhost:3000/display. Open it on a second screen and watch it change when the doctor presses CALL NEXT.

## Connect it to Supabase

1. Make a project at https://supabase.com. Write down the database password you choose.
2. In the project, click **Connect**. Copy the **Session pooler** connection string. Put it in `.env` as `DATABASE_URL` and swap `[YOUR-PASSWORD]` for your password.
3. Go to **Project Settings > API**. Copy the project URL, the `anon` (or "publishable") key, and the `service_role` (or "secret") key into `.env`.
4. Go to **Authentication > Sign In / Providers** and turn **off** "Allow new users to sign up". Only the administrator should be able to add staff.
5. Run:
   ```bash
   cp .env.example .env     # then edit it
   npm install
   npm start
   ```

The first start builds every table, switches on row-level security, and creates the starter data. The screen prints which database and sign-in it is using. Check that it says **Supabase / PostgreSQL** and **Supabase Auth**.

If you would rather build the tables yourself, paste `supabase/schema.sql` into **SQL Editor** and press Run.

### Why row-level security matters here

Supabase gives every project a public web API. If a table is open to it, anyone with the public key could read it. QCare switches row-level security **on for every table with no open rules**, so that public API sees nothing. Only QCare's server, which connects with your database password, can reach patient data, and the server checks the user's role on every request.

**Keep `SUPABASE_SERVICE_ROLE_KEY` and `DATABASE_URL` secret.**

## Real use (not a demo)

In `.env`:

```
QCARE_DEMO=0
ADMIN_USERNAME=admin
ADMIN_PASSWORD=pick-a-long-password-1
HOSPITAL_NAME=Your Hospital
COOKIE_SECURE=1
TRUST_PROXY=1
```

Then `npm start`. You get your departments, priority rules, and one administrator. No patients. Sign in, then:

1. **Settings**: hospital name, logo, queue number format, priority rules, voice, session timeout.
2. **Departments**: your departments, services and prices, counters and rooms.
3. **Users**: one account per staff member with the right role.

Serve QCare over **HTTPS**. Any host that keeps a Node process running works (Render, Railway, Fly.io, a VPS, or a computer inside the hospital). It will not work on serverless-only hosts, because live updates need a long-running connection.

Staff are stored in Supabase as `username@qcare.example.com`. You can change that domain with `QCARE_EMAIL_DOMAIN`. Changing it later does not rename existing accounts.

## Roles

| Role | Can do |
|---|---|
| Super Administrator | everything: users, departments, services, priority rules, reports, audit log, settings |
| Receptionist | register and search patients, create visits, issue queue numbers |
| Doctor | call and serve patients, send them to lab, X-ray, cashier or pharmacy |
| Laboratory Staff | lab and X-ray queues, specimens, results ready |
| Cashier | payment queue, record payments |
| Pharmacist | pharmacy queue, prescriptions |
| Display Operator | the TV board and voice settings |

The administrator can tick or untick what each role is allowed to do under **Users > Roles & access**.

## Things worth knowing

- **Queue numbers are never reused by accident.** The counter lives in the database and goes up one at a time, even if two receptionists press the button together.
- **Two staff pressing CALL NEXT at once get different patients.** The database locks the row. A double-click by one person calls only one patient.
- **A payment sent twice is saved once.** Every payment form carries a one-time key.
- **Nothing important is deleted.** Departments, services, users and counters are hidden, not erased. The audit log records who did what, when, and from which device.
- **The TV board shows numbers only.** Patient names appear only if an administrator turns that on in Settings.
- **The patient page needs no account.** The QR code holds a long random token, not a patient ID, and it expires (24 hours by default).
- **Waiting times are estimates.** They use today's real average service time, divided by the number of counters working.
- **Staff are signed out after idle time** (20 minutes by default). Background screen refreshes do not count as activity.

## Commands

| Command | What it does |
|---|---|
| `npm start` | run QCare |
| `npm run dev` | run and restart when files change |
| `npm test` | run the 25 automated checks (see below) |
| `npm run schema` | rewrite `supabase/schema.sql` |
| `npm run reset` | delete the **local trial** database (it refuses to touch Supabase) |

## About the tests

`npm test` plays the whole 24-step patient journey from the brief over the real HTTP API, then checks wrong passwords, missing CSRF tokens, role limits, bad QR tokens, permission-aware search, wrong-patient calls, priority, exports, and the audit trail.

The tests run on **PGlite**, which is real PostgreSQL running inside Node, with local passwords. They do **not** talk to Supabase. PGlite uses a single connection, so the "two people at once" tests prove the logic but cannot prove true parallel locking. That part depends on Postgres itself, which Supabase runs. Before go-live, do one real check with two browsers pressing CALL NEXT together.

## Folder map

```
server/
  index.js       starts the server, security headers, WebSocket
  core.js        the queue engine: numbering, priority, routing, payments
  routes.js      the API
  auth.js        sessions, sign-in, CSRF, permissions
  authprovider.js  Supabase Auth (or local passwords for trial mode)
  db.js          Supabase/Postgres connection
  schema.js      tables, indexes, row-level security
  seed.js        first-run and demo data
  stats.js       dashboard numbers and reports
public/          staff app, /display TV board, /q/<token> patient page
supabase/schema.sql   the same schema, ready to paste
test/workflow.js      the automated checks
```
