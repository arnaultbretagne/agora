# The toolbelt: the shared base image of the real harnesses (claude-code, codex, opencode, antigravity), what an
# agent's sandbox carries besides its harness. Built from the repository root, then given to each harness:
#   docker build -t agora-toolbelt -f toolbelt/Dockerfile .
#   docker build --build-arg TOOLBELT_IMAGE=agora-toolbelt -f harnesses/claude-code/Dockerfile .
# A sandbox's root is read-only, its HOME and /tmp are scratch, it runs as 10001:10001 with no capability: what
# is installed here is installed for good, what the agent installs goes under HOME (README.md here).
# Every file fetched from outside Debian's and PGDG's signed archives is pinned and checked against its sha256.

# Archives are fetched and unpacked here: none of them stays in a layer of the image.
FROM node:24-bookworm-slim AS fetch
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates unzip xz-utils \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /fetch

# Small static CLIs: yq, kustomize, kubeconform, uv and uvx, ruff; the digests GitHub's releases give.
ADD --checksum=sha256:129534601871538efe0ba4c5e62a34fb1d5f469bcb975c4fddeb467d82974973 \
    https://github.com/mikefarah/yq/releases/download/v4.54.3/yq_linux_amd64 yq
ADD --checksum=sha256:cb9e31198d3f63b44848bd0afc4c8efc56e6cfef9c93a4a39a211940e6decd61 \
    https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize/v5.8.3/kustomize_v5.8.3_linux_amd64.tar.gz kustomize.tar.gz
ADD --checksum=sha256:9bc2bffbf71f261128533edaf912153948b7ff238f9a531ae6d34466ec287883 \
    https://github.com/yannh/kubeconform/releases/download/v0.8.0/kubeconform-linux-amd64.tar.gz kubeconform.tar.gz
ADD --checksum=sha256:bf65ac1a0af10f92c522d91ac096c7c0a39657647b155577e7836c2cbbb4526c \
    https://github.com/astral-sh/uv/releases/download/0.13.10/uv-x86_64-unknown-linux-gnu.tar.gz uv.tar.gz
ADD --checksum=sha256:94b33791f48cd54ab35ad673a443a5c001d3e6d87effeaba9899070b700d45f3 \
    https://github.com/astral-sh/ruff/releases/download/0.17.6/ruff-x86_64-unknown-linux-gnu.tar.gz ruff.tar.gz
RUN mkdir -p /out/bin \
    && install -m 755 yq /out/bin/yq \
    && tar -xzf kustomize.tar.gz -C /out/bin kustomize \
    && tar -xzf kubeconform.tar.gz -C /out/bin kubeconform \
    && tar -xzf uv.tar.gz --strip-components=1 -C /out/bin uv-x86_64-unknown-linux-gnu/uv uv-x86_64-unknown-linux-gnu/uvx \
    && tar -xzf ruff.tar.gz --strip-components=1 -C /out/bin ruff-x86_64-unknown-linux-gnu/ruff

# CPython 3.13 from python-build-standalone, the build uv itself installs, in /opt/python: not Debian's 3.11.
ADD --checksum=sha256:b56ceb4fc1d8f0c49b7bd4dc91cd176bad7b86a88b9fc509bae6b10b3ee36692 \
    https://github.com/astral-sh/python-build-standalone/releases/download/20261124/cpython-3.13.18%2B20261124-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz python.tar.gz
RUN tar -xzf python.tar.gz -C /opt \
    && ln -s python3 /opt/python/bin/python \
    && test "$(/opt/python/bin/python3 --version)" = 'Python 3.13.18'

# Rust 1.100.0 (stable on 2026-11-12), the minimal profile plus clippy and rustfmt: the dist's tarballs, checked
# against the xz_hash its channel manifest gives, installed in /opt/rust and linked as rustup's only toolchain.
# RUSTUP_HOME (/opt/rustup) is read-only in the sandbox; CARGO_HOME, where cargo writes, is under HOME.
ADD --checksum=sha256:b1c8cb14e30889e7e2999e6b69e62d9e9b9ffc0f4df8180564d306d9680e6c55 \
    https://static.rust-lang.org/rustup/archive/1.29.3/x86_64-unknown-linux-gnu/rustup-init rustup-init
