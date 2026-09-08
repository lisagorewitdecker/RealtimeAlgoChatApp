---
name: Cryptocurrency boundary
description: Product boundary separating rejected cryptocurrency features from required message encryption.
---

Do not add cryptocurrency payments, wallet connections, blockchain transactions, or crypto-token acceptance to this product. Cryptographic end-to-end encryption remains required and should not be removed or described as cryptocurrency.

**Why:** The product owner explicitly rejected accepting cryptocurrency, while the app relies on cryptography to protect messages and shared room keys.

**How to apply:** Before adding payment, wallet, Web3, or blockchain dependencies and UI, confirm that the approach is non-cryptocurrency. Keep TweetNaCl/X25519/secretbox code when maintaining E2EE.