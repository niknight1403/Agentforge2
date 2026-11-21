# Cerebras credit-only policy

Cerebras is preferred only when a trusted billing source confirms remaining promotional credits and the estimated request cost fits within that balance. Paid spend budget is 0 USD. When the balance cannot be verified, skip Cerebras and fail over to Groq, OpenRouter, or Ollama. HTTP success does not prove free credits. Never disable the existing free-only flag globally without a separate billing gate. Test with real credentials only in a protected runtime; do not expose keys in logs.
