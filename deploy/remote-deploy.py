#!/usr/bin/env python3
"""Safely deploy the PDF Tools static site to the existing hub gateway, with rollback."""
import argparse
from datetime import datetime, timezone
import os
from pathlib import Path
import re
import subprocess
import tarfile
import time

INCLUDE = '    include /etc/nginx/pdf-tools.locations.conf;\n'
DOMAIN = Path('/etc/nginx/pagerouter-domain.conf')
ROUTES = Path('/etc/nginx/pdf-tools.locations.conf')
ROOT = Path('/srv/pdf-tools')
REQUIRED = (
    'index.html',
    'style.css',
    'favicon.svg',
    'src/app.js',
    'src/pdf-engine.js',
    'src/crop-model.js',
    'src/exporter.js',
    'vendor/pdfjs/pdf.min.mjs',
    'vendor/pdfjs/pdf.worker.min.mjs',
    'vendor/pdfjs/cmaps/Adobe-GB1-UCS2.bcmap',
    'vendor/pdfjs/standard_fonts/LiberationSans-Regular.ttf',
    'vendor/pdf-lib/pdf-lib.esm.min.js',
)


def compose_domain(text):
    """Insert the pdf-tools include before the hub HTTPS server's legacy include."""
    if INCLUDE.strip() in text:
        return text
    marker = '    listen 127.0.0.1:8443 ssl proxy_protocol;'
    if text.count(marker) != 1:
        raise ValueError('Expected exactly one existing hub HTTPS listener')
    start = text.index(marker)
    anchor = '    include /etc/nginx/pagerouter-legacy.conf;\n'
    end = text.find(anchor, start)
    server_end = text.find('\n}', start)
    if end < 0 or server_end < 0 or end > server_end or 'server_name hub.plustech.cc;' not in text[start:end]:
        raise ValueError('Expected the known hub domain layout; refusing to guess')
    return text[:end] + INCLUDE + text[end:]


def check(urls, attempts=8, delay=1.0):
    """Poll URLs so a slow nginx worker reload is not mistaken for a bad deploy."""
    last = None
    for _ in range(attempts):
        for url in urls:
            result = subprocess.run(
                ['curl', '--fail', '--silent', '--show-error', '--max-time', '20',
                 '--resolve', 'hub.plustech.cc:443:127.0.0.1', '--output', '/dev/null', url],
                timeout=45)
            if result.returncode != 0:
                last = url
                break
        else:
            return
        time.sleep(delay)
    raise RuntimeError(f'Smoke check failed for {last}')


def run(*args):
    subprocess.run(args, check=True, timeout=45)


def atomic_text(path, content):
    temporary = path.with_name(path.name + '.pdf-tools-new')
    temporary.write_text(content)
    temporary.chmod(0o644)
    os.replace(temporary, path)


def switch_link(target):
    temporary = ROOT / '.current-new'
    temporary.unlink(missing_ok=True)
    temporary.symlink_to(target)
    os.replace(temporary, ROOT / 'current')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--routes', type=Path, required=True)
    parser.add_argument('--release', required=True)
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('Run via sudo')
    if not re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-[a-z0-9]{7,16}', args.release):
        parser.error('Invalid release identifier')
    original = DOMAIN.read_text()
    candidate = compose_domain(original)
    route_text = args.routes.read_text()
    previous_link = os.readlink(ROOT / 'current') if (ROOT / 'current').is_symlink() else None
    previous_routes = ROUTES.read_bytes() if ROUTES.exists() else None
    release = ROOT / 'releases' / args.release
    release.mkdir(parents=True, exist_ok=False)
    backup = ROOT / 'backups' / (args.release + '-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    backup.mkdir(parents=True, mode=0o700)
    (backup / 'pagerouter-domain.conf').write_text(original)
    (backup / 'previous-release.txt').write_text(previous_link or '')
    if previous_routes is not None:
        (backup / 'pdf-tools.locations.conf').write_bytes(previous_routes)
    with tarfile.open(args.archive, 'r:gz') as archive:
        archive.extractall(release, filter='data')
    missing = [name for name in REQUIRED if not (release / name).is_file()]
    if missing:
        raise ValueError(f'Build must contain {", ".join(REQUIRED)}; missing {missing}')
    for path in [release, *release.rglob('*')]:
        if path.is_symlink():
            raise ValueError('Static release must not contain symlinks')
        path.chmod(0o755 if path.is_dir() else 0o644)
    try:
        atomic_text(ROUTES, route_text)
        atomic_text(DOMAIN, candidate)
        switch_link(str(release))
        run('/usr/sbin/nginx', '-t', '-c', '/etc/nginx/novelco-gateway.conf')
        run('systemctl', 'reload', 'nginx')
        check([
            'https://hub.plustech.cc/pdf-tools/',
            'https://hub.plustech.cc/',
            'https://hub.plustech.cc/qr/',
            'https://hub.plustech.cc/id-photo/',
            'https://hub.plustech.cc/ag/',
        ])
    except Exception:
        atomic_text(DOMAIN, original)
        if previous_routes is None:
            ROUTES.unlink(missing_ok=True)
        else:
            ROUTES.write_bytes(previous_routes)
        if previous_link:
            switch_link(previous_link)
        else:
            (ROOT / 'current').unlink(missing_ok=True)
        run('/usr/sbin/nginx', '-t', '-c', '/etc/nginx/novelco-gateway.conf')
        run('systemctl', 'reload', 'nginx')
        raise
    print('DEPLOYED', release)
    print('BACKUP', backup)


if __name__ == '__main__':
    main()
