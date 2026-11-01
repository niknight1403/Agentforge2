set -u
cd /opt/ccc/repo
echo "== Code ziehen (Feature-Branch) =="
git fetch -q origin feature/ai-influenza-phase7 && git reset -q --hard origin/feature/ai-influenza-phase7 && git log --oneline -1
echo "== Build =="
npm run build >/tmp/build.log 2>&1 && echo "Build OK" || { echo "Build FEHLER"; tail -8 /tmp/build.log; exit 1; }
echo "== Unit: OLLAMA_MODEL sicherstellen (Drop-in, kein Secret) =="
mkdir -p /etc/systemd/system/cybersarah-ccc.service.d
cat > /etc/systemd/system/cybersarah-ccc.service.d/ollama-model.conf <<'EOF'
[Service]
Environment="OLLAMA_MODEL=qwen2.5-coder:7b"
EOF
systemctl daemon-reload && systemctl restart cybersarah-ccc
sleep 25
echo "== Ollama-Modelle auf der VM =="
curl -s -m 8 http://127.0.0.1:11434/api/tags | jq -r '.models[].name' | head -6
echo "== Health =="
curl -s -m 8 http://127.0.0.1:13000/api/ready | head -c 120; echo
