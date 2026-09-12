#!/usr/bin/env bash
set -euo pipefail

cd /app
NAPCAT_TOKEN=${NAPCAT_TOKEN:-}
if [[ "$NAPCAT_TOKEN" == 'replace-with-a-random-64-character-hex-token' \
  || ${#NAPCAT_TOKEN} -lt 32 || "$NAPCAT_TOKEN" =~ [[:space:]] ]]; then
  echo "NAPCAT_TOKEN must contain at least 32 non-whitespace characters" >&2
  exit 1
fi
export WEBUI_TOKEN="$NAPCAT_TOKEN"

# WSL uses a pipe-based crash handler that ignores RLIMIT_CORE and can write
# tens of GiB for QQ. Run QQ as non-dumpable so the handler is never invoked.
qq_launcher='gosu napcat /opt/QQ/qq'
protected_launcher='gosu napcat env LD_PRELOAD=/usr/local/lib/no-core-dump.so /opt/QQ/qq'
if ! grep -Fq "$protected_launcher" /app/entrypoint.sh; then
  launcher_count=$(grep -Fc "$qq_launcher" /app/entrypoint.sh || true)
  if [[ "$launcher_count" -ne 2 ]]; then
    echo "NapCat QQ launcher marker not found; selected image is incompatible" >&2
    exit 1
  fi
  sed -i "s|$qq_launcher|$protected_launcher|g" /app/entrypoint.sh
fi

if [[ ! -f /app/napcat/napcat.mjs ]]; then
  unzip -q /app/NapCat.Shell.zip -d /app/NapCat.Shell
  cp -rf /app/NapCat.Shell/* /app/napcat/
  rm -rf /app/NapCat.Shell
fi

rm -rf /app/napcat/plugins/qq-miniapp-openauth
mkdir -p /app/napcat/plugins
cp -a /opt/qq-farm-bot/qq-miniapp-openauth /app/napcat/plugins/

if ! grep -Fq '"qq-miniapp-openauth"' /app/napcat/napcat.mjs; then
  grep -Fq '"napcat-plugin-qce"' /app/napcat/napcat.mjs || {
    echo "NapCat plugin whitelist marker not found; selected image is incompatible" >&2
    exit 1
  }
  sed -i '0,/"napcat-plugin-qce"/s//"napcat-plugin-qce",\n  "qq-miniapp-openauth"/' /app/napcat/napcat.mjs
fi

plugin_config=/app/napcat/config/plugins/qq-miniapp-openauth/config.json
mkdir -p "$(dirname "$plugin_config")"

jq -n --arg token "$NAPCAT_TOKEN" '{token: $token}' > "$plugin_config.tmp"
mv "$plugin_config.tmp" "$plugin_config"
chmod 600 "$plugin_config"

plugins_config=/app/napcat/config/plugins.json
if [[ -s "$plugins_config" ]] && jq empty "$plugins_config" 2>/dev/null; then
  jq '. + {"qq-miniapp-openauth": true}' "$plugins_config" > "$plugins_config.tmp"
else
  jq -n '{"qq-miniapp-openauth": true}' > "$plugins_config.tmp"
fi
mv "$plugins_config.tmp" "$plugins_config"

exec bash /app/entrypoint.sh "$@"
