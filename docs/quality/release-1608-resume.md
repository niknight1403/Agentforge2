# Release 1.60.8

Belegter Blocker: Run41286082063 verweigert Veröffentlichung, da Tagv1.60.7 auf e9dd849f zeigt, Build aber960a5b2 ist. Bestehenden Tag nicht verschieben. Vorhandenes scripts/bump-version.mjs auf1.60.8 angewendet, Android code71. Lokaler node --test server/tests/release-version.test.mjs:1 bestanden,Exit0.

Noch kein abgeschlossener Sprint: CI, Integration und neue Produktionsabnahme fehlen. VF-0009 bleibt offen. Keine Villenstatusänderung. Offene PR40/41/30 unverändert. Nächster Schritt: diesen PR nach vollständigen Gates integrieren; Release aus demselben Commit über bestehenden Workflow prüfen. Weitere neun Sprints erst nach diesem Abschluss konkretisieren. Fehlendes Free-Route-Hunter-Webprodukt ist separater Blocker, kein APK-Fallback.
