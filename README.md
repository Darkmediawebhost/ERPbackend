# DARK MEDIA ERP

Company management for DARK MEDIA: co-founders, double-entry books, clients, projects, invoices, payroll, and reports. Money is stored as integer paise and calculated on the server. The dashboard does not invent figures.

Sajeel, Shakeeb, and Ismail are co-founders. They are not employees, they are not on the payroll, and their capital accounts are separate from salary expense.

## Stack

- Client: React 19, Vite, TypeScript, Tailwind CSS, Framer Motion, Recharts, React Router, React Hook Form, Axios
- Server: Node.js, Express, Mongoose, Zod, JWT sessions, Firebase Admin (Google sign-in)
- Database: MongoDB replica set (Atlas, Docker, or a temporary in-memory set)

## Accounting rules

Posted journal lines are the source of truth for profit, cash, and capital. Registers (income, expenses, invoices, salaries) point at those journals.

- Money is integer paise. `₹1.00` is `100`. Splits use the largest-remainder method so the parts add up exactly.
- A journal is posted only when debits equal credits, inside a MongoDB transaction.
- Bank balances change only inside that transaction. An account cannot go negative unless it allows overdraft.
- Posted journals are not deleted. Voiding writes a reversal and marks the original reversed. Reports use `posted` lines only, so a void nets to zero.
- Reusing an idempotency key returns the original posting. A key that already belongs to a reversed entry is rejected; submit a new key.
- Issuing an invoice debits client receivables and credits income (and GST payable when tax is set). A receipt against that invoice debits the bank and credits receivables. It does not record income again.
- A client payment schedule is operational until money is received. A receipt with no invoice credits Client Payments income.
- Direct income and expenses post their own journals and update the chosen bank or cash account.
- Opening a bank account with a balance debits that bank and credits Opening Balance Equity.
- A founder capital account is equity, not salary. Personal business expenses increase that capital (debit expense, credit capital). Reimbursements cannot exceed unreimbursed personal expenses. Withdrawals cannot exceed capital unless the request explicitly allows it.
- Profit distribution is never automatic. Preview it, then approve. The entry debits Retained Earnings and credits each founder capital account. An optional cash payout is a second entry: debit capital, credit bank.
- Active founders' ownership must total 100% and their profit shares must total 100% before profit sharing can be turned on. New founders start at 0%.
- Salary payment posts one journal (debit Employee Salary, credit bank and any advance recovery) and one linked expense. The same employee and month cannot be paid twice.
- Currency stays INR once any journal exists.

Capital for a founder is investments plus personal expenses paid, minus reimbursements and withdrawals, plus profit allocations, minus loss allocations. The equity ledger is the official balance. The integrity report flags a mismatch.

## Requirements

- Node.js 20 or newer
- A MongoDB replica set. Standalone MongoDB refuses the financial transactions and the API returns 503.

## Setup

```bash
npm run install:all
copy .env.example .env
```

On macOS or Linux, use `cp .env.example .env`.

Set `JWT_SECRET` to a random string of at least 32 characters before any production deploy. Change `DEV_LOGIN_PASSWORD`. Set each `FOUNDER_*_EMAIL` to the Gmail address that founder will use. The seed does not overwrite those emails after the first run.

### Database

Docker (persistent):

```bash
docker compose up -d
```

The compose file starts MongoDB 7 as replica set `rs0` on `127.0.0.1:27017`. The default `MONGODB_URI` matches it.

MongoDB Atlas: create a cluster, add your IP, and set `MONGODB_URI` to the SRV connection string. Atlas clusters are replica sets, which is what the transactions need.

No Docker: a temporary database that disappears when the API stops:

```bash
npm run dev:memory
```

The first start downloads a MongoDB binary. Do not use this for company records.

### Run

```bash
npm run dev
```

- App: http://localhost:5173
- API: http://localhost:4000/api/health

The first boot creates company settings, the chart of accounts, the Company Cash account, and the three co-founders. It does not create sample transactions.

Sign-in accepts only `LOGIN_EMAIL` (default `darkmediatech4@gmail.com`). That address opens the master admin account. Shakeeb and Ismail stay co-founders, and they do not get a separate login.

Two ways in:

- Continue with Google, after `GOOGLE_CLIENT_ID` is set. Firebase is not used. Any other Google account is refused.
- Email a 6-digit code to that Gmail. The code expires in 10 minutes.

To send the code, turn on 2-Step Verification for `darkmediatech4@gmail.com`, create an App Password, and put it in `SMTP_PASS`. Then restart the API. The Gmail password itself is not used.

### Google sign-in

Google sign-in uses a Google Cloud OAuth client. It does not use Firebase.

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create a project.
2. Go to **APIs & Services → OAuth consent screen**. Choose External, add the app name Dark Media, and add `darkmediatech4@gmail.com` as a test user.
3. Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**. Choose **Web application**.
4. Under **Authorized JavaScript origins**, add `http://localhost:5173`.
5. Copy the client ID into `GOOGLE_CLIENT_ID` and restart the API.

The button then opens Google’s account chooser. The server asks Google who signed in and allows only `LOGIN_EMAIL`.

### Invoice email

Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM`. Without them, sending an invoice by email returns 503. PDF download still works.

Rupee glyphs in PDFs use `server/assets/NotoSans-Regular.ttf` and `NotoSans-Bold.ttf` when those files are present. Otherwise the PDF uses Helvetica and the text `INR`.

## What to do first

1. Sign in as Sajeel.
2. Open Co-Founder Management and set ownership and profit-share percentages. They must total 100% before profit sharing can be activated.
3. Company Cash already exists with a zero balance. Add bank accounts before recording receipts that should land in a bank.
4. Record income and expenses from those pages. Both post journals and move the selected account.
5. Open Ledger → integrity. It should report that the books are balanced.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | API with file reload, plus the Vite app |
| `npm run dev:memory` | Same, using a temporary replica set |
| `npm test` | Paise, journal balance, profit split, and date tests |
| `npm run seed` | Create foundation records on the configured database |
| `npm run build` | Typecheck and build the client into `client/dist` |
| `npm start` | Serve the API and, if built, the client |

## Production

```bash
npm run build
```

Set `NODE_ENV=production`, a long `JWT_SECRET`, `ALLOW_DEV_AUTH=false`, `CLIENT_ORIGIN` to the public origin, and `TRUST_PROXY=true` when a reverse proxy terminates TLS. Then `npm start`. The API listens on `PORT` (default 4000), serves `client/dist`, and refuses development passwords.

Keep `.env` off the server image and out of git. Back up the MongoDB database. Financial uploads live in `server/uploads`.

Bank account numbers are masked in API responses. Revealing the full number requires user-management permission and writes an audit log.

## Tests

```bash
npm test
```

These tests do not need a database. They cover rupee-to-paise conversion, balanced journals, the 40/30/30 illustration of a ₹90,000 split (the stored shares are whatever the founders configure), the capital formula, and Asia/Kolkata date ranges.