ADD --checksum=sha256:f1d0b1dec81dab6f523cd098507763487b0d4bd7fd2c87582f154128719be03b \
    https://static.rust-lang.org/dist/2026-11-12/rustc-1.100.0-x86_64-unknown-linux-gnu.tar.xz rustc.tar.xz
ADD --checksum=sha256:4591b6486594ded52ecd6135db95bf9355bbd3ca7a380888b141528bbcf9a5d4 \
    https://static.rust-lang.org/dist/2026-11-12/rust-std-1.100.0-x86_64-unknown-linux-gnu.tar.xz rust-std.tar.xz
ADD --checksum=sha256:7e29ce07d7c6e92d1826870575ba27d57fff6cb3e754aa57d99099cb88fab35d \
    https://static.rust-lang.org/dist/2026-11-12/cargo-1.100.0-x86_64-unknown-linux-gnu.tar.xz cargo.tar.xz
ADD --checksum=sha256:0d18df3bff6c852ef8243727fed075ecb33dbf93b8ab8c138c2f45e3f270102a \
    https://static.rust-lang.org/dist/2026-11-12/clippy-1.100.0-x86_64-unknown-linux-gnu.tar.xz clippy.tar.xz
ADD --checksum=sha256:4c9389e4722b16499e5d47d89837ec84a4ef755f105ed2a84c038156064e01ab \
    https://static.rust-lang.org/dist/2026-11-12/rustfmt-1.100.0-x86_64-unknown-linux-gnu.tar.xz rustfmt.tar.xz
RUN for c in rustc rust-std cargo clippy rustfmt; do \
      mkdir "$c" && tar -xJf "$c.tar.xz" --strip-components=1 -C "$c" \
      && "./$c/install.sh" --prefix=/opt/rust --disable-ldconfig > /dev/null || exit 1; \
    done \
    && chmod 755 rustup-init \
    && RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo ./rustup-init -y --no-modify-path --profile minimal --default-toolchain none \
    && export RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo \
    && /opt/cargo/bin/rustup toolchain link toolbelt /opt/rust \
    && /opt/cargo/bin/rustup default toolbelt \
    && /opt/cargo/bin/rustc --version | grep -q '^rustc 1\.100\.0 '

# Playwright's Chromium for apps/web's playwright 1.63.0 (browsers.json: chromium and chromium-headless-shell,
# revision 1243, Chrome for Testing 153.0.8010.12), laid out as `playwright install` does under
# PLAYWRIGHT_BROWSERS_PATH, its host dependencies marked as validated: they are installed below.
ADD --checksum=sha256:8aac35011c18f6e2d10696154af89a5728ac2ddd6dc6fad24ffdf243c3fcfd5a \
    https://cdn.playwright.dev/builds/cft/153.0.8010.12/linux64/chrome-linux64.zip chrome.zip
ADD --checksum=sha256:a9da028861a0cf789ff25c2fed45f5f1aaf969ed9247835b6a7821a4f7af9d1d \
    https://cdn.playwright.dev/builds/cft/153.0.8010.12/linux64/chrome-headless-shell-linux64.zip chrome-headless-shell.zip
