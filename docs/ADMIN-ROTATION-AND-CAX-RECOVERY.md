# Admin-Zugang und Modellknoten wiederherstellen (22.10.2026)

## Admin-Zugang

Ein Admin-Kennwort war in mehreren GitHub-Workflows im Klartext enthalten. Es
bleibt im Git-Verlauf sichtbar, selbst nachdem die aktuellen Dateien bereinigt
wurden. Verwende ein neues, einmaliges Kennwort.

1. Aktualisiere auf dem Live-Hub den Wert `VF_ADMIN_PASSWORD` in seiner
   geschuetzten Server-Umgebung und starte den Hub neu. Der Start setzt das
   neue Kennwort; bei einer echten Aenderung werden alle alten Sitzungen des
   Kontos entfernt. `VF_ADMIN_EMAIL` muss das betreffende Admin-Konto benennen.
2. Setze in den GitHub Actions Repository-Secrets `VILLA_ADMIN_EMAIL` und
   `VILLA_ADMIN_PASSWORD` auf dieselben neuen Zugangsdaten. Die manuellen
   Betriebs-Workflows verweigern den Start, wenn eines der Secrets fehlt.
3. Pruefe einen neuen Login und vergewissere dich, dass ein zuvor gueltiger
   Sitzungstoken nicht mehr akzeptiert wird.

Falls der Hub keinen verwalteten `VF_ADMIN_PASSWORD`-Wert hat, kann der Zugang
auf dem Live-Host auch ueber stdin gedreht werden, ohne das Passwort als
Kommandozeilenargument zu uebergeben:

```bash
read -r -s -p 'Neues Admin-Kennwort: ' VF_NEW_ADMIN_PASSWORD
printf '%s' "$VF_NEW_ADMIN_PASSWORD" | node server/scripts/add-admin.mjs "$VF_ADMIN_EMAIL" --password-stdin
unset VF_NEW_ADMIN_PASSWORD
```

Vor einem spaeteren Neustart darf kein alter `VF_ADMIN_PASSWORD`-Wert in der
Server-Umgebung verbleiben, sonst wuerde der Start das Konto erneut auf den
alten Wert setzen. Verwende den alten Zugang nicht weiter.

## CAX31/CAX41

Der Workflow-Lauf #39755565852 hat CAX31 geloescht. Die anschliessende
CAX41-Anlage erhielt von Hetzner `primary_ip_limit`. Die verbleibenden
CAX11/CAX21-Knoten wurden im Workflow-Protokoll weiterhin als laufend
aufgefuehrt, ihre Modellantwort wurde danach nicht live verifiziert.

Vor einem erneuten Upgrade in Hetzner die primaeren IPs und deren
`assignee_id` sowie die Shared-Core-Grenze pruefen. Eine unzugeordnete
Primary-IP kann unter Beachtung von Standort und Kontingent bei einer
Server-Anlage explizit wiederverwendet werden. CAX31 oder CAX41 erst nach
einem erfolgreichen Modelltest und verifizierter Hub-Route umschalten. Der
CAX41-Workflow entfernt CAX31 nun erst nach dieser Verifikation.
