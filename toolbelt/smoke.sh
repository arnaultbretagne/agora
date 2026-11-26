#!/bin/bash
# The toolbelt tried as a sandbox runs it: uid 10001, read-only root, no capability, HOME and /tmp on tmpfs.
#   toolbelt/smoke.sh <image>   runs this script inside <image> (agora-toolbelt, or a harness built on it)
# Docker's --tmpfs is noexec unless told otherwise; a sandbox's HOME and /tmp are not, hence `exec`.
set -euo pipefail

if [ "${1:-}" != --inside ]; then
  image=${1:?usage: toolbelt/smoke.sh <image>}
  exec docker run --rm --user 10001:10001 --read-only --cap-drop ALL \
    --tmpfs /home/harness:uid=10001,gid=10001,exec --tmpfs /tmp:exec \
    -e HOME=/home/harness -v "$(cd "$(dirname "$0")" && pwd)/smoke.sh:/opt/smoke.sh:ro" \
    --entrypoint bash "$image" /opt/smoke.sh --inside
fi

step() { printf '\n== %s\n' "$*"; }
fail() { printf 'FAILED: %s\n' "$*" >&2; exit 1; }

step "the sandbox: uid 10001, read-only root, writable HOME and /tmp"
test "$(id -u):$(id -g)" = 10001:10001 || fail "runs as $(id -u):$(id -g)"
if touch /usr/local/smoke 2>/dev/null; then fail "the root is writable"; fi
touch "$HOME/.smoke" /tmp/.smoke

step "the core and k8s CLIs"
rg --version | head -1
fd --version
fdfind --version
jq --version
curl --version | head -1
shellcheck --version | sed -n 2p
git lfs version
sqlite3 --version
psql --version
kubectl version --client
yq --version
kustomize version
kubeconform -v
test "$(echo '{"a":[1,2]}' | jq -c '.a')" = '[1,2]' || fail jq
test "$(printf 'a:\n  b: 3\n' | yq '.a.b')" = 3 || fail yq
test "$(sqlite3 :memory: 'select 6*7')" = 42 || fail sqlite3
printf '#!/bin/sh\necho "ok"\n' | shellcheck - || fail shellcheck
mkdir -p /tmp/k && printf 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: smoke\n' > /tmp/k/cm.yaml \
  && printf 'resources: [cm.yaml]\nnamePrefix: agora-\n' > /tmp/k/kustomization.yaml
kustomize build /tmp/k | grep -q 'name: agora-smoke' || fail kustomize
mkdir -p /tmp/rg && echo needle > /tmp/rg/hay.txt
test "$(rg -l needle /tmp/rg)" = /tmp/rg/hay.txt || fail rg
test "$(fd hay /tmp/rg)" = /tmp/rg/hay.txt || fail fd

step "Python 3.13, uv, ruff"
python3 --version | grep -Eq '^Python 3\.13\.[0-9]+$' || fail "python3 is $(python3 --version)"
python3 -c 'import ssl, sqlite3, venv; print(ssl.OPENSSL_VERSION)'
uv --version
uvx --version
ruff --version
mkdir -p /tmp/py && printf 'import os\n\n\nprint(os.sep)\n' > /tmp/py/ok.py
(cd /tmp/py && ruff check ok.py && ruff format --check ok.py)
uv venv --quiet /tmp/py/venv && /tmp/py/venv/bin/python -c 'import sys; assert sys.version_info[:2] == (3, 13)'

step "Rust: a binary compiled, linked and run in /tmp, RUSTUP_HOME read-only, CARGO_HOME under HOME"
rustc --version
cargo --version
cargo clippy --version
rustfmt --version
test "$CARGO_HOME" = /home/harness/.cargo || fail "CARGO_HOME is $CARGO_HOME"
if touch "$RUSTUP_HOME/smoke" 2>/dev/null; then fail "RUSTUP_HOME is writable"; fi
mkdir -p /tmp/hello/src
printf '[package]\nname = "hello"\nversion = "0.1.0"\nedition = "2021"\n' > /tmp/hello/Cargo.toml
printf 'fn main() {\n    println!("hello from {}", "rust");\n}\n' > /tmp/hello/src/main.rs
(cd /tmp/hello && cargo fmt --check && cargo clippy --offline --quiet -- -D warnings && cargo build --offline --quiet)
test "$(/tmp/hello/target/debug/hello)" = 'hello from rust' || fail "the Rust binary"
test -d "$CARGO_HOME" || fail "cargo wrote nothing under CARGO_HOME"
printf 'int main(void) { return 0; }\n' > /tmp/c.c && cc -o /tmp/c /tmp/c.c && /tmp/c

