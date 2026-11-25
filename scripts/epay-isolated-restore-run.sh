#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $# -ne 4 ]]; then
  echo 'usage: epay-isolated-restore-run.sh BUNDLE_DIR NODE BACKUP MAIN_STORE' >&2
  exit 2
fi
bundle=$1
node=$2
backup=$3
main_store=$4
expected=4007f403809a483c41102ac3ed7a32d915e42eccee4deb05808bbd398236b401
[[ -x "$node" && -f "$bundle/scripts/epay-historical-ledger-rehearsal.ts" && -f "$backup" && -f "$main_store" ]] || { echo 'missing rehearsal inputs' >&2; exit 1; }
[[ $(sha256sum "$backup" | cut -d' ' -f1) == "$expected" ]] || { echo 'backup hash mismatch' >&2; exit 1; }
[[ $(stat -f -c %T /dev/shm) == tmpfs ]] || { echo 'tmpfs unavailable' >&2; exit 1; }

container=''
cleanup() {
  if [[ "$container" =~ ^[a-f0-9]{64}$ ]]; then
    docker rm -f "$container" >/dev/null
  fi
}
trap cleanup EXIT
container=$(docker run -d --network none --memory 512m --memory-swap 512m --cpus 1 --pids-limit 128 \
  --label starmc.epay.audit=isolated-v1 --tmpfs /var/lib/mysql:rw,nosuid,nodev,size=768m \
  -e MYSQL_ALLOW_EMPTY_PASSWORD=yes mysql:8.4 --innodb-buffer-pool-size=64M \
  --innodb-redo-log-capacity=32M --performance-schema=OFF)
[[ "$container" =~ ^[a-f0-9]{64}$ ]] || { echo 'invalid container id' >&2; exit 1; }
for attempt in {1..90}; do
  state=$(docker inspect --format '{{.State.Status}} {{.State.OOMKilled}}' "$container")
  if [[ "$state" != "running false" ]]; then
    echo "isolated mysql stopped before readiness: $state" >&2
    exit 1
  fi
  if [[ $(docker exec "$container" cat /proc/1/comm 2>/dev/null || true) == mysqld ]] && \
     docker exec "$container" mysqladmin --protocol=socket -uroot ping --silent >/dev/null 2>&1; then break; fi
  if [[ "$attempt" == 90 ]]; then echo 'isolated mysql failed to start' >&2; exit 1; fi
  sleep 1
done
docker exec "$container" mysql --protocol=socket -uroot -e 'CREATE DATABASE epay_starmc'
gzip -cd -- "$backup" | docker exec -i "$container" mysql --protocol=socket -uroot epay_starmc
docker exec "$container" mysql --protocol=socket -uroot -e "CREATE USER 'epay_audit'@'localhost' IDENTIFIED BY ''; GRANT SELECT ON epay_starmc.* TO 'epay_audit'@'localhost'"
EPAY_ISOLATED_TEST=1 EPAY_AUDIT_CONTAINER="$container" EPAY_MAIN_STORE="$main_store" \
  "$node" --experimental-strip-types "$bundle/scripts/epay-historical-ledger-rehearsal.ts"
[[ $(sha256sum "$backup" | cut -d' ' -f1) == "$expected" ]] || { echo 'backup hash changed' >&2; exit 1; }
