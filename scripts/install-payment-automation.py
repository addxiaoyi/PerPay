"""Install payment monitoring and mail delivery without changing financial switches."""
import argparse
import grp
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import re
import stat
import subprocess
import tempfile


def unit_path(value):
    path = PurePosixPath(value)
    if not path.is_absolute() or '..' in path.parts or not re.fullmatch(r'/[A-Za-z0-9._/-]+', value):
        raise ValueError('unsafe_service_path')
    return str(path)


def render_units(app_root, data_root, node, credential_file, smtp_config):
    app, data, node, credential, smtp = map(unit_path, [app_root, data_root, node, credential_file, smtp_config])
    state = '/var/lib/perpay-alerts'
    common = '''User=perpay-candidate
Group=perpay-candidate
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
ReadWritePaths=/var/lib/perpay-alerts
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
'''
    delivery = f'''[Unit]
Description=Deliver persistent StarPAY alert and recovery notifications
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
{common}ExecStart=/usr/bin/python3 /usr/local/libexec/payment_alert_delivery.py --queue {state}/delivery.json --config {smtp}
TimeoutStartSec=100
'''
    invoice = f'''[Unit]
Description=Read-only StarPAY invoice provider authorization check
After=network-online.target perpay-candidate.service

[Service]
Type=oneshot
{common}WorkingDirectory={app}
Environment=PERPAY_TAX_INVOICE_ENABLED=false
Environment=PERPAY_TAX_INVOICE_AUTO_SYNC_ENABLED=false
ExecStart={node} --experimental-strip-types {app}/scripts/check-invoice-automation.ts --database {data}/data/perpay.sqlite3 --credential-file {credential} --remote --output {state}/invoice-readiness.json
SuccessExitStatus=2
TimeoutStartSec=40
'''
    audit = f'''[Service]
ExecStart=
ExecStart=/usr/bin/python3 /usr/local/libexec/perpay-payment-alerts.py --state {state}/state.json --unit /etc/systemd/system/perpay-integrity.service --delivery-state {state}/delivery.json --invoice-readiness {state}/invoice-readiness.json
ReadWritePaths={state}
'''

    def timer(description, service, interval, boot):
        return f'''[Unit]
Description={description}

[Timer]
OnBootSec={boot}
OnUnitInactiveSec={interval}
AccuracySec=5s
Unit={service}.service

[Install]
WantedBy=timers.target
'''

    return {
        'perpay-payment-delivery.service': delivery,
        'perpay-payment-delivery.timer': timer('Retry pending StarPAY notifications', 'perpay-payment-delivery', '30s', '45s'),
        'perpay-invoice-readiness.service': invoice,
        'perpay-invoice-readiness.timer': timer('Check invoice provider authorization', 'perpay-invoice-readiness', '30min', '90s'),
        'perpay-integrity.service.d/30-automation.conf': audit,
    }


def restore_files(saved):
    for path, previous in saved.items():
        if previous is not None:
            atomic_file(path, previous)
            continue
        try:
            path.unlink()
        except FileNotFoundError:
            pass


def safe_install_target(path):
    if path.parent.resolve() != path.parent:
        raise RuntimeError('unsafe_install_parent')
    try:
        info = path.lstat()
    except FileNotFoundError:
        return
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise RuntimeError('unsafe_install_target')


def atomic_file(path, contents):
    safe_install_target(path)
    descriptor, temporary_name = tempfile.mkstemp(prefix='.' + path.name + '.', suffix='.tmp', dir=str(path.parent))
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, 'wb') as output:
            output.write(contents)
            output.flush()
            os.fsync(output.fileno())
        temporary.chmod(0o644)
        os.replace(str(temporary), str(path))
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def read_timer_states(timers):
    states = {}
    for timer in timers:
        completed = subprocess.run(['systemctl', 'show', timer, '--all', '--property=LoadState',
            '--property=UnitFileState', '--property=ActiveState'], stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, universal_newlines=True, timeout=10, check=False)
        properties = {}
        for line in completed.stdout.splitlines():
            key, separator, value = line.partition('=')
            if not separator or key in properties:
                raise RuntimeError('timer_state_unavailable')
            properties[key] = value
        if set(properties) != {'LoadState', 'UnitFileState', 'ActiveState'}:
            raise RuntimeError('timer_state_unavailable')
        present = properties['LoadState'] == 'loaded'
        if present:
            valid = (completed.returncode == 0 and properties['UnitFileState'] in ['enabled', 'disabled'] and
                     properties['ActiveState'] in ['active', 'inactive'])
        else:
            valid = (completed.returncode in [0, 1, 4] and properties['LoadState'] == 'not-found' and
                     properties['UnitFileState'] in ['', 'not-found'] and properties['ActiveState'] == 'inactive')
        if not valid:
            raise RuntimeError('timer_state_unavailable')
        states[timer] = {'present': present, 'enabled': properties['UnitFileState'] == 'enabled',
                         'active': properties['ActiveState'] == 'active'}
    return states


