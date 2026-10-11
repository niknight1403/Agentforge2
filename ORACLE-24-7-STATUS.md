# Oracle 24/7 — Status

MARKER: ORACLE-24-7-ONLINE
Instanz: 152.70.8.227 (eu-frankfurt-1, 4 OCPU / 24 GB, Ubuntu 22.04)
Hub: VillaForge v1.10.0 — laeuft als systemd-Dienst seit 2026-10-11 00:47 UTC
Extern erreichbar: http://152.70.8.227:12000 (Health ok, Ingress TCP 12000 aktiv)

Villa: #1 CyberSarah Villa (24 Agenten, Schwarm) — RUNNING seit 00:48 UTC
Wiederaufbau: Hub aus Repo, Villa per Backup-API von 167.233.118.190 importiert
(25 Agenten, 12 Aufgaben, 6 Memories uebernommen)

LLM-Routen (Reihenfolge der Kette):
- Ollama-Oracle (qwen2.5-coder:7b, lokal, Prio 5) — aktiv
- Ollama-Oracle-2 (llama3.1:8b, lokal, Prio 5) — Pull laeuft
- Ollama-Oracle-Fast (qwen2.5-coder:3b, lokal, Prio 5) — Pull laeuft
- Groq GPT-OSS 120B + 20B (free tier, Keys aktiv, 21+ Calls OK)
- OpenRouter Gemma 4 31B (free, registriert)
- Gemini 3.8 Flash / Cerebras / Mistral / Together (registriert, Keys optional)

Ollama: qwen2.5-coder:7b (4.7 GB) geladen; llama3.1:8b + qwen2.5-coder:3b im Pull
Sync: villaforge-sync.timer (10 Min), Zyklus #1 um 00:57 UTC gruen nach GitHub
Neue VPS (167.233.118.190): Villa gestoppt, Sync laeuft noch bis Key-Uebertragung
