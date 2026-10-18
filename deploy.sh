#!/usr/bin/env bash
# Idempotent Linux ARM64/x86-64 deployment. Never deletes data volumes.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
umask 077
MAX_HEAL_ATTEMPTS="${VF_DEPLOY_ATTEMPTS:-4}"
HEALTH_WAIT_SECONDS="${VF_HEALTH_WAIT_SECONDS:-60}"
SERVICES=(postgres redis hub caddy)
PRIV=()
DOCKER=(docker)
log() { printf '[deploy] %s\n' "$*"; }
die() { printf '[deploy] ERROR: %s\n' "$*" >&2; exit 1; }

ensure_tools() {
  [[ $(uname -s) == Linux ]] || die 'A Linux server is required.'
  case "$(uname -m)" in aarch64|arm64|x86_64) ;; *) die 'Supported architectures: ARM64 and x86-64.' ;; esac
  if (( EUID != 0 )); then
    command -v sudo >/dev/null || die 'Root privileges or passwordless sudo are required for installation.'
    sudo -n true || die 'Passwordless sudo is required for unattended setup.'
    PRIV=(sudo -n)
  fi
  if ! command -v curl >/dev/null || ! command -v openssl >/dev/null || ! command -v python3 >/dev/null || ! command -v flock >/dev/null; then
    if command -v apt-get >/dev/null; then
      "${PRIV[@]}" apt-get update
      "${PRIV[@]}" apt-get install -y ca-certificates curl openssl python3 util-linux
    elif command -v dnf >/dev/null; then
      "${PRIV[@]}" dnf install -y ca-certificates curl openssl python3 util-linux
    else die 'Automatic package installation supports Debian/Ubuntu and Oracle/RHEL Linux.'; fi
  fi
  if ! command -v docker >/dev/null; then
    if command -v apt-get >/dev/null; then
      local installer
      installer=$(mktemp)
      curl --proto '=https' --tlsv1.2 -fsSL https://get.docker.com -o "$installer"
      "${PRIV[@]}" sh "$installer"
      rm -f "$installer"
    elif command -v dnf >/dev/null; then
      "${PRIV[@]}" dnf install -y dnf-plugins-core
      "${PRIV[@]}" dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
      "${PRIV[@]}" dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    else die 'Cannot install Docker on this distribution.'; fi
  fi
  if ! docker info >/dev/null 2>&1; then
    "${PRIV[@]}" systemctl enable --now docker
    DOCKER=("${PRIV[@]}" docker)
  fi
  "${DOCKER[@]}" info >/dev/null || die 'Docker daemon is unavailable.'
  if ! "${DOCKER[@]}" compose version >/dev/null 2>&1; then
    if command -v apt-get >/dev/null; then "${PRIV[@]}" apt-get install -y docker-compose-plugin;
    elif command -v dnf >/dev/null; then "${PRIV[@]}" dnf install -y docker-compose-plugin;
    else die 'Docker Compose v2 is required.'; fi
  fi
  "${DOCKER[@]}" compose version >/dev/null || die 'Docker Compose v2 is unavailable.'
}

provision_env() {
  python3 - <<'PY'
import os,re,subprocess,pathlib,tempfile
p=pathlib.Path('.env')
if p.is_symlink(): raise SystemExit('Refusing a symlink .env')
lines=(p if p.exists() else pathlib.Path('.env.example')).read_text().splitlines()
values={}
for line in lines:
    m=re.match(r'^([A-Z][A-Z0-9_]*)=(.*)$',line)
    if m:
        if m[1] in values: raise SystemExit('Duplicate environment key: '+m[1])
        values[m[1]]='' if m[2] in ('\"\"',"''") else m[2]
def setval(k,v): values[k]=v
for key in ('VF_ADMIN_PASSWORD','POSTGRES_PASSWORD','REDIS_PASSWORD','WEBHOOK_INTERNAL_TOKEN'):
    if not values.get(key): setval(key,subprocess.check_output(['openssl','rand','-hex','32'],text=True).strip())
for k,v in {'COMPOSE_PROJECT_NAME':'villaforge','POSTGRES_USER':'villaforge','POSTGRES_DB':'villaforge','VF_ADMIN_EMAIL':'admin@villaforge.local','HUB_BIND_PORT':'12000','HTTP_PORT':'80','HTTPS_PORT':'443','NODE_OPTIONS':'--max-old-space-size=320','VF_MAX_CONCURRENCY':'1'}.items():
    if not values.get(k): setval(k,v)
for key in ('CADDY_DOMAIN','VF_ADMIN_EMAIL'):
    if os.environ.get(key): setval(key,os.environ[key])
domain=values.get('CADDY_DOMAIN','')
if domain and not re.fullmatch(r'[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?',domain): raise SystemExit('CADDY_DOMAIN must be a DNS name without scheme or port')
for key in ('POSTGRES_USER','POSTGRES_DB','COMPOSE_PROJECT_NAME'):
    if not re.fullmatch(r'[a-zA-Z0-9_-]+',values[key]): raise SystemExit('Invalid '+key)
from urllib.parse import quote
unquote=lambda s:s[1:-1] if len(s)>1 and s[0]==s[-1] and s[0] in '\"\'' else s
if not values.get('REDIS_URL'): setval('REDIS_URL','redis://:'+quote(unquote(values['REDIS_PASSWORD']),safe='')+'@redis:6379/0')
if not values.get('DATABASE_URL'): setval('DATABASE_URL','postgresql://'+values['POSTGRES_USER']+':'+quote(unquote(values['POSTGRES_PASSWORD']),safe='')+'@postgres:5432/'+values['POSTGRES_DB'])
seen=set();out=[]
for line in lines:
    m=re.match(r'^([A-Z][A-Z0-9_]*)=',line)
    if m: out.append(m[1]+'='+values[m[1]]);seen.add(m[1])
    else: out.append(line)
for key,value in values.items():
    if key not in seen: out.append(key+'='+value)
fd,name=tempfile.mkstemp(prefix='.env-',dir='.')
with os.fdopen(fd,'w') as f: f.write('\n'.join(out)+'\n')
os.chmod(name,0o600);os.replace(name,p)
PY
}