def restore_timer_states(states):
    for timer, previous in states.items():
        if not previous['present']:
            continue
        subprocess.run(['systemctl', 'enable' if previous['enabled'] else 'disable', timer], check=True, timeout=30)
        subprocess.run(['systemctl', 'start' if previous['active'] else 'stop', timer], check=True, timeout=30)
    if read_timer_states(states) != states:
        raise RuntimeError('timer_state_restore_failed')


def rollback_install(saved, timers):
    for timer in timers:
        subprocess.run(['systemctl', 'disable', '--now', timer], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, check=False, timeout=30)
    stopped = read_timer_states(timers)
    if any(state['enabled'] or state['active'] for state in stopped.values()):
        raise RuntimeError('timer_stop_failed')
    restore_files(saved)
    subprocess.run(['systemctl', 'daemon-reload'], check=True, timeout=30)
    restore_timer_states(timers)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ['app-root', 'data-root', 'node', 'credential-file', 'smtp-config']:
        parser.add_argument('--' + flag, required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    units = render_units(args.app_root, args.data_root, args.node, args.credential_file, args.smtp_config)
    if not args.apply:
        print(json.dumps({'ok': True, 'preview': True, 'units': units, 'financialChanges': 0}))
        return 0
    if os.geteuid() != 0:
        raise RuntimeError('installation_requires_root')
    app = Path(args.app_root)
    for file in ['scripts/perpay-payment-alerts.py', 'scripts/payment_alert_delivery.py', 'scripts/check-invoice-automation.ts',
                 'src/invoices/automation-readiness.ts']:
        if not (app / file).is_file():
            raise RuntimeError('automation_release_incomplete')
    if not Path('/etc/systemd/system/perpay-integrity.service').is_file():
        raise RuntimeError('existing_financial_monitor_required')
    services = ['perpay-payment-delivery', 'perpay-invoice-readiness']
    timers = read_timer_states([service + '.timer' for service in services])
    target = Path('/etc/systemd/system')
    script_targets = {Path('/usr/local/libexec') / name: app/'scripts'/name
                      for name in ['perpay-payment-alerts.py', 'payment_alert_delivery.py']}
    for destination in list(script_targets) + [target/name for name in units]:
        safe_install_target(destination)
    owner = pwd.getpwnam('perpay-candidate').pw_uid
    group = grp.getgrnam('perpay-candidate').gr_gid
    state = Path('/var/lib/perpay-alerts')
    state.mkdir(mode=0o700, exist_ok=True)
    info = state.lstat()
    if state.is_symlink() or not state.is_dir() or info.st_uid not in [0, owner] or info.st_mode & 0o077:
        raise RuntimeError('unsafe_alert_state_directory')
    os.chown(state, owner, group)
    subprocess.run(['runuser', '-u', 'perpay-candidate', '--', '/usr/bin/python3',
        str(app/'scripts/payment_alert_delivery.py'), '--queue', str(state/'delivery.json'),
        '--config', args.smtp_config, '--check-config'], check=True, timeout=15)
    saved = {}
    try:
        existing_timers = [timer for timer, state in timers.items() if state['present']]
        if existing_timers:
            subprocess.run(['systemctl', 'stop', *existing_timers], check=True, timeout=30)
        for destination, source in script_targets.items():
            saved[destination] = destination.read_bytes() if destination.exists() else None
            destination.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            atomic_file(destination, source.read_bytes())
        for name, contents in units.items():
            destination = target / name
            saved[destination] = destination.read_bytes() if destination.exists() else None
            destination.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            atomic_file(destination, contents.encode('utf-8'))
        subprocess.run(['systemd-analyze', 'verify', *[str(target/(service+'.service')) for service in services]], check=True, timeout=30)
        subprocess.run(['systemctl', 'daemon-reload'], check=True, timeout=30)
        subprocess.run(['systemctl', 'start', 'perpay-invoice-readiness.service'], check=True, timeout=50)
        subprocess.run(['systemctl', 'start', 'perpay-integrity.service'], check=True, timeout=30)
        subprocess.run(['systemctl', 'enable', '--now', *[service+'.timer' for service in services]], check=True, timeout=30)
    except BaseException:
        rollback_install(saved, timers)
        raise
    print(json.dumps({'ok': True, 'installed': True, 'financialChanges': 0, 'backupChanges': 0}))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
        print(json.dumps({'ok': False, 'error': 'automation_install_failed', 'financialChanges': 0}))
        raise SystemExit(1)
