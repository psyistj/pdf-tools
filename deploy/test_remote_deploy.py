#!/usr/bin/env python3
"""Unit tests for the hub gateway domain-composition logic (no server access needed)."""
import importlib.util
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

spec = importlib.util.spec_from_file_location('remote_deploy', Path(__file__).with_name('remote-deploy.py'))
remote_deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(remote_deploy)

HUB = """# Include inside http {} in /etc/nginx/novelco-gateway.conf.
server {
    listen 80;
    server_name hub.plustech.cc tibo.help;
    include /etc/nginx/pagerouter-legacy.conf;
    location / {
        return 308 https://hub.plustech.cc$request_uri;
    }
}

server {
    listen 127.0.0.1:8443 ssl proxy_protocol;
    server_name hub.plustech.cc;
    root /srv/novelco/current;
    index index.html;

    include /etc/nginx/tool-qr.locations.conf;
    include /etc/nginx/id-photo.locations.conf;
    include /etc/nginx/pagerouter-legacy.conf;
    location / {
        root /srv/pagerouter/current/hub;
        try_files $uri $uri/ =404;
    }
}
"""


class ComposeDomainTest(unittest.TestCase):
    def test_inserts_include_before_legacy_and_keeps_existing_routes(self):
        result = remote_deploy.compose_domain(HUB)
        https_start = result.index('listen 127.0.0.1:8443')
        https = result[https_start:]
        pdf_at = https.index('pdf-tools.locations.conf')
        photo_at = https.index('id-photo.locations.conf')
        legacy_at = https.index('pagerouter-legacy.conf')
        self.assertLess(photo_at, pdf_at)
        self.assertLess(pdf_at, legacy_at)
        self.assertLess(pdf_at, https.index('location /'))
        http_block = result[:https_start]
        self.assertNotIn('pdf-tools.locations.conf', http_block)
        self.assertIn('id-photo.locations.conf', https)

    def test_is_idempotent(self):
        once = remote_deploy.compose_domain(HUB)
        self.assertEqual(remote_deploy.compose_domain(once), once)

    def test_rejects_unknown_layout_without_hub_listener(self):
        with self.assertRaises(ValueError):
            remote_deploy.compose_domain(HUB.replace('    listen 127.0.0.1:8443 ssl proxy_protocol;\n', ''))

    def test_rejects_duplicate_hub_listener(self):
        duplicated = HUB.replace(
            '    listen 127.0.0.1:8443 ssl proxy_protocol;\n',
            '    listen 127.0.0.1:8443 ssl proxy_protocol;\n    listen 127.0.0.1:8443 ssl proxy_protocol;\n')
        with self.assertRaises(ValueError):
            remote_deploy.compose_domain(duplicated)

    def test_rejects_block_without_hub_server_name(self):
        with self.assertRaises(ValueError):
            remote_deploy.compose_domain(HUB.replace('    server_name hub.plustech.cc;\n', '    server_name other.example;\n'))

    def test_rejects_https_block_without_legacy_anchor(self):
        broken = HUB.replace(
            '    include /etc/nginx/pagerouter-legacy.conf;\n    location / {\n        root /srv/pagerouter/current/hub;\n',
            '    location / {\n        root /srv/pagerouter/current/hub;\n',
        )
        with self.assertRaises(ValueError):
            remote_deploy.compose_domain(broken)


class RouteConfigTest(unittest.TestCase):
    def test_route_config_is_local_and_allows_the_pdfjs_worker(self):
        text = Path(__file__).with_name('nginx-location.conf').read_text()
        self.assertIn('alias /srv/pdf-tools/current/;', text)
        self.assertIn('location = /pdf-tools {', text)
        self.assertIn('location ^~ /pdf-tools/', text)
        self.assertIn('Cache-Control "no-cache"', text)
        self.assertIn("worker-src 'self' blob:", text)
        self.assertIn("script-src 'self' 'wasm-unsafe-eval'", text)
        self.assertIn("connect-src 'self'", text)
        self.assertIn('application/javascript js mjs', text)
        self.assertNotIn('http://', text)
        self.assertNotIn('https://', text)
        self.assertNotRegex(text, r'(cdn|unpkg|jsdelivr|googleapis)')


if __name__ == '__main__':
    unittest.main()
