# SplitMate

Split shared expenses with friends and groups, track balances, and record repayments.

## Local development

Install dependencies, then start the bundled PostgreSQL database in its own terminal:

```sh
npm install
npm run db:local
```

In another terminal, generate the Prisma client, apply migrations, and start Next.js:

```sh
npm run setup:local
npm run dev
```

Run the automated tests with:

```sh
npm test
```