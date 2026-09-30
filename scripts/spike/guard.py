"""Prove mutation probes reached the intended disposable native owner."""
import json
import urllib.parse
import urllib.request
from pathlib import Path

MARKER = 'agent-interface-disposable-spike'

def verify_home(home):
    home = Path(home)
    if not home.is_absolute() or not (home / '.agent-interface-isolated').is_file() or (home / '.agent-interface-isolated').read_text() != MARKER:
        raise SystemExit('Mutation probe requires a marked disposable home.')
    return home.resolve()

def verify_url(url):
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or parsed.username or parsed.password or not parsed.port:
        raise SystemExit('Mutation probe requires a plain loopback HTTP URL without user information.')

def verify_target(home, url, token):
    expected = verify_home(home)
    verify_url(url)
    request = urllib.request.Request(url.rstrip('/') + '/api/profiles', headers={'X-Hermes-Session-Token':token})
    profiles = json.loads(urllib.request.urlopen(request, timeout=10).read())['profiles']
    default = next((row for row in profiles if row['name']=='default'), None)
    if not default or Path(default['path']).resolve() != expected:
        raise SystemExit('The native owner home differs from the marked disposable home; no mutation permitted.')
