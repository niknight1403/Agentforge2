# NexusSphere — Villa 38: Professioneller Entwicklungsauftrag v3

**Auftrag:** Führe die bestehende Villa 38 zur produktionsfähigen, überprüfbaren NexusSphere Enterprise-Plattform. Originalprojektauftrag aus Hub ist verbindlich; keine zweite Villa anlegen.

**Engineering-Gates:** Repository und Aufgaben inventarisieren; Workspace sichern; Rust cargo tests, Web-Build/Test/Smoke real ausführen. Fehlende Quell- oder Testdateien implementieren, nicht Q-GATE umgehen. Architektur: Rust-Core und sichere Agentenkommunikation, FastAPI mit Auth/RBAC/persistenten Tasks, React-UI; Web vor Mobile/Desktop stabilisieren. Stripe zunächst mit Test-Checkout, signiertem Webhook, Idempotenz und Subscription-Zuständen; keine Live-Zahlungen ohne gesicherte Berechtigungen.

**Free Route Hunter:** Vorhandene Agentforge2-Routen nur über vertrauenswürdigen Hub-Adapter/konfigurierten serverseitigen Export verwenden. Kostenfreie rechtmäßige Modelle bevorzugen; sichere Secret-Referenzen, Quota- und RPM-Grenzen, Timeout, Circuit-Breaker, Cooldown bei 429, lokales Ollama als Fallback. Unverfügbare Modelle nicht als erfolgreiche Aufgabenerledigung deklarieren. Bootstrap-Adapter befindet sich im NexusSphere-MVP-Archiv, Live-Verbindung ist gesondert nachzuweisen.

**Sprints 1–10:** (1) Inventar/Backup, (2) Rust-Core + cargo test, (3) Web-Build/Test/Smoke, (4) echte Q-Gates, (5) Free-Route-Failover, (6) API/RBAC/Tasks, (7) verschlüsseltes Mehrknoten-Mesh, (8) Web und mobile UX an echte APIs, (9) Stripe-Testmodus mit Webhooks, (10) E2E/Security/Release mit Rollback.

**Abnahme:** Jede Sprintmeldung enthält Dateidiff/Commit, echte Prüfkommandos, Laufresultate und offene Blocker. Keine Dummy-Implementierungen, keine selbst entwickelte Kryptografie, keine unbelegten Umsatzversprechen. Nur nach erfolgreichen Builds, realem Nutzerfluss, verifizierten Deployments und Release-Artefakten "alles grün" melden. Maximal zwei Villen gleichzeitig, kein ständiges Rotieren.
