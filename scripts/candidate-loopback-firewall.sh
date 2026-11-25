#!/bin/sh
set -eu
# This dedicated UID must not send provider requests until collection is enabled.
candidate_uid="$(id -u perpay-candidate)"
for firewall in /usr/sbin/iptables /usr/sbin/ip6tables; do
  case "$firewall" in
    */ip6tables) network='::1/128' ;;
    *) network='127.0.0.0/8' ;;
  esac
  chain=PERPAY_CANDIDATE
  "$firewall" -w 5 -L "$chain" >/dev/null 2>&1 || "$firewall" -w 5 -N "$chain"
  "$firewall" -w 5 -C "$chain" -d "$network" -j RETURN 2>/dev/null || "$firewall" -w 5 -A "$chain" -d "$network" -j RETURN
  "$firewall" -w 5 -C "$chain" -j REJECT 2>/dev/null || "$firewall" -w 5 -A "$chain" -j REJECT
  "$firewall" -w 5 -C OUTPUT -m owner --uid-owner "$candidate_uid" -j "$chain" 2>/dev/null || "$firewall" -w 5 -I OUTPUT 1 -m owner --uid-owner "$candidate_uid" -j "$chain"
done
