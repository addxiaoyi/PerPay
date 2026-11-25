#!/bin/sh
set -eu
# Application transports restrict providers and pin validated public callback addresses.
candidate_uid="$(id -u perpay-candidate)"
chain=PERPAY_LIVE
for firewall in /usr/sbin/iptables /usr/sbin/ip6tables; do
  if "$firewall" -w 5 -C OUTPUT -m owner --uid-owner "$candidate_uid" -j "$chain" 2>/dev/null; then
    continue
  fi
  "$firewall" -w 5 -L "$chain" >/dev/null 2>&1 || "$firewall" -w 5 -N "$chain"
  "$firewall" -w 5 -F "$chain"
  case "$firewall" in
    */ip6tables)
      "$firewall" -w 5 -A "$chain" -d ::1/128 -j RETURN
      networks='::/128 ::ffff:0:0/96 64:ff9b::/96 100::/64 2001:db8::/32 2002::/16 fc00::/7 fe80::/10 ff00::/8'
      ;;
    *)
      "$firewall" -w 5 -A "$chain" -d 127.0.0.0/8 -j RETURN
      networks='0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4'
      ;;
  esac
  # Responses to inbound requests must reach Nginx without opening new inbound listeners.
  "$firewall" -w 5 -A "$chain" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  awk '$1=="nameserver" {print $2}' /etc/resolv.conf | while read -r resolver; do
    case "$firewall:$resolver" in
      */ip6tables:*:*) ;;
      */iptables:*.*) ;;
      *) continue ;;
    esac
    "$firewall" -w 5 -A "$chain" -p udp -d "$resolver" --dport 53 -j RETURN
    "$firewall" -w 5 -A "$chain" -p tcp -d "$resolver" --dport 53 -j RETURN
  done
  for network in $networks; do
    "$firewall" -w 5 -A "$chain" -d "$network" -j REJECT
  done
  "$firewall" -w 5 -A "$chain" -p tcp --dport 443 -j RETURN
  "$firewall" -w 5 -A "$chain" -j REJECT
  "$firewall" -w 5 -C OUTPUT -m owner --uid-owner "$candidate_uid" -j "$chain" 2>/dev/null || "$firewall" -w 5 -I OUTPUT 1 -m owner --uid-owner "$candidate_uid" -j "$chain"
  "$firewall" -w 5 -C OUTPUT -m owner --uid-owner "$candidate_uid" -j PERPAY_CANDIDATE 2>/dev/null && "$firewall" -w 5 -D OUTPUT -m owner --uid-owner "$candidate_uid" -j PERPAY_CANDIDATE || true
done
