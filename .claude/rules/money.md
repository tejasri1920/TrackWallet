---
description: Money handling rules. Applies to all financial calculation code.
paths:
  - "src/**/*.ts"
  - "src/**/*.tsx"
  - "tests/**/*.ts"
---

- All monetary values are signed integers in minor units (USD cents, INR paise).
- Conversion to display happens only at the render boundary, never in the data layer.
- Never use `parseFloat` on a monetary string. Use a dedicated parser that
  returns minor units and throws on ambiguity.
- Never sum `amount_native` across rows of differing currency. Sum `amount_usd`
  for any cross-account or portfolio-level total.
- Rounding: when deriving `amount_usd` from `amount_native`, round half away
  from zero, and store the result. Never recompute a stored `amount_usd` on read.
