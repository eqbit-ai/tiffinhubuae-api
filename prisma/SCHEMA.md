# How the database schema actually gets applied

Read this before changing `schema.prisma` or the start command. What the repo
looks like and what it does are two different things, and the difference has
already been one production incident waiting to happen.

## The short version

**`prisma db push` is the schema mechanism. The migrations folder is not.**

`prisma/migrations/` cannot rebuild this database. It is not a partial history —
it is missing twelve of the thirty models outright, including core tables the app
cannot start without.

Measured 2026-08-08 by replaying every migration into an empty database:

| | |
|---|---|
| Models in `schema.prisma` | 30 |
| Tables any migration creates | 20 |
| Models **no** migration ever creates | 12 |

The twelve: `ChatMessage`, `CustomerOTP`, `DeliveryBatch`, `DeliveryItem`,
`DeviceToken`, `Driver`, `DriverLocation`, `Kitchen`, `OneTimeOrder`, `PrepItem`,
`SystemLog`, `TiffinAttribute`.

Four migrations also fail outright on a clean database:

- `20260220120000_add_per_meal_addresses` re-adds three columns
  `20260211120000` already added, so it dies on `column already exists`. This is
  the known duplicate, and it is why `prisma migrate dev` fails on the shadow
  database.
- `20260227120000_globalize_whitelabel_pwa`, `20260803180000_per_meal_delivery`
  and `20260804120000_add_tiffin_attributes` then fail because they reference
  `OneTimeOrder`, `delivery_time` and `DeliveryItem` — objects no migration
  creates.

Production is correct today because `db push` reconciles the database to
`schema.prisma` on every boot. `prisma migrate deploy` in the start command is
effectively a no-op: everything in the folder is already recorded as applied.

## What changed, and why

The start script was:

```
prisma db push --accept-data-loss && node dist/index.js
```

`--accept-data-loss` means: if a column exists in the database but not in
`schema.prisma`, drop it — no prompt, no review, no undo, on every boot. Deleting
one line from `schema.prisma` and deploying was enough to lose a production
column and everything in it.

It is now:

```
prisma db push && node dist/index.js
```

Additive changes still apply automatically, exactly as before. A change that
would destroy data now **fails the boot loudly** instead of succeeding quietly.
A failed deploy is recoverable; a dropped column is not.

## Changing the schema

1. Edit `schema.prisma`.
2. `npm run db:verify` against a copy of production to see the real diff before
   anyone else does. Exits non-zero when the database and the schema disagree.
3. Deploy. `db push` applies additive changes on boot.
4. If the deploy fails on data loss, that is the guard working. Decide
   deliberately: write the data migration yourself, or run
   `npm run db:push:destructive` against production **knowing what it drops**.

Never put `--accept-data-loss` back into the start command.

## Rebuilding from scratch

You cannot rebuild this database from the migrations folder. To stand up a new
environment — this includes the Neon migration — restore a `pg_dump` of
production. The dump carries `_prisma_migrations` with it, so `migrate deploy`
stays consistent afterwards.

Repairing the migration history is possible but is not on the path to anything
currently needed: the migrations are already recorded as applied in production,
and editing an applied migration changes its checksum, which makes
`migrate deploy` fail. Leave them alone unless you are prepared to reconcile
`_prisma_migrations` by hand.
