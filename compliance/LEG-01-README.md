# LEG-01: Terms and Privacy rewrite (DRAFT)

`terms-draft.html` is the replacement for `terms.html`. It is **not live** (noindex, and this folder is excluded from deploys by `.assetsignore`).

It removes the contradictions in the live Terms: "offered free of charge" and "nothing requires payment", and the missing refund, cancellation and uptime wording. It names the processors, lawful bases, cross-border transfer, retention, rights, DPO and breach timeline the dossier calls for.

## Do not publish until
1. **LEG-04:** CAC registration done, so the operator name, RC/BN number, address and TIN can replace every `[...]` placeholder.
2. **A Nigerian lawyer has reviewed it** (dossier: LEG-01, LEG-04, LEG-05). Items marked "counsel" need their answer: VAT, liability cap, governing law and courts, lawful bases, cross-border transfer wording, retention periods, breach timeline.
3. **The product matches the words.** Each of these is written for the target state:
   - Paystack card/direct debit with auto-renewal, grace period and self-serve cancel (PAY-01, 05, 06)
   - 14-day trial (PAY-03)
   - Self-serve "Delete my account" and "Download my data" in Settings → Data (PRD-05, LEG-03)
   - Anonymous first-party analytics (PRD-01)
   - Quarterly/annual plans and the pricing page (PAY-04)
   - An email provider (GRW-08). If a feature isn't live, delete its sentence rather than publish it early.
4. **Owner decisions:** refund policy (dossier suggestion: pro-rata within 7 days of an annual charge, none on monthly), grace period length, DPO appointment (LEG-05), response time for rights requests.

## Differences from today's wording worth noticing
- Today's Privacy says "no third-party analytics". The draft allows first-party anonymous events only, which is the dossier's resolution of its own conflict. Do not ship analytics before this text.
- Today's text says there is no self-serve deletion. The draft assumes PRD-05 has shipped.

## After publishing
Change the "Last updated" date, add a What's New entry (`app.js`), and record the lawyer's sign-off here: _not yet reviewed_.