RUN mkdir -p /opt/ms-playwright/chromium-1243 /opt/ms-playwright/chromium_headless_shell-1243 \
    && unzip -q chrome.zip -d /opt/ms-playwright/chromium-1243 \
    && unzip -q chrome-headless-shell.zip -d /opt/ms-playwright/chromium_headless_shell-1243 \
    && test -x /opt/ms-playwright/chromium-1243/chrome-linux64/chrome \
    && test -x /opt/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell \
    && for d in /opt/ms-playwright/*-1243; do touch "$d/INSTALLATION_COMPLETE" "$d/DEPENDENCIES_VALIDATED"; done

FROM node:24-bookworm-slim
# Debian's packages: the core CLIs, the C toolchain, SQLite, NSS's certutil, and the libraries and fonts
# Chromium needs (Playwright 1.63's list for debian12-x64). PostgreSQL 17 comes from PGDG, whose signing key is
# checked against its sha256; no cluster is created: an agent starts its own, in /tmp (README.md here).
ADD --checksum=sha256:0144068502a1eddd2a0280ede10ef607d1ec592ce819940991203941564e8e76 \
    https://www.postgresql.org/media/keys/ACCC4CF8.asc /usr/share/keyrings/pgdg.asc
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && chmod 644 /usr/share/keyrings/pgdg.asc \
    && echo 'deb [signed-by=/usr/share/keyrings/pgdg.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main' \
      > /etc/apt/sources.list.d/pgdg.list \
    && mkdir -p /etc/postgresql-common/createcluster.d \
    && echo 'create_main_cluster = false' > /etc/postgresql-common/createcluster.d/agora.conf \
    && apt-get update \
    && apt-get install --yes --no-install-recommends \
      git git-lfs curl wget openssl jq ripgrep fd-find tree file less patch rsync zip unzip xz-utils bzip2 zstd \
      procps psmisc lsof bc gettext-base shellcheck \
      build-essential pkg-config \
      sqlite3 postgresql-17 postgresql-client-17 \
      libnss3-tools fontconfig fonts-liberation fonts-noto-color-emoji libfontconfig1 libfreetype6 \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 libgbm1 \
      libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 \
      libxfixes3 libxkbcommon0 libxrandr2 \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && git lfs install --system --skip-repo
# The sandbox's user, which initdb, pg_ctl and psql look up by its uid; HOME is the template's tmpfs.
RUN groupadd --gid 10001 harness \
    && useradd --uid 10001 --gid 10001 --home-dir /home/harness --no-create-home --shell /bin/bash harness
# kubectl, for kubernetes:read: the cluster through the gateway, with the bridge's kubeconfig (KUBECONFIG) and
# no credential. Within one minor of the cluster's (k0s 1.36); the release binary, checked against its sha256.
ADD --chmod=755 --checksum=sha256:33bc88a24c3b09cf55bfd59e6ca977881b61fc3f25ab65bc80c65b430248648e \
    https://dl.k8s.io/release/v1.36.5/bin/linux/amd64/kubectl /usr/local/bin/kubectl
# agent-browser 0.45.0, Vercel's browser CLI for agents, a Rust binary driving the Chromium above over CDP.
ADD --chmod=755 --checksum=sha256:5eff2baaabb337ec728e4571ccfb228ad1fb6babce529fcaf7a6062fcdec6087 \
    https://github.com/vercel-labs/agent-browser/releases/download/v0.45.0/agent-browser-linux-x64 /usr/local/bin/agent-browser
COPY --from=fetch /out/bin/ /usr/local/bin/
COPY --from=fetch /opt/python /opt/python
COPY --from=fetch /opt/rust /opt/rust
COPY --from=fetch /opt/rustup /opt/rustup
COPY --from=fetch /opt/cargo /opt/cargo
COPY --from=fetch /opt/ms-playwright /opt/ms-playwright
# What the agent installs goes under HOME, first on PATH: npm's global prefix and uv's tools in ~/.local, cargo's
# in ~/.cargo. An image built from this one installs its own global npm packages with NPM_CONFIG_PREFIX=/usr/local.
# Chromium runs without its sandbox: the sandbox has no capability and no user namespace to give it.
ENV PATH=/home/harness/.local/bin:/home/harness/.cargo/bin:/opt/cargo/bin:/opt/python/bin:/usr/lib/postgresql/17/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NPM_CONFIG_PREFIX=/home/harness/.local \
    UV_TOOL_BIN_DIR=/home/harness/.local/bin \
    RUSTUP_HOME=/opt/rustup \
    CARGO_HOME=/home/harness/.cargo \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    AGENT_BROWSER_EXECUTABLE_PATH=/opt/ms-playwright/chromium-1243/chrome-linux64/chrome \
    AGENT_BROWSER_ARGS=--no-sandbox,--disable-dev-shm-usage
# Each tool answers, HOME pointed elsewhere so that nothing is left under /home/harness in the image; the sandbox
# itself is tried by toolbelt/smoke.sh.
RUN export HOME=/tmp/check CARGO_HOME=/tmp/check/.cargo \
    && git --version && git lfs version && kubectl version --client && yq --version && kustomize version \
    && kubeconform -v && uv --version && ruff --version && python3 --version && rustc --version && cargo --version \
    && cargo clippy --version && rustfmt --version && pg_ctl --version && psql --version && sqlite3 --version \
    && command -v certutil && agent-browser --version && rg --version && fd --version && shellcheck --version \
    && rm -rf /tmp/check
