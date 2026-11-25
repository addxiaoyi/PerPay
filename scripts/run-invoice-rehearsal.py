"""Run an invoice upgrade rehearsal inside a private server directory and network namespace."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile

ROOT = Path('/root/perpay-invoice-rehearsal-20261121-e')
SHA256 = '236c7ff130451ef952f99eab1f2b5f90fb01a5593c90783dbfe6025c4e8403a9'


def run():
    os.umask(0o077)
    archive = ROOT / 'code.tar.gz'
    if hashlib.sha256(archive.read_bytes()).hexdigest() != SHA256:
        raise RuntimeError('candidate archive hash mismatch')
    pid = subprocess.check_output(['systemctl', 'show', 'perpay-candidate.service', '--property=MainPID', '--value'], universal_newlines=True).strip()
    if not pid.isdigit() or pid == '0':
        raise RuntimeError('production service unavailable')
    previous = Path(os.readlink('/proc/' + pid + '/cwd'))
    node = os.readlink('/proc/' + pid + '/exe')
    target = ROOT / 'app'
    target.mkdir(mode=0o700)
    with tarfile.open(str(archive)) as bundle:
        for member in bundle.getmembers():
            name = member.name.replace('\\', '/')
            if not (member.isfile() or member.isdir()) or name.split('/')[0] not in ['src', 'dist', 'web-dist', 'static', 'scripts', 'package.json', 'package-lock.json']:
                raise RuntimeError('unexpected archive member')
            if not os.path.realpath(str(target / name)).startswith(str(target) + '/'):
                raise RuntimeError('archive escaped rehearsal')
            member.mode = 0o700 if member.isdir() else 0o600
        bundle.extractall(str(target))
    old = json.loads((previous / 'package-lock.json').read_text())
    new = json.loads((target / 'package-lock.json').read_text())
    if old['packages']['']['dependencies'] != new['packages']['']['dependencies']:
        raise RuntimeError('candidate runtime dependencies changed')
    runtime_packages = {name: entry for name, entry in new['packages'].items() if name and not entry.get('dev', False)}
    for name, entry in runtime_packages.items():
        prior = old['packages'].get(name)
        if not prior or any(prior.get(field) != entry.get(field) for field in ['version', 'integrity', 'dependencies', 'optionalDependencies', 'os', 'cpu']):
            raise RuntimeError('candidate runtime package differs: ' + name)
    (ROOT / 'dependency-verification.json').write_text(json.dumps({'runtimePackagesMatched': len(runtime_packages), 'devDependenciesUsed': False, 'registryUrlDifferencesIgnored': True}))
    os.symlink(str(previous / 'node_modules'), str(target / 'node_modules'))
    subprocess.check_call(['ip', 'link', 'set', 'lo', 'up'])
    subprocess.check_call([node, '--experimental-strip-types', 'scripts/rehearse-invoice-upgrade.mjs', pid, str(previous), str(ROOT)], cwd=str(target))
    after = subprocess.check_output(['systemctl', 'show', 'perpay-candidate.service', '--property=MainPID', '--value'], universal_newlines=True).strip()
    report = {'productionPidUnchanged': pid == after, 'productionCwdUnchanged': os.readlink('/proc/' + after + '/cwd') == str(previous), 'archiveSha256': SHA256}
    (ROOT / 'production-unchanged.json').write_text(json.dumps(report))
    print(json.dumps(report))


if __name__ == '__main__':
    run()