step "PostgreSQL 17, started and stopped as uid 10001 in /tmp"
initdb --version
initdb -D /tmp/pg/data -U postgres --auth=trust -E UTF8 --locale=C > /tmp/pg-initdb.log
pg_ctl -D /tmp/pg/data -l /tmp/pg/log -o "-k /tmp/pg -c listen_addresses=127.0.0.1 -p 5432" -w start
version=$(psql -h 127.0.0.1 -p 5432 -U postgres -Atc 'show server_version_num')
echo "server_version_num $version"
[ "$version" -ge 170000 ] || fail "server_version_num $version"
test "$(psql -h /tmp/pg -p 5432 -U postgres -Atc 'select 1')" = 1 || fail "psql over the socket"
pg_ctl -D /tmp/pg/data -m fast -w stop
if pg_ctl -D /tmp/pg/data status > /dev/null; then fail "still running"; fi

step "NSS: certutil creates ~/.pki/nssdb and trusts a test root"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1 -subj '/CN=Agora smoke CA' \
  -addext basicConstraints=critical,CA:TRUE -keyout /tmp/ca-key.pem -out /tmp/ca.pem 2> /dev/null
mkdir -p "$HOME/.pki/nssdb"
certutil -N -d "sql:$HOME/.pki/nssdb" --empty-password
certutil -A -d "sql:$HOME/.pki/nssdb" -n 'Agora smoke CA' -t C,, -i /tmp/ca.pem
certutil -L -d "sql:$HOME/.pki/nssdb" | tee /tmp/nss.txt
grep -Eq '^Agora smoke CA +C,, *$' /tmp/nss.txt || fail "the root is not listed"

step "agent-browser: the baked Chromium on a local page, a snapshot and a screenshot"
"$AGENT_BROWSER_EXECUTABLE_PATH" --version
test -x "$PLAYWRIGHT_BROWSERS_PATH"/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell || fail "no headless shell"
agent-browser --version
mkdir -p /tmp/page && printf '<!doctype html><title>smoke</title><h1>Agora toolbelt smoke</h1>\n' > /tmp/page/index.html
python3 -m http.server 8765 --bind 127.0.0.1 --directory /tmp/page > /tmp/http.log 2>&1 &
server=$!
for _ in $(seq 1 50); do curl -fsS -o /dev/null http://127.0.0.1:8765/ && break; sleep 0.2; done
timeout 120 agent-browser open http://127.0.0.1:8765/
timeout 60 agent-browser snapshot | tee /tmp/snapshot.txt
grep -q 'Agora toolbelt smoke' /tmp/snapshot.txt || fail "the snapshot lacks the page's text"
timeout 60 agent-browser screenshot /tmp/shot.png
test -s /tmp/shot.png || fail "no screenshot"
file /tmp/shot.png | grep -q 'PNG image data' || fail "the screenshot is no PNG: $(file /tmp/shot.png)"
timeout 60 agent-browser close
kill "$server"

step "what the agent installs: ~/.local/bin first on PATH"
mkdir -p "$HOME/.local/bin"
printf '#!/bin/sh\necho user-space\n' > "$HOME/.local/bin/agora-smoke" && chmod 755 "$HOME/.local/bin/agora-smoke"
test "$(command -v agora-smoke)" = /home/harness/.local/bin/agora-smoke || fail "not on PATH"
test "$(agora-smoke)" = user-space || fail "does not run"
test "$NPM_CONFIG_PREFIX" = /home/harness/.local && test "$UV_TOOL_BIN_DIR" = /home/harness/.local/bin

printf '\nThe toolbelt holds.\n'
