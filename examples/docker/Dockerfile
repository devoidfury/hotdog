FROM ubuntu:24.04 AS base

# pin the version here if you want.
# note: latest is a rolling target and will change on rebuilds
# ENV BUN_VERSION=1.3.14
ENV BUN_VERSION=latest

ENV HOTDOG_INSTALL_DIR=/opt/hotdog
ENV HOTDOG_CONFIG_DIR=/etc/hotdog

# Use bash for the shell
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Install some useful tools like fd, rg, jq, git, curl, archive tools, and
# python which a number of models like to use for one-off tooling and testing.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update -y && apt-get upgrade -y && \
    apt-get install \
        fd-find ripgrep jq \
        git curl tar wget zstd bzip2 unzip xxd \
        python3 -y

# The fd tool should be named fd but ubuntu renamed it fdfind; alias it back
RUN ln -s /usr/bin/fdfind /usr/local/bin/fd

# install bun -- copy the script first, then run it
COPY ./examples/docker/bun-install.sh /tmp/bun-install.sh
RUN chmod +x /tmp/bun-install.sh && /tmp/bun-install.sh $BUN_VERSION

# hotdog install -- copy the repo (excluding config) to the install dir
# you could alternatively pull it right off the grill with:
# RUN git clone https://github.com/devoidfury/hotdog.git $HOTDOG_INSTALL_DIR
COPY --exclude=config . $HOTDOG_INSTALL_DIR

ENV PATH="$HOTDOG_INSTALL_DIR/bin:$PATH"

# copy config to the system config directory
COPY ./config $HOTDOG_CONFIG_DIR

# run hotdog by default, but allow overriding (e.g. docker run hotdog --help)
ENTRYPOINT ["hotdog"]
CMD ["/bin/bash"]
