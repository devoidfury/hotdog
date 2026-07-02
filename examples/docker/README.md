# Docker usage example

Build the image from the repo root:

```sh
cd path/to/hotdog
docker build -f examples/docker/Dockerfile -t hotdog .
```

## Run

Set `AI_URL` and `AI_API_KEY` for your provider (llama.cpp, llama-swap, vllm, etc):

```sh
docker run --rm -e AI_URL="$AI_URL" -e AI_API_KEY="$AI_API_KEY" hotdog
```

Mount the current directory into the container so hotdog works on your files:

```sh
docker run --rm \
  -e AI_URL="$AI_URL" \
  -e AI_API_KEY="$AI_API_KEY" \
  -v .:/workspace -w /workspace \
  hotdog
```

Pass hotdog flags by appending them after the image name:

```sh
docker run --rm \
  -e AI_URL="$AI_URL" \
  -e AI_API_KEY="$AI_API_KEY" \
  -v .:/workspace -w /workspace \
  hotdog --model qwen3.5-0.8b --profile fixer
```

## Persist config

To keep your config outside the container, mount a host directory in place of the built-in config:

```sh
docker run --rm \
  -e AI_URL="$AI_URL" \
  -e AI_API_KEY="$AI_API_KEY" \
  -e HOTDOG_CONFIG_DIR=/config \
  -v ./my-hotdog-config:/config \
  -v .:/workspace -w /workspace \
  hotdog
```