env_value() { python3 - "$1" <<'PY'
import sys
for line in open('.env'):
    if line.startswith(sys.argv[1]+'='): print(line.rstrip('\n').split('=',1)[1].strip('\"\''));break
PY
}
set_value() { python3 - "$1" "$2" <<'PY'
import sys,pathlib,os,tempfile
p=pathlib.Path('.env');key,value=sys.argv[1:];lines=p.read_text().splitlines();found=False;out=[]
for line in lines:
    if line.startswith(key+'='): out.append(key+'='+value);found=True
    else: out.append(line)
if not found: out.append(key+'='+value)
fd,name=tempfile.mkstemp(prefix='.env-',dir='.')
with os.fdopen(fd,'w') as f:f.write('\n'.join(out)+'\n')
os.chmod(name,0o600);os.replace(name,p)
PY
}
compose() { "${DOCKER[@]}" compose --env-file .env "$@"; }
service_health() {
  local id
  id=$(compose ps -aq "$1")
  [[ -n "$id" ]] || { echo missing; return; }
  "${DOCKER[@]}" inspect --format '{{if eq .State.Status "running"}}{{if .State.Health}}{{.State.Health.Status}}{{else}}missing-healthcheck{{end}}{{else}}{{.State.Status}}{{end}}' "$id"
}
wait_for_health() {
  local until_time=$((SECONDS+HEALTH_WAIT_SECONDS)) all svc
  while (( SECONDS <= until_time )); do
    all=1
    for svc in "${SERVICES[@]}"; do [[ $(service_health "$svc") == healthy ]] || all=0; done
    (( all == 0 )) || return 0
    sleep 2
  done
  return 1
}
verify_ingress() {
  local domain until_time=$((SECONDS+HEALTH_WAIT_SECONDS))
  domain=$(env_value CADDY_DOMAIN)
  while (( SECONDS <= until_time )); do
    if curl -fsS --max-time 5 "http://127.0.0.1:$(env_value HUB_BIND_PORT)/api/health" 2>/dev/null | python3 -c 'import json,sys;assert json.load(sys.stdin)["ok"] is True' 2>/dev/null; then
      if [[ -n "$domain" ]]; then
        if curl -fsS --max-time 5 --resolve "$domain:$(env_value HTTPS_PORT):127.0.0.1" "https://$domain:$(env_value HTTPS_PORT)/api/health" 2>/dev/null | python3 -c 'import json,sys;assert json.load(sys.stdin)["ok"] is True' 2>/dev/null; then return 0; fi
      elif curl -fsS --max-time 5 "http://127.0.0.1:$(env_value HTTP_PORT)/api/health" 2>/dev/null | python3 -c 'import json,sys;assert json.load(sys.stdin)["ok"] is True' 2>/dev/null; then return 0; fi
    fi
    sleep 2
  done
  log 'Ingress failed: check Caddy logs, domain DNS and inbound 80/443. TLS is not bypassed.'
  return 1
}
redact() { python3 -c 'import sys,re;from pathlib import Path
s=sys.stdin.read()
for line in Path(".env").read_text().splitlines():
 k,sep,v=line.partition("=")
 if sep and re.search("PASSWORD|TOKEN|KEY|SECRET|PASSPHRASE|DATABASE_URL|REDIS_URL",k) and len(v)>3:s=s.replace(v,"[redacted]").replace(v.strip(chr(34)+chr(39)),"[redacted]")
s=re.sub(r"(Bearer\s+)[^\s\"\x27]+",r"\1[redacted]",s,flags=re.I)
print(s,end="")'; }
heal_service() {
  local svc="$1" text="$2" id oom
  id=$(compose ps -aq "$svc")
  oom=false
  if [[ -n "$id" ]]; then oom=$("${DOCKER[@]}" inspect --format '{{.State.OOMKilled}}' "$id"); fi
  if [[ "$svc" == hub && "$oom" == true ]]; then
    [[ $(env_value NODE_OPTIONS) != --max-old-space-size=256 ]] || return 1
    set_value NODE_OPTIONS --max-old-space-size=256
    set_value VF_MAX_CONCURRENCY 1
    log 'Hub OOM: lower heap and concurrency within the existing container cap.'
    return 0
  fi
  if [[ "$svc" == hub && "$text" =~ (EACCES|SQLITE_READONLY|readonly\ database) ]]; then
    compose run --rm --no-deps --user root --entrypoint sh hub -c 'chown -R node:node /app/server/data && chmod 700 /app/server/data'
    return 0
  fi
  if [[ "$text" =~ (no\ space\ left|ENOSPC) ]]; then
    "${DOCKER[@]}" system prune -f
    "${DOCKER[@]}" builder prune -f --filter until=24h
    return 0
  fi
  if [[ "$text" =~ (connection\ refused|ECONNREFUSED|temporary\ failure|TLS\ handshake\ timeout|i/o\ timeout) ]]; then
    compose restart "$svc" || true
    return 0
  fi
  return 1
}
main() {
  [[ "$MAX_HEAL_ATTEMPTS" =~ ^[1-8]$ ]] || die 'VF_DEPLOY_ATTEMPTS must be 1..8.'
  [[ "$HEALTH_WAIT_SECONDS" =~ ^[0-9]+$ ]] && (( HEALTH_WAIT_SECONDS >= 10 && HEALTH_WAIT_SECONDS <= 180 )) || die 'Health window must be 10..180 seconds.'
  ensure_tools
  exec 9>.deploy.lock
  flock -n 9 || die 'Another deployment is already running.'
  provision_env
  compose config -q
  log 'Validate Caddy configuration before starting the stack.'
  compose run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
  log 'Reclaim unused Docker containers/images/cache; preserve all volumes.'
  "${DOCKER[@]}" system prune -f
  mkdir -p .deploy-diagnostics
  chmod 700 .deploy-diagnostics
  local attempt svc output healed build_ok status
  for ((attempt=1;attempt<=MAX_HEAL_ATTEMPTS;attempt++)); do
    log "Build/start attempt $attempt/$MAX_HEAL_ATTEMPTS"
    find .deploy-diagnostics -maxdepth 1 -name "build.*" -type f -printf "%T@ %p\n" | sort -rn | tail -n +5 | cut -d " " -f2- | xargs -r rm -f --
    output=$(mktemp .deploy-diagnostics/build.XXXXXX)
    build_ok=1
    compose up -d --build >"$output" 2>&1 || build_ok=0
    redact <"$output" >"$output.safe"
    mv "$output.safe" "$output"
    if (( build_ok == 1 )) && wait_for_health && verify_ingress; then
      local domain
      domain=$(env_value CADDY_DOMAIN)
      if [[ -n "$domain" ]]; then
        log "Healthy; HTTPS verified at https://$domain"
      else
        log 'Healthy in HTTP mode. Set CADDY_DOMAIN to enable public automatic HTTPS.'
      fi
      compose ps
      log 'Admin password remains in mode-600 .env. Container health does not certify LLM access or project completion.'
      return 0
    fi
    tail -30 "$output"
    compose logs --no-color --tail 100 caddy 2>&1 | redact >.deploy-diagnostics/caddy.log
    healed=0
    if (( build_ok == 0 )); then
      if heal_service hub "$(cat "$output")"; then healed=1; fi
    fi
    for svc in "${SERVICES[@]}"; do
      status=$(service_health "$svc")
      [[ "$status" != healthy ]] || continue
      compose logs --no-color --tail 100 "$svc" 2>&1 | redact >".deploy-diagnostics/$svc.log"
      log "$svc: $status"
      tail -15 ".deploy-diagnostics/$svc.log"
      if heal_service "$svc" "$(cat ".deploy-diagnostics/$svc.log")"; then healed=1; fi
    done
    (( healed == 1 )) || die 'No safe repair applies. Inspect .deploy-diagnostics; data and configuration are preserved.'
    compose up -d --build --force-recreate
  done
  die 'Health recovery exhausted; no success is claimed. Inspect .deploy-diagnostics.'
}
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
